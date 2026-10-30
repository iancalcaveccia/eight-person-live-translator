"use client";

/**
 * MediaSession owns the single LiveKit connection of this device.
 *
 * Privacy-relevant guarantees implemented here (the server enforces them too):
 *  - Exactly one Room at a time. Switching groups mutes the mic FIRST, clears
 *    mixer/captions, asks the server to move us (which evicts the old room
 *    participation), disconnects, and only then joins the new room.
 *  - We subscribe manually (autoSubscribe: false) and only to what the
 *    routing rules require: native mic for same-language speakers, the
 *    translated track otherwise — never both for one speaker.
 *  - Captions/worker events are accepted only from the agent participant /
 *    server; clients cannot publish data (token grant).
 */
import {
  AudioPresets,
  ConnectionQuality,
  DisconnectReason,
  ParticipantKind,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  type LocalAudioTrack,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";
import { ATTR, parseTranslationTrackName, TOPIC, type ControlEvent, type WorkerEvent } from "@/lib/contract";
import type { MediaTokenView } from "@/lib/api-types";
import { ClientApiError } from "../api";
import type { ListenerSettings, NoiseMode } from "../prefs";
import { CaptionStore } from "./captions";
import { looksLikeHeadset, listDevices } from "./devices";
import { LatencyTracker } from "./latency";
import { AudioMixer } from "./mixer";
import { wantsAgentTrack, wantsNativeMic, type ListenerPrefs, type SpeakerInfo } from "./routing";

export type MediaStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "switching"
  | "offline"
  | "replaced"
  | "ended"
  | "kicked"
  | "failed";

export interface RemoteHuman {
  id: string;
  name: string;
  speakLang: string;
  listenLang: string;
  esRegion: string;
  color: number;
  speaking: boolean;
  micMuted: boolean;
  micPublished: boolean;
}

export interface SessionTranslationState {
  speaker: string;
  target: string;
  provider: string;
  state: "connecting" | "live" | "delayed" | "reconnecting" | "error" | "stopped";
  backlogMs: number;
  updatedAt: number;
}

export interface MediaSnapshot {
  status: MediaStatus;
  error: string | null;
  roomName: string | null;
  groupId: string | null;
  epoch: number;
  micWanted: boolean;
  micLive: boolean;
  micPermission: "unknown" | "granted" | "denied";
  canPlayAudio: boolean;
  agentPresent: boolean;
  budgetState: "ok" | "warning" | "exceeded";
  translation: Record<string, SessionTranslationState>;
  quality: "excellent" | "good" | "poor" | "lost" | "unknown";
  lastSwitchMs: number | null;
  humans: RemoteHuman[];
  inputDeviceLabel: string | null;
  inputIsHeadset: boolean;
  notice: string | null;
  noiseFilterActive: NoiseMode;
  meSpeaking: boolean;
  /** performance.now() when the current room connected (for 'interpreter missing' detection). */
  connectedAt: number | null;
}

export interface MediaSessionOptions {
  fetchToken: () => Promise<MediaTokenView>;
  onNudge: () => void;
  listenLang: string;
}

const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];

export class MediaSession {
  readonly captions: CaptionStore;
  readonly latency = new LatencyTracker();
  readonly mixer: AudioMixer;
  readonly audioContext: AudioContext | null;

  private room: Room | null = null;
  private snapshotValue: MediaSnapshot;
  private listeners = new Set<() => void>();
  private prefs: ListenerPrefs;
  private settings: ListenerSettings | null = null;
  private switching = false;
  private destroyed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private pttReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private noiseProcessor: { destroy?: () => Promise<void> } | null = null;

  constructor(
    private readonly gatheringId: string,
    private readonly audioContainer: HTMLElement,
    private readonly opts: MediaSessionOptions,
  ) {
    this.audioContext = createAudioContext();
    this.captions = new CaptionStore(opts.listenLang);
    this.mixer = new AudioMixer(this.audioContext, audioContainer, (speakerId, kind, overlap) => {
      if (kind === "translation") this.latency.onAudible(speakerId, performance.now(), overlap);
    });
    this.prefs = { listenLang: opts.listenLang, nativePassthrough: true, originalFor: new Set() };
    this.snapshotValue = {
      status: "idle",
      error: null,
      roomName: null,
      groupId: null,
      epoch: 0,
      micWanted: false,
      micLive: false,
      micPermission: "unknown",
      canPlayAudio: true,
      agentPresent: false,
      budgetState: "ok",
      translation: {},
      quality: "unknown",
      lastSwitchMs: null,
      humans: [],
      inputDeviceLabel: null,
      inputIsHeadset: false,
      notice: null,
      noiseFilterActive: "standard",
      meSpeaking: false,
      connectedAt: null,
    };
    this.sweepTimer = setInterval(() => {
      this.captions.sweep();
      this.latency.expire(performance.now());
    }, 1000);
  }

  // ------------------------------------------------------------ observable

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = () => this.snapshotValue;

  private set(patch: Partial<MediaSnapshot>) {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    for (const l of this.listeners) l();
  }

  get currentRoom(): Room | null {
    return this.room;
  }

  // ------------------------------------------------------------ lifecycle

  async start(initial?: MediaTokenView) {
    this.set({ status: "connecting", error: null });
    try {
      const token = initial ?? (await this.opts.fetchToken());
      await this.connect(token);
    } catch (err) {
      this.handleTokenError(err);
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.mixer.destroy();
    const room = this.room;
    this.room = null;
    void room?.disconnect();
    void this.audioContext?.close().catch(() => undefined);
  }

  /**
   * Switch conversation. `move` performs the server-side move and returns a
   * token for the new group (the server evicts our old room participation).
   */
  async switchGroup(move: () => Promise<MediaTokenView>): Promise<void> {
    if (this.switching) throw new Error("Already switching");
    this.switching = true;
    const t0 = performance.now();
    const old = this.room;
    const micWasWanted = this.snapshotValue.micWanted;
    this.set({ status: "switching", error: null });
    // 1. Silence the mic before anything else: no frames reach the old group.
    await this.setLocalMicEnabled(false).catch(() => undefined);
    let token: MediaTokenView;
    try {
      token = await move();
    } catch (err) {
      // Rollback: still in the old group.
      this.switching = false;
      if (micWasWanted) await this.setLocalMicEnabled(true).catch(() => undefined);
      this.set({ status: old ? "connected" : "offline" });
      throw err;
    }
    // 2. Drop old media and private captions immediately.
    this.mixer.clear();
    this.captions.clear();
    this.latency.reset();
    this.set({ translation: {}, humans: [], agentPresent: false });
    this.room = null;
    if (old) {
      old.removeAllListeners();
      await old.disconnect().catch(() => undefined);
    }
    try {
      await this.connect(token);
      this.set({ lastSwitchMs: Math.round(performance.now() - t0) });
    } finally {
      this.switching = false;
    }
  }

  private async connect(token: MediaTokenView) {
    if (this.destroyed) return;
    const room = new Room({
      adaptiveStream: false,
      dynacast: false,
      disconnectOnPageLeave: true,
      webAudioMix: this.audioContext ? { audioContext: this.audioContext } : true,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        deviceId: this.settings?.micDeviceId ?? undefined,
      },
      publishDefaults: {
        audioPreset: AudioPresets.speech,
        dtx: true,
        red: true,
        stopMicTrackOnMute: false,
      },
    });
    this.room = room;
    this.wire(room);
    this.set({ status: "connecting", roomName: token.room, groupId: token.groupId, epoch: token.epoch });
    await room.connect(token.serverUrl, token.token, { autoSubscribe: false });
    if (this.room !== room) {
      await room.disconnect();
      return;
    }
    this.reconnectAttempt = 0;
    this.applyRouting();
    this.refreshHumans();
    this.set({ status: "connected", canPlayAudio: room.canPlaybackAudio, connectedAt: performance.now() });
    if (this.settings?.outputDeviceId) {
      await room.switchActiveDevice("audiooutput", this.settings.outputDeviceId).catch(() => undefined);
    }
    if (this.snapshotValue.micWanted && this.settings?.micMode !== "hold") {
      await this.setLocalMicEnabled(true).catch((e) => this.micError(e));
    }
  }

  private scheduleReconnect(reason: string) {
    if (this.destroyed || this.switching || this.reconnectTimer) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    this.reconnectAttempt++;
    this.set({ status: "offline", error: reason });
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.destroyed || this.switching) return;
      try {
        const token = await this.opts.fetchToken();
        this.mixer.clear();
        this.captions.clear();
        await this.connect(token);
      } catch (err) {
        if (!this.handleTokenError(err)) this.scheduleReconnect("Reconnecting…");
      }
    }, delay);
  }

  /** Returns true if the error is terminal (no retry). */
  private handleTokenError(err: unknown): boolean {
    if (err instanceof ClientApiError) {
      if (err.status === 410 || err.code === "gathering_ended") {
        this.set({ status: "ended", error: err.message });
        return true;
      }
      if (err.status === 403 && err.code === "kicked") {
        this.set({ status: "kicked", error: err.message });
        return true;
      }
      if (err.status === 401) {
        this.set({ status: "ended", error: err.message });
        return true;
      }
      if (err.code === "media_not_configured") {
        this.set({ status: "failed", error: err.message });
        return true;
      }
    }
    this.scheduleReconnect(err instanceof Error ? err.message : "Connection problem");
    return false;
  }

  // ------------------------------------------------------------ events

  private wire(room: Room) {
    room
      .on(RoomEvent.TrackPublished, () => this.applyRouting())
      .on(RoomEvent.TrackUnpublished, () => {
        this.applyRouting();
        this.refreshHumans();
      })
      .on(RoomEvent.ParticipantConnected, () => {
        this.applyRouting();
        this.refreshHumans();
      })
      .on(RoomEvent.ParticipantDisconnected, () => {
        this.applyRouting();
        this.refreshHumans();
      })
      .on(RoomEvent.ParticipantAttributesChanged, () => {
        this.applyRouting();
        this.refreshHumans();
      })
      .on(RoomEvent.TrackMuted, () => this.refreshHumans())
      .on(RoomEvent.TrackUnmuted, () => this.refreshHumans())
      .on(RoomEvent.ActiveSpeakersChanged, () => {
        this.refreshHumans();
        this.set({ meSpeaking: room.localParticipant.isSpeaking });
      })
      .on(RoomEvent.TrackSubscribed, (track, pub, participant) => this.onSubscribed(track, pub, participant))
      .on(RoomEvent.TrackUnsubscribed, (_track, pub, participant) => this.onUnsubscribed(pub, participant))
      .on(RoomEvent.AudioPlaybackStatusChanged, () => this.set({ canPlayAudio: room.canPlaybackAudio }))
      .on(RoomEvent.Reconnecting, () => this.set({ status: "reconnecting" }))
      .on(RoomEvent.SignalReconnecting, () => this.set({ status: "reconnecting" }))
      .on(RoomEvent.Reconnected, () => {
        this.set({ status: "connected", error: null });
        this.applyRouting();
      })
      .on(RoomEvent.ConnectionQualityChanged, (q, p) => {
        if (p.isLocal) this.set({ quality: qualityName(q) });
      })
      .on(RoomEvent.LocalTrackPublished, () => this.refreshMic())
      .on(RoomEvent.LocalTrackUnpublished, () => this.refreshMic())
      .on(RoomEvent.MediaDevicesChanged, () => void this.onDevicesChanged())
      .on(RoomEvent.MediaDevicesError, (e) => this.micError(e))
      .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => this.onData(payload, participant, topic))
      .on(RoomEvent.Disconnected, (reason) => this.onDisconnected(room, reason));

    room.registerTextStreamHandler(TOPIC.captions, (reader) => {
      void (async () => {
        try {
          const a = reader.info.attributes ?? {};
          const text = await reader.readAll();
          this.captions.add({
            speakerId: a.source_identity ?? "",
            kind: a.kind === "source" ? "source" : "translation",
            targetLang: a.target_lang ?? "",
            sourceLang: a.source_lang ?? "",
            seg: a.seg ?? "0",
            final: a.final === "true",
            text,
          });
        } catch {
          /* stream aborted on disconnect */
        }
      })();
    });
  }

  private onDisconnected(room: Room, reason?: DisconnectReason) {
    if (room !== this.room) return; // an old room we already left
    this.mixer.clear();
    this.set({ agentPresent: false, micLive: false });
    if (this.switching || this.destroyed) return;
    switch (reason) {
      case DisconnectReason.CLIENT_INITIATED:
        this.set({ status: "offline" });
        return;
      case DisconnectReason.DUPLICATE_IDENTITY:
        this.room = null;
        this.set({ status: "replaced", error: "This gathering was opened on another tab or device." });
        return;
      case DisconnectReason.PARTICIPANT_REMOVED:
      case DisconnectReason.ROOM_DELETED:
        // Server moved/kicked us or the conversation closed. Ask the server
        // where we belong now; it only ever mints our current group.
        this.room = null;
        this.captions.clear();
        this.opts.onNudge();
        this.reconnectAttempt = 0;
        this.scheduleReconnect("Updating your conversation…");
        return;
      default:
        this.room = null;
        this.scheduleReconnect("Connection lost. Reconnecting…");
    }
  }

  private onData(payload: Uint8Array, participant: RemoteParticipant | undefined, topic?: string) {
    let msg: unknown;
    try {
      msg = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return;
    }
    if (topic === TOPIC.control && !participant) {
      const ev = msg as ControlEvent;
      if (ev.t === "ended") {
        this.set({ status: "ended", error: "The host ended this gathering." });
        return;
      }
      this.opts.onNudge();
      return;
    }
    if (topic === TOPIC.events && participant?.kind === ParticipantKind.AGENT) {
      const ev = msg as WorkerEvent;
      const now = performance.now();
      switch (ev.t) {
        case "onset":
          this.latency.onWorkerOnset(ev.speaker, now);
          break;
        case "first_audio":
          if (ev.target === this.prefs.listenLang) this.latency.onWorkerFirstAudio(ev.speaker, ev.target, ev.latencyMs);
          break;
        case "session": {
          const key = `${ev.speaker}:${ev.target}`;
          const translation = { ...this.snapshotValue.translation };
          if (ev.state === "stopped") delete translation[key];
          else
            translation[key] = {
              speaker: ev.speaker,
              target: ev.target,
              provider: ev.provider,
              state: ev.state,
              backlogMs: ev.backlogMs ?? 0,
              updatedAt: Date.now(),
            };
          this.set({ translation });
          break;
        }
        case "budget":
          this.set({ budgetState: ev.state });
          break;
        default:
          break;
      }
    }
  }

  private onSubscribed(track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) {
    if (!(track instanceof RemoteAudioTrack)) return;
    if (participant.kind === ParticipantKind.AGENT) {
      const parsed = parseTranslationTrackName(pub.trackName);
      if (!parsed) return;
      this.mixer.add(`tx|${pub.trackSid}`, parsed.speakerId, "translation", track);
    } else {
      this.mixer.add(`mic|${pub.trackSid}`, participant.identity, "native", track);
    }
  }

  private onUnsubscribed(pub: RemoteTrackPublication, participant: RemoteParticipant) {
    const prefix = participant.kind === ParticipantKind.AGENT ? "tx" : "mic";
    this.mixer.remove(`${prefix}|${pub.trackSid}`);
  }

  // ------------------------------------------------------------ routing

  setListenerSettings(s: ListenerSettings, listenLang: string) {
    const prevNoise = this.settings?.noiseMode;
    this.settings = s;
    this.prefs = {
      listenLang,
      nativePassthrough: s.nativePassthrough,
      originalFor: new Set(s.originalFor),
    };
    this.captions.setListenLang(listenLang);
    this.mixer.setConfig({
      mode: s.mixMode,
      focusSpeakerId: s.focusSpeakerId,
      translationVolume: s.translationVolume,
      originalVolume: s.originalVolume,
      speakerVolume: s.speakerVolume,
      speakerMuted: s.speakerMuted,
    });
    this.applyRouting();
    if (prevNoise !== undefined && prevNoise !== s.noiseMode) void this.applyNoiseMode();
  }

  private applyRouting() {
    const room = this.room;
    if (!room) return;
    const speakers = new Map<string, SpeakerInfo>();
    const remotes = [...room.remoteParticipants.values()];
    for (const p of remotes) {
      if (p.kind === ParticipantKind.AGENT) continue;
      speakers.set(p.identity, { id: p.identity, speakLang: p.attributes[ATTR.speakLang] });
    }
    let agentPresent = false;
    for (const p of remotes) {
      if (p.kind === ParticipantKind.AGENT) {
        agentPresent = true;
        for (const pub of p.audioTrackPublications.values()) {
          setSubscribed(pub, wantsAgentTrack(pub.trackName, speakers, this.prefs));
        }
      } else {
        const info = speakers.get(p.identity)!;
        for (const pub of p.audioTrackPublications.values()) {
          if (pub.source !== Track.Source.Microphone) continue;
          setSubscribed(pub, wantsNativeMic(info, this.prefs));
        }
      }
    }
    if (agentPresent !== this.snapshotValue.agentPresent) this.set({ agentPresent });
  }

  private refreshHumans() {
    const room = this.room;
    if (!room) return;
    const humans: RemoteHuman[] = [];
    for (const p of room.remoteParticipants.values()) {
      if (p.kind === ParticipantKind.AGENT) continue;
      const mic = [...p.audioTrackPublications.values()].find((x) => x.source === Track.Source.Microphone);
      humans.push({
        id: p.identity,
        name: p.name || "Guest",
        speakLang: p.attributes[ATTR.speakLang] ?? "",
        listenLang: p.attributes[ATTR.listenLang] ?? "",
        esRegion: p.attributes[ATTR.esRegion] ?? "",
        color: Number(p.attributes[ATTR.color] ?? 0),
        speaking: p.isSpeaking,
        micMuted: !mic || mic.isMuted,
        micPublished: Boolean(mic),
      });
    }
    this.set({ humans });
  }

  // ------------------------------------------------------------ microphone

  async setMicWanted(on: boolean) {
    this.set({ micWanted: on });
    if (this.settings?.micMode === "hold") return; // hold-to-talk drives the mic
    await this.setLocalMicEnabled(on).catch((e) => this.micError(e));
  }

  /** Hold-to-talk fallback (last resort for very noisy rooms). */
  async pttDown() {
    if (this.pttReleaseTimer) clearTimeout(this.pttReleaseTimer);
    await this.setLocalMicEnabled(true).catch((e) => this.micError(e));
  }

  pttUp() {
    // Small tail so the last syllable is not clipped.
    this.pttReleaseTimer = setTimeout(() => void this.setLocalMicEnabled(false), 350);
  }

  private async setLocalMicEnabled(on: boolean) {
    const room = this.room;
    if (!room) return;
    await room.localParticipant.setMicrophoneEnabled(on, {
      deviceId: this.settings?.micDeviceId ?? undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    });
    if (on) {
      this.set({ micPermission: "granted" });
      await this.applyNoiseMode();
    }
    this.refreshMic();
  }

  private refreshMic() {
    const room = this.room;
    const pub = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const track = pub?.track as LocalAudioTrack | undefined;
    const label = track?.mediaStreamTrack?.label ?? null;
    this.set({
      micLive: Boolean(pub && !pub.isMuted),
      inputDeviceLabel: label,
      inputIsHeadset: looksLikeHeadset(label ?? undefined),
    });
  }

  private micError(e: unknown) {
    const name = (e as { name?: string })?.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      this.set({
        micPermission: "denied",
        micWanted: false,
        notice: "Microphone permission was denied. Allow it in your browser settings to speak.",
      });
    } else {
      this.set({ notice: "Could not start the microphone. Check that no other app is using it." });
    }
  }

  private async applyNoiseMode() {
    const room = this.room;
    const mode = this.settings?.noiseMode ?? "standard";
    const pub = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const track = pub?.track as LocalAudioTrack | undefined;
    if (!track) return;
    try {
      if (mode === "standard") {
        if (this.noiseProcessor) {
          await track.stopProcessor();
          this.noiseProcessor = null;
        }
        this.set({ noiseFilterActive: "standard" });
        return;
      }
      const krisp = await import("@livekit/krisp-noise-filter");
      if (!krisp.isKrispNoiseFilterSupported()) {
        this.set({ notice: "Enhanced noise filtering is not supported in this browser.", noiseFilterActive: "standard" });
        return;
      }
      if (this.noiseProcessor) await track.stopProcessor();
      const processor = krisp.KrispNoiseFilter({ useBVC: mode === "voice-focus" });
      await track.setProcessor(processor);
      this.noiseProcessor = processor as unknown as { destroy?: () => Promise<void> };
      this.set({ noiseFilterActive: mode });
    } catch {
      this.noiseProcessor = null;
      this.set({
        notice: "Enhanced noise filter unavailable (it needs LiveKit Cloud). Using standard filtering.",
        noiseFilterActive: "standard",
      });
    }
  }

  // ------------------------------------------------------------ devices

  async setInputDevice(deviceId: string | null) {
    const room = this.room;
    if (room && deviceId) await room.switchActiveDevice("audioinput", deviceId);
    this.refreshMic();
  }

  async setOutputDevice(deviceId: string | null) {
    const room = this.room;
    if (room && deviceId) await room.switchActiveDevice("audiooutput", deviceId).catch(() => undefined);
  }

  private async onDevicesChanged() {
    const room = this.room;
    if (!room) return;
    const inputs = await listDevices("audioinput").catch(() => []);
    const activeId = room.getActiveDevice("audioinput");
    const preferred = this.settings?.micDeviceId;
    if (activeId && activeId !== "default" && !inputs.some((d) => d.deviceId === activeId)) {
      await room.switchActiveDevice("audioinput", "default").catch(() => undefined);
      this.set({ notice: "Headset microphone disconnected — now using the phone microphone." });
    } else if (preferred && preferred !== activeId && inputs.some((d) => d.deviceId === preferred)) {
      await room.switchActiveDevice("audioinput", preferred).catch(() => undefined);
      this.set({ notice: "Headset reconnected — using it again." });
    }
    this.refreshMic();
  }

  clearNotice() {
    this.set({ notice: null });
  }

  async resumeAudio() {
    await this.audioContext?.resume().catch(() => undefined);
    await this.room?.startAudio().catch(() => undefined);
    this.set({ canPlayAudio: this.room?.canPlaybackAudio ?? true });
  }

  /** Take over after "opened on another device". */
  async reclaim() {
    this.reconnectAttempt = 0;
    await this.start();
  }

  remoteParticipant(id: string): Participant | undefined {
    return this.room?.remoteParticipants.get(id);
  }
}

function setSubscribed(pub: RemoteTrackPublication, desired: boolean) {
  if (pub.isDesired !== desired) pub.setSubscribed(desired);
}

function qualityName(q: ConnectionQuality): MediaSnapshot["quality"] {
  switch (q) {
    case ConnectionQuality.Excellent:
      return "excellent";
    case ConnectionQuality.Good:
      return "good";
    case ConnectionQuality.Poor:
      return "poor";
    case ConnectionQuality.Lost:
      return "lost";
    default:
      return "unknown";
  }
}

function createAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor({ latencyHint: "interactive" });
  } catch {
    return null;
  }
}
