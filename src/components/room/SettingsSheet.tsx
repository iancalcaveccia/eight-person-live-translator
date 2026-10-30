"use client";

import { useEffect, useState } from "react";
import type { GatheringStateView } from "@/lib/api-types";
import type { MediaSession, MediaSnapshot } from "@/client/media/session";
import { canSelectAudioOutput, isIOS, listDevices, looksLikeHeadset, playTestTone } from "@/client/media/devices";
import { updateSettings, type ListenerSettings } from "@/client/prefs";
import LanguagePicker, { type LanguageValue } from "../LanguagePicker";
import Sheet from "./Sheet";

export default function SettingsSheet({
  state,
  session,
  snap,
  settings,
  wakeLockSupported,
  wakeLockHeld,
  onLanguages,
  onEnd,
  onLeave,
  onClose,
}: {
  state: GatheringStateView;
  session: MediaSession;
  snap: MediaSnapshot;
  settings: ListenerSettings;
  wakeLockSupported: boolean;
  wakeLockHeld: boolean;
  onLanguages: (v: LanguageValue) => Promise<void>;
  onEnd: () => Promise<void>;
  onLeave: () => Promise<void>;
  onClose: () => void;
}) {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const langs: LanguageValue = { speakLang: state.me.speakLang, listenLang: state.me.listenLang, esRegion: state.me.esRegion };
  const isHost = state.me.role === "host";

  useEffect(() => {
    void listDevices("audioinput").then(setInputs).catch(() => undefined);
    if (canSelectAudioOutput()) void listDevices("audiooutput").then(setOutputs).catch(() => undefined);
  }, [snap.inputDeviceLabel]);

  const lat = session.latency.summary();
  const latOverlap = session.latency.summary((s) => s.overlap);
  const server = session.latency.serverSummary();
  const b = state.budget;
  const fmt = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);

  return (
    <Sheet title="Settings" onClose={onClose}>
      <div className="sheet-section">
        <span className="section-label">Languages</span>
        <LanguagePicker value={langs} onChange={(v) => void onLanguages(v)} compact />
      </div>

      <div className="sheet-section">
        <span className="section-label">Microphone & headset</span>
        <div className="small muted">
          Using: <strong style={{ color: "var(--fg)" }}>{snap.inputDeviceLabel || "default microphone"}</strong>{" "}
          {snap.inputDeviceLabel && (looksLikeHeadset(snap.inputDeviceLabel) ? "🎧" : "(may be the phone mic)")}
        </div>
        {inputs.length > 1 && (
          <select
            className="select"
            aria-label="Microphone"
            value={settings.micDeviceId ?? ""}
            onChange={async (e) => {
              const id = e.target.value || null;
              updateSettings({ micDeviceId: id });
              await session.setInputDevice(id ?? "default");
            }}
          >
            <option value="">System default</option>
            {inputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || "Microphone"} {looksLikeHeadset(d.label) ? "🎧" : ""}
              </option>
            ))}
          </select>
        )}
        {outputs.length > 1 && (
          <select
            className="select"
            aria-label="Sound output"
            value={settings.outputDeviceId ?? ""}
            onChange={async (e) => {
              const id = e.target.value || null;
              updateSettings({ outputDeviceId: id });
              await session.setOutputDevice(id ?? "default");
            }}
          >
            <option value="">System default output</option>
            {outputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || "Speaker"}
              </option>
            ))}
          </select>
        )}
        {isIOS() && <p className="small faint">On iPhone, iOS chooses the headset itself. Use Control Center to change the audio route.</p>}
        <button className="btn btn-secondary btn-sm" onClick={() => session.audioContext && playTestTone(session.audioContext)}>
          Play test sound
        </button>

        <div className="field">
          <span className="field-label">Noise filter</span>
          <div className="segmented">
            {(
              [
                ["standard", "Standard"],
                ["krisp", "Noise removal"],
                ["voice-focus", "Voice focus"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} aria-pressed={settings.noiseMode === k} onClick={() => updateSettings({ noiseMode: k })}>
                {label}
              </button>
            ))}
          </div>
          <p className="small faint">
            Voice focus suppresses other people&apos;s voices near you (helps at a crowded table) and uses LiveKit Cloud
            voice-isolation minutes. Active now: {snap.noiseFilterActive}.
          </p>
        </div>

        <div className="setting-row">
          <div>
            <div className="setting-title">Hold to talk</div>
            <div className="setting-sub">Last resort for very noisy rooms. Normally leave the mic open.</div>
          </div>
          <Switch checked={settings.micMode === "hold"} onChange={(v) => updateSettings({ micMode: v ? "hold" : "open" })} />
        </div>
      </div>

      <div className="sheet-section">
        <span className="section-label">Listening</span>
        <div className="field">
          <span className="field-label">When people talk over each other</span>
          <div className="segmented">
            {(
              [
                ["natural", "Natural"],
                ["focus", "Focus"],
                ["equal", "Equal"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} aria-pressed={settings.mixMode === k} onClick={() => updateSettings({ mixMode: k })}>
                {label}
              </button>
            ))}
          </div>
          <p className="small faint">
            {settings.mixMode === "natural" && "Short interruptions are heard over the main speaker, who gets slightly quieter."}
            {settings.mixMode === "focus" && "The person you focus on (tap their card) stays loud; others are quieter while they talk."}
            {settings.mixMode === "equal" && "Everyone at the same volume. Can get busy with 3+ voices."}
          </p>
        </div>
        <label className="field">
          <span className="field-label">Translated voices · {Math.round(settings.translationVolume * 100)}%</span>
          <input className="range" type="range" min={0} max={1.5} step={0.05} value={settings.translationVolume} onChange={(e) => updateSettings({ translationVolume: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span className="field-label">Original voices · {Math.round(settings.originalVolume * 100)}%</span>
          <input className="range" type="range" min={0} max={1.5} step={0.05} value={settings.originalVolume} onChange={(e) => updateSettings({ originalVolume: Number(e.target.value) })} />
        </label>
        <div className="setting-row">
          <div>
            <div className="setting-title">Same-language voices in headset</div>
            <div className="setting-sub">Turn off if you sit next to them and hear them directly.</div>
          </div>
          <Switch checked={settings.nativePassthrough} onChange={(v) => updateSettings({ nativePassthrough: v })} />
        </div>
        <div className="setting-row">
          <div className="setting-title">Captions</div>
          <Switch checked={settings.captions} onChange={(v) => updateSettings({ captions: v })} />
        </div>
        <div className="setting-row">
          <div>
            <div className="setting-title">Also show original text</div>
            <div className="setting-sub">What people said in their own language.</div>
          </div>
          <Switch checked={settings.showOriginalCaptions} onChange={(v) => updateSettings({ showOriginalCaptions: v })} />
        </div>
      </div>

      <div className="sheet-section">
        <span className="section-label">Screen</span>
        <div className="setting-row">
          <div>
            <div className="setting-title">Keep screen on</div>
            <div className="setting-sub">
              {wakeLockSupported
                ? wakeLockHeld
                  ? "Active."
                  : "Not active yet (needs the page in front)."
                : "Not supported in this browser — keep the screen awake manually."}
              {isIOS() && " iPhone stops the microphone when the screen locks."}
            </div>
          </div>
          <Switch checked={settings.keepAwake} onChange={(v) => updateSettings({ keepAwake: v })} />
        </div>
      </div>

      <div className="sheet-section">
        <span className="section-label">Live measurements</span>
        <div className="stat-grid">
          <div className="stat">
            <b>{fmt(lat.p50)}</b>
            <span>Speech → your ears, median ({lat.count})</span>
          </div>
          <div className="stat">
            <b>{fmt(lat.p95)}</b>
            <span>Speech → your ears, p95</span>
          </div>
          <div className="stat">
            <b>{fmt(latOverlap.p50)}</b>
            <span>Interruptions, median ({latOverlap.count})</span>
          </div>
          <div className="stat">
            <b>{fmt(server.p50)}</b>
            <span>Interpreter processing, median</span>
          </div>
          <div className="stat">
            <b>{snap.lastSwitchMs === null ? "—" : `${(snap.lastSwitchMs / 1000).toFixed(1)} s`}</b>
            <span>Last conversation switch</span>
          </div>
          <div className="stat">
            <b>{snap.quality}</b>
            <span>Network</span>
          </div>
        </div>
        <p className="small faint">
          Measured from when the interpreter detects speech to when translated sound starts on this phone; the
          speaker&apos;s own upload delay (usually 0.1–0.3 s) is not included. No audio is recorded to measure this.
        </p>
        <button
          className="btn btn-secondary btn-sm"
          onClick={async () => {
            const report = {
              at: new Date().toISOString(),
              userAgent: navigator.userAgent,
              input: snap.inputDeviceLabel,
              inputLooksLikeHeadset: snap.inputIsHeadset,
              network: snap.quality,
              group: snap.groupId,
              peopleInGroup: snap.humans.length + 1,
              speechToEarsMs: lat,
              interruptionsMs: latOverlap,
              interpreterProcessingMs: server,
              lastSwitchMs: snap.lastSwitchMs,
              sessions: Object.values(snap.translation).map((t) => ({ target: t.target, provider: t.provider, state: t.state })),
              samplesMs: session.latency.samples.map((s) => s.ms),
            };
            try {
              await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
            } catch {
              /* clipboard blocked */
            }
          }}
        >
          Copy measurements (no audio or text)
        </button>
        {Object.values(snap.translation).length > 0 && (
          <div className="stack">
            {Object.values(snap.translation).map((t) => (
              <div key={`${t.speaker}:${t.target}`} className="row-between small">
                <span className="muted">
                  {state.participants.find((p) => p.id === t.speaker)?.displayName ?? "…"} → {t.target} · {t.provider}
                </span>
                <span className={t.state === "live" ? "" : "faint"}>{t.state}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="sheet-section">
        <span className="section-label">Spending (estimate)</span>
        <div className="stat-grid">
          <div className="stat">
            <b>${b.gatheringUsd.toFixed(2)}</b>
            <span>This gathering of ${b.gatheringCapUsd.toFixed(0)} cap</span>
          </div>
          <div className="stat">
            <b>${b.monthUsd.toFixed(2)}</b>
            <span>This month of ${b.monthCapUsd.toFixed(0)} cap</span>
          </div>
        </div>
        <p className="small faint">
          Estimated from interpreted audio minutes at list prices. Translation pauses automatically at a cap; you can
          still hear people in their original voices.
        </p>
      </div>

      <div className="sheet-section">
        {isHost ? (
          confirmEnd ? (
            <div className="stack">
              <p className="small">Everyone will be disconnected and the gathering&apos;s names and groups deleted.</p>
              <div className="row">
                <button className="btn btn-ghost grow" onClick={() => setConfirmEnd(false)}>
                  Cancel
                </button>
                <button className="btn btn-danger grow" onClick={() => void onEnd()}>
                  End for everyone
                </button>
              </div>
            </div>
          ) : (
            <button className="btn btn-danger btn-block" onClick={() => setConfirmEnd(true)}>
              End gathering
            </button>
          )
        ) : (
          <button className="btn btn-danger btn-block" onClick={() => void onLeave()}>
            Leave gathering
          </button>
        )}
      </div>
    </Sheet>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <span className="switch">
      <input type="checkbox" role="switch" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </span>
  );
}
