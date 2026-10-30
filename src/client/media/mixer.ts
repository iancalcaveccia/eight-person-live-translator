"use client";

/**
 * Per-listener Web Audio mixer. Every subscribed remote audio track (native
 * mic or translation) gets an AnalyserNode in front of LiveKit's per-track
 * GainNode (Room `webAudioMix`). A 20 Hz control loop measures activity,
 * applies `computeMix` and smooths gains. Audio never passes through a
 * shared queue, so overlapping speakers stay independent.
 */
import type { RemoteAudioTrack } from "livekit-client";
import { ActivityDetector, computeMix, smoothGain, type MixMode, type StreamState } from "./mixer-policy";

export interface MixerConfig {
  mode: MixMode;
  focusSpeakerId: string | null;
  translationVolume: number;
  originalVolume: number;
  speakerVolume: Record<string, number>;
  speakerMuted: Record<string, boolean>;
}

interface Entry {
  key: string;
  speakerId: string;
  kind: "native" | "translation";
  track: RemoteAudioTrack;
  element: HTMLMediaElement;
  analyser: AnalyserNode | null;
  buf: Float32Array<ArrayBuffer> | null;
  detector: ActivityDetector;
  active: boolean;
  activeForMs: number;
  level: number;
  gain: number;
  lastApplied: number;
}

export interface SpeakerActivity {
  active: boolean;
  level: number; // 0..1 RMS-ish
  kind: "native" | "translation";
  gain: number;
}

const TICK_MS = 50;

export class AudioMixer {
  private entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private listeners = new Set<() => void>();
  private snapshotCache: Map<string, SpeakerActivity> = new Map();
  private config: MixerConfig = {
    mode: "natural",
    focusSpeakerId: null,
    translationVolume: 1,
    originalVolume: 1,
    speakerVolume: {},
    speakerMuted: {},
  };

  constructor(
    private ctx: AudioContext | null,
    private container: HTMLElement,
    private onActivityStart: (speakerId: string, kind: "native" | "translation", overlap: boolean) => void,
  ) {}

  setConfig(c: Partial<MixerConfig>) {
    this.config = { ...this.config, ...c };
  }

  add(key: string, speakerId: string, kind: "native" | "translation", track: RemoteAudioTrack) {
    this.remove(key);
    let analyser: AnalyserNode | null = null;
    if (this.ctx) {
      try {
        analyser = this.ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0;
        track.setWebAudioPlugins([analyser]);
      } catch {
        analyser = null;
      }
    }
    const element = track.attach();
    element.setAttribute("data-mixer-key", key);
    this.container.appendChild(element);
    const entry: Entry = {
      key,
      speakerId,
      kind,
      track,
      element,
      analyser,
      buf: analyser ? new Float32Array(new ArrayBuffer(analyser.fftSize * 4)) : null,
      detector: new ActivityDetector(),
      active: false,
      activeForMs: 0,
      level: 0,
      gain: 1,
      lastApplied: -1,
    };
    this.entries.set(key, entry);
    this.ensureLoop();
  }

  remove(key: string) {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    try {
      e.track.setWebAudioPlugins([]);
    } catch {
      /* track may already be gone */
    }
    e.track.detach(e.element);
    e.element.remove();
  }

  /** Drop everything (group switch): no stale audio may keep playing. */
  clear() {
    for (const key of [...this.entries.keys()]) this.remove(key);
    this.snapshotCache = new Map();
    this.emit();
  }

  destroy() {
    this.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  /** Activity per speaker (merged across native/translation streams). */
  snapshot = (): Map<string, SpeakerActivity> => this.snapshotCache;

  debugDecisions(): { key: string; speakerId: string; kind: string; active: boolean; gain: number }[] {
    return [...this.entries.values()].map((e) => ({
      key: e.key,
      speakerId: e.speakerId,
      kind: e.kind,
      active: e.active,
      gain: Math.round(e.gain * 100) / 100,
    }));
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  private ensureLoop() {
    if (this.timer) return;
    this.lastTick = performance.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private tick() {
    const now = performance.now();
    const dt = Math.min(500, now - this.lastTick);
    this.lastTick = now;

    const translationActiveBefore = [...this.entries.values()].some((e) => e.kind === "translation" && e.active);

    for (const e of this.entries.values()) {
      let rms = 0;
      if (e.analyser && e.buf) {
        e.analyser.getFloatTimeDomainData(e.buf);
        let sum = 0;
        for (let i = 0; i < e.buf.length; i++) sum += e.buf[i] * e.buf[i];
        rms = Math.sqrt(sum / e.buf.length);
      }
      const r = e.detector.update(rms, now);
      e.level = rms;
      e.active = r.active;
      e.activeForMs = r.activeForMs;
      if (r.startedNow) this.onActivityStart(e.speakerId, e.kind, translationActiveBefore);
    }

    const streams: StreamState[] = [...this.entries.values()].map((e) => ({
      key: e.key,
      speakerId: e.speakerId,
      kind: e.kind,
      active: e.active,
      activeForMs: e.activeForMs,
      userGain: this.config.speakerVolume[e.speakerId] ?? 1,
      muted: Boolean(this.config.speakerMuted[e.speakerId]),
    }));
    const decisions = computeMix({
      mode: this.config.mode,
      focusSpeakerId: this.config.focusSpeakerId,
      translationVolume: this.config.translationVolume,
      originalVolume: this.config.originalVolume,
      streams,
    });

    const snap = new Map<string, SpeakerActivity>();
    for (const e of this.entries.values()) {
      const target = decisions.get(e.key)?.gain ?? 1;
      e.gain = smoothGain(e.gain, target, dt);
      if (Math.abs(e.gain - e.lastApplied) > 0.004) {
        e.track.setVolume(e.gain);
        e.lastApplied = e.gain;
      }
      const prev = snap.get(e.speakerId);
      if (!prev || e.level > prev.level) {
        snap.set(e.speakerId, { active: e.active || Boolean(prev?.active), level: e.level, kind: e.kind, gain: e.gain });
      }
    }
    if (!sameSnapshot(this.snapshotCache, snap)) {
      this.snapshotCache = snap;
      this.emit();
    }
  }
}

function sameSnapshot(a: Map<string, SpeakerActivity>, b: Map<string, SpeakerActivity>) {
  if (a.size !== b.size) return false;
  for (const [k, v] of b) {
    const o = a.get(k);
    if (!o || o.active !== v.active || Math.abs(o.level - v.level) > 0.01) return false;
  }
  return true;
}
