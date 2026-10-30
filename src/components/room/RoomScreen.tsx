"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import type { MediaTokenView } from "@/lib/api-types";
import { api, ClientApiError } from "@/client/api";
import { useGatheringState } from "@/client/useGatheringState";
import { MediaSession, type MediaSnapshot } from "@/client/media/session";
import type { SpeakerActivity } from "@/client/media/mixer";
import { hearingModeFor, type ListenerPrefs } from "@/client/media/routing";
import { isIOS, ScreenWakeLock } from "@/client/media/devices";
import { updateSettings, useSettings } from "@/client/prefs";
import { flagFor } from "@/lib/languages";
import { CaptionsIcon, ChevronDown, GroupsIcon, LockIcon, MicIcon, MicOffIcon, QrIcon, SettingsIcon } from "../icons";
import CaptionsPanel from "./CaptionsPanel";
import ConversationsSheet, { type ConversationActions } from "./ConversationsSheet";
import InviteSheet from "./InviteSheet";
import PersonCard from "./PersonCard";
import SettingsSheet from "./SettingsSheet";
import SpeakerSheet from "./SpeakerSheet";
import { initials, speakerColor } from "./Sheet";
import { computeStatus } from "./status";

const EMPTY_ACTIVITY = new Map<string, SpeakerActivity>();
const noopSubscribe = () => () => {};
const emptyActivity = () => EMPTY_ACTIVITY;

type SheetName = null | "conversations" | "invite" | "settings" | { speaker: string };

/**
 * The audio sink lives outside the screen content so it is never re-mounted:
 * the media session appends its <audio> elements to it.
 */
export default function RoomScreen(props: { gid: string; openInvite: boolean }) {
  const audioRef = useRef<HTMLDivElement | null>(null);
  return (
    <>
      <div className="audio-sink" ref={audioRef} aria-hidden />
      <RoomContent {...props} audioRef={audioRef} />
    </>
  );
}

function RoomContent({
  gid,
  openInvite,
  audioRef,
}: {
  gid: string;
  openInvite: boolean;
  audioRef: React.RefObject<HTMLDivElement | null>;
}) {
  const router = useRouter();
  const { state, error, refresh } = useGatheringState(gid);
  const settings = useSettings();
  const [session, setSession] = useState<MediaSession | null>(null);
  const [sheet, setSheet] = useState<SheetName>(openInvite ? "invite" : null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [dismissedInvites, setDismissedInvites] = useState<Set<string>>(new Set());
  const [iosHintDismissed, setIosHintDismissed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const wakeLock = useMemo(() => new ScreenWakeLock(), []);
  const [wakeHeld, setWakeHeld] = useState(false);

  const hasState = state !== null;
  const listenLang = state?.me.listenLang ?? "en";

  // Create the single media session once we know who we are.
  useEffect(() => {
    if (!hasState || !audioRef.current) return;
    const s = new MediaSession(gid, audioRef.current, {
      fetchToken: () => api.token(gid),
      onNudge: refresh,
      listenLang,
    });
    setSession(s);
    void s.start();
    return () => {
      s.destroy();
      setSession(null);
    };
    // listenLang is applied through setListenerSettings below; recreating the session would drop audio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gid, hasState, refresh]);

  const snap: MediaSnapshot | null = useSyncExternalStore(
    session?.subscribe ?? noopSubscribe,
    () => session?.getSnapshot() ?? null,
    () => null,
  );
  const activity = useSyncExternalStore(session?.mixer.subscribe ?? noopSubscribe, session?.mixer.snapshot ?? emptyActivity, emptyActivity);

  useEffect(() => {
    session?.setListenerSettings(settings, listenLang);
  }, [session, settings, listenLang]);

  // Test-only inspection hooks, compiled in only for E2E builds.
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_E2E_HOOKS !== "1" || !session) return;
    (window as unknown as { __mesa?: unknown }).__mesa = {
      snapshot: () => session.getSnapshot(),
      mixer: () => session.mixer.debugDecisions(),
      captions: () => session.captions.list().map((c) => ({ ...c })),
      latency: () => ({ client: session.latency.summary(), server: session.latency.serverSummary(), samples: session.latency.samples }),
      room: () => session.currentRoom?.name ?? null,
      subscribed: () =>
        [...(session.currentRoom?.remoteParticipants.values() ?? [])].flatMap((p) =>
          [...p.audioTrackPublications.values()].filter((t) => t.isSubscribed).map((t) => ({ from: p.identity, kind: p.kind, track: t.trackName })),
        ),
    };
  }, [session]);

  // Someone else (group owner / another tab) moved us: the server epoch is newer than our token.
  useEffect(() => {
    if (!session || !snap || !state) return;
    if (snap.status === "connected" && state.me.epoch > snap.epoch && state.me.activeGroupId !== snap.groupId) {
      void session.start();
    }
  }, [session, snap, state]);

  // Keep the screen awake while in the room (iOS stops the mic when locked).
  useEffect(() => {
    if (!settings.keepAwake) {
      void wakeLock.disable().then(() => setWakeHeld(false));
      return;
    }
    void wakeLock.enable().then(() => setWakeHeld(wakeLock.held));
    const t = setInterval(() => setWakeHeld(wakeLock.held), 5000);
    return () => {
      clearInterval(t);
      void wakeLock.disable();
    };
  }, [settings.keepAwake, wakeLock]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  // ------------------------------------------------------------- actions

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } catch (err) {
        setToast(err instanceof ClientApiError ? err.message : err instanceof Error ? err.message : "Something went wrong");
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [refresh],
  );

  const switchTo = useCallback(
    (move: () => Promise<MediaTokenView>) =>
      run(async () => {
        if (!session) throw new Error("Not connected yet");
        await session.switchGroup(move);
        setSheet(null);
      }),
    [run, session],
  );

  const actions: ConversationActions = useMemo(
    () => ({
      enter: (groupId) => switchTo(() => api.enterGroup(gid, groupId)),
      returnToMain: () => switchTo(() => api.returnToMain(gid)),
      create: (name, ids) => switchTo(async () => (await api.createGroup(gid, name, ids)).media),
      invite: (groupId, ids) =>
        run(async () => {
          await api.invite(gid, groupId, ids);
          setToast("Invitation sent");
        }),
      respond: async (invId, action) => {
        if (action === "decline") return run(async () => void (await api.respond(gid, invId, "decline")));
        return switchTo(async () => {
          const r = await api.respond(gid, invId, "accept");
          if (!r.media) throw new Error("Invitation could not be accepted");
          return r.media;
        });
      },
      leave: (groupId) => switchTo(() => api.leaveGroup(gid, groupId)),
      remove: (groupId, pid) => run(async () => void (await api.removeMember(gid, groupId, pid))),
    }),
    [gid, run, switchTo],
  );

  // ------------------------------------------------------------- terminal states

  const terminal = terminalMessage(error, snap);
  if (terminal) {
    return (
      <main className="full-center">
        <div className="container stack">
          <h1 className="display h-md">{terminal.title}</h1>
          <p className="muted">{terminal.body}</p>
          <button className="btn btn-secondary" onClick={() => router.push("/")}>
            Back to start
          </button>
          {snap?.status === "replaced" && session && (
            <button className="btn btn-primary" onClick={() => void session.reclaim()}>
              Use this device instead
            </button>
          )}
        </div>
      </main>
    );
  }

  if (!state || !snap || !session) {
    return (
      <main className="full-center">
        <div className="stack" style={{ alignItems: "center" }}>
          <div className="spinner" />
          <p className="mono">Joining…</p>
        </div>
      </main>
    );
  }

  // ------------------------------------------------------------- derived view

  const prefs: ListenerPrefs = {
    listenLang,
    nativePassthrough: settings.nativePassthrough,
    originalFor: new Set(settings.originalFor),
  };
  const group = state.groups.find((g) => g.id === state.me.activeGroupId);
  const humans = snap.humans;
  const names = new Map<string, string>([[state.me.id, state.me.displayName], ...humans.map((h) => [h.id, h.name] as [string, string])]);
  for (const p of state.participants) if (!names.has(p.id)) names.set(p.id, p.displayName);
  const colors = new Map<string, number>([[state.me.id, state.me.color], ...humans.map((h) => [h.id, h.color] as [string, number])]);
  const sameLanguage = new Set(humans.filter((h) => hearingModeFor({ id: h.id, speakLang: h.speakLang }, prefs) !== "translation").map((h) => h.id));
  const lat = session.latency.summary();
  const status = computeStatus(snap, settings, listenLang, state.budget.translationAllowed, lat.p50);
  const pendingInvite = state.invitations.find((i) => !dismissedInvites.has(i.id));
  const elapsedMin = Math.max(0, Math.floor((now - new Date(state.gathering.createdAt).getTime()) / 60000));
  const seatsLeft = state.gathering.maxHumans - state.participants.length;
  const speakerSheet = typeof sheet === "object" && sheet !== null ? humans.find((h) => h.id === sheet.speaker) : undefined;
  const micOn = settings.micMode === "hold" ? snap.micLive : snap.micWanted;

  return (
    <div className="room" onPointerDown={() => !snap.canPlayAudio && void session.resumeAudio()}>
      <header className="topbar">
        <button className="group-chip" onClick={() => setSheet("conversations")} aria-label="Conversations">
          {group?.kind === "private" ? <LockIcon width={16} height={16} /> : <GroupsIcon width={18} height={18} />}
          <span className="name">{group?.name ?? "Conversation"}</span>
          <span className="count">· {humans.length + 1}</span>
          {state.invitations.length > 0 && <span className="badge">{state.invitations.length}</span>}
          <ChevronDown width={16} height={16} />
        </button>
        <span className="grow" />
        <span
          className={`pill ${status.tone === "live" ? "pill-live" : status.tone === "warn" ? "pill-warn" : status.tone === "err" ? "pill-err" : ""}`}
          title={status.detail}
          role="status"
        >
          <span className="dot" />
          {status.label}
        </span>
      </header>

      <div className="subbar small faint">
        <span>
          {humans.length === 0
            ? "Nobody else here yet"
            : `Talking with ${humans.map((h) => h.name).join(", ")}`}
        </span>
        <span>·</span>
        <span>{formatElapsed(elapsedMin)}</span>
        <span>·</span>
        <span title="Estimated AI cost for this gathering">${state.budget.gatheringUsd.toFixed(2)}</span>
      </div>

      <div>
        <div className="banners">
          {!snap.canPlayAudio && (
            <button className="notice notice-warn" onClick={() => void session.resumeAudio()}>
              🔊 Tap here to turn on sound
            </button>
          )}
          {snap.notice && (
            <button className="notice" onClick={() => session.clearNotice()}>
              {snap.notice} <span className="faint">(dismiss)</span>
            </button>
          )}
          {state.budget.warning && state.budget.translationAllowed && (
            <div className="notice notice-warn">Spending is close to the limit set for this gathering.</div>
          )}
          {!state.budget.translationAllowed && (
            <div className="notice notice-err">
              Translation is paused: the spending cap was reached. You can still talk and hear people in their own voices.
            </div>
          )}
          {isIOS() && !iosHintDismissed && (
            <button className="notice" onClick={() => setIosHintDismissed(true)}>
              Keep Mesa open on screen — iPhone pauses the microphone when the screen locks or you switch apps.
            </button>
          )}
          {snap.micPermission === "denied" && (
            <div className="notice notice-err">Microphone blocked. Allow it in the browser&apos;s site settings, then reload.</div>
          )}
        </div>
      </div>

      <main className="stage">
        <section className="people" aria-label="People in this conversation">
          <div className="person me-card" style={{ ["--pc" as string]: speakerColor(state.me.color) }} data-active={snap.meSpeaking && snap.micLive}>
            <div className="avatar" style={{ ["--level" as string]: snap.meSpeaking && snap.micLive ? 0.6 : 0 }}>
              {initials(state.me.displayName)}
            </div>
            <div className="person-name">You</div>
            <div className="person-meta">
              <span>
                {flagFor(state.me.speakLang, state.me.esRegion)} → {flagFor(state.me.listenLang, state.me.esRegion)}
              </span>
              {!snap.micLive && <span className="tag">mic off</span>}
            </div>
          </div>
          {humans.map((h) => {
            const a = activity.get(h.id);
            return (
              <PersonCard
                key={h.id}
                person={h}
                hearing={hearingModeFor({ id: h.id, speakLang: h.speakLang }, prefs)}
                level={a?.level ?? 0}
                active={Boolean(a?.active) || (h.speaking && !h.micMuted && !a)}
                focused={settings.mixMode === "focus" && settings.focusSpeakerId === h.id}
                mutedLocally={Boolean(settings.speakerMuted[h.id])}
                onOpen={() => setSheet({ speaker: h.id })}
              />
            );
          })}
        </section>

        {humans.length === 0 && (
          <div className="empty">
            <p style={{ marginBottom: 12 }}>Invite people with the QR code. Interpretation starts as soon as someone with another language joins.</p>
            <button className="btn btn-primary btn-sm" onClick={() => setSheet("invite")}>
              <QrIcon width={18} height={18} /> Show invite
            </button>
          </div>
        )}

        {settings.captions && (
          <section className="card card-tight" aria-label="Live captions">
            <CaptionsPanel
              store={session.captions}
              names={names}
              colors={colors}
              showOriginal={settings.showOriginalCaptions}
              sameLanguageSpeakers={sameLanguage}
            />
          </section>
        )}
      </main>

      <nav className="dock" aria-label="Controls">
        <div className="dock-side">
          <button
            className="dock-btn"
            aria-pressed={settings.captions}
            aria-label="Captions"
            onClick={() => updateSettings({ captions: !settings.captions })}
          >
            <CaptionsIcon />
          </button>
          <button className="dock-btn" aria-label="Conversations" onClick={() => setSheet("conversations")}>
            <GroupsIcon />
            {state.invitations.length > 0 && <span className="badge">{state.invitations.length}</span>}
          </button>
        </div>
        <div>
          {settings.micMode === "hold" ? (
            <button
              className="mic-btn"
              data-live={snap.micLive}
              aria-label="Hold to talk"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                void session.resumeAudio();
                void session.pttDown();
              }}
              onPointerUp={() => session.pttUp()}
              onPointerCancel={() => session.pttUp()}
              onContextMenu={(e) => e.preventDefault()}
            >
              {snap.micLive ? <MicIcon /> : <MicOffIcon />}
            </button>
          ) : (
            <button
              className="mic-btn"
              data-live={micOn && snap.micLive}
              aria-pressed={micOn}
              aria-label={micOn ? "Mute microphone" : "Turn on microphone"}
              onClick={() => {
                void session.resumeAudio();
                void session.setMicWanted(!snap.micWanted);
              }}
            >
              {micOn ? <MicIcon /> : <MicOffIcon />}
            </button>
          )}
          <div className="mic-label">{settings.micMode === "hold" ? "Hold to talk" : micOn ? "Mic on" : "Tap to talk"}</div>
        </div>
        <div className="dock-side end">
          <button className="dock-btn" aria-label="Invite" onClick={() => setSheet("invite")}>
            <QrIcon />
          </button>
          <button className="dock-btn" aria-label="Settings" onClick={() => setSheet("settings")}>
            <SettingsIcon />
          </button>
        </div>
      </nav>

      {pendingInvite && sheet === null && (
        <div className="toast" role="alert">
          <div style={{ marginBottom: 10 }}>
            <strong>{pendingInvite.fromName}</strong> invited you to <strong>{pendingInvite.groupName}</strong>
            <div className="small faint">With {pendingInvite.memberNames.join(", ")}</div>
          </div>
          <div className="row">
            <button className="btn btn-secondary btn-sm grow" disabled={busy} onClick={() => setDismissedInvites((s) => new Set(s).add(pendingInvite.id))}>
              Later
            </button>
            <button className="btn btn-primary btn-sm grow" disabled={busy} onClick={() => void actions.respond(pendingInvite.id, "accept")}>
              Join now
            </button>
          </div>
        </div>
      )}
      {toast && (
        <div className="toast" role="status" style={{ borderColor: "var(--line-strong)" }}>
          {toast}
        </div>
      )}

      {sheet === "conversations" && <ConversationsSheet state={state} busy={busy} actions={actions} onClose={() => setSheet(null)} />}
      {sheet === "invite" && (
        <InviteSheet
          inviteUrlPath={state.gathering.inviteUrlPath}
          isHost={state.me.role === "host"}
          seatsLeft={seatsLeft}
          onRotate={() => run(async () => void (await api.rotateInvite(gid)))}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "settings" && (
        <SettingsSheet
          state={state}
          session={session}
          snap={snap}
          settings={settings}
          wakeLockSupported={wakeLock.supported}
          wakeLockHeld={wakeHeld}
          onLanguages={(v) => run(async () => void (await api.updateMe(gid, v)))}
          onEnd={() =>
            run(async () => {
              await api.end(gid);
              router.push("/");
            })
          }
          onLeave={() =>
            run(async () => {
              await api.leaveGathering(gid);
              router.push("/");
            })
          }
          onClose={() => setSheet(null)}
        />
      )}
      {speakerSheet && (
        <SpeakerSheet
          person={speakerSheet}
          hearing={hearingModeFor({ id: speakerSheet.id, speakLang: speakerSheet.speakLang }, prefs)}
          settings={settings}
          captions={session.captions}
          isHost={state.me.role === "host"}
          myListenLang={listenLang}
          onHostMute={() => run(async () => void (await api.mute(gid, speakerSheet.id)))}
          onHostKick={() =>
            run(async () => {
              await api.kick(gid, speakerSheet.id);
              setSheet(null);
            })
          }
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  );
}

function formatElapsed(min: number): string {
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

function terminalMessage(error: ClientApiError | null, snap: MediaSnapshot | null): { title: string; body: string } | null {
  if (snap?.status === "ended" || error?.status === 410) {
    return { title: "This gathering has ended", body: "Thanks for joining. Nothing from the conversation was kept." };
  }
  if (snap?.status === "kicked" || error?.code === "kicked") {
    return { title: "You were removed", body: "The host removed you from this gathering." };
  }
  if (error?.status === 401) {
    return { title: "You need an invite", body: "Open the invite link or scan the QR code from the host to join." };
  }
  if (snap?.status === "replaced") {
    return { title: "Open on another screen", body: "You joined this gathering from another tab or device." };
  }
  if (snap?.status === "failed") {
    return { title: "Live audio unavailable", body: snap.error ?? "The server is not configured for live audio yet." };
  }
  return null;
}
