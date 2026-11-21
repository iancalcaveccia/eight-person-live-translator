"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { CaptionStore } from "@/client/media/captions";
import type { RemoteHuman } from "@/client/media/session";
import type { HearingMode } from "@/client/media/routing";
import { updateSettings, type ListenerSettings } from "@/client/prefs";
import { speakLabel } from "@/lib/languages";
import { Switch } from "./SettingsSheet";
import Sheet, { initials, speakerColor } from "./Sheet";

export default function SpeakerSheet({
  person,
  hearing,
  settings,
  captions,
  isHost,
  myListenLang,
  onHostMute,
  onHostKick,
  onClose,
}: {
  person: RemoteHuman;
  hearing: HearingMode;
  settings: ListenerSettings;
  captions: CaptionStore;
  isHost: boolean;
  myListenLang: string;
  onHostMute: () => Promise<void>;
  onHostKick: () => Promise<void>;
  onClose: () => void;
}) {
  const version = useSyncExternalStore(captions.subscribe, captions.getVersion, () => 0);
  const recent = useMemo(() => {
    void version;
    return captions
      .list()
      .filter((c) => c.speakerId === person.id)
      .slice(-8);
  }, [captions, version, person.id]);
  const volume = settings.speakerVolume[person.id] ?? 1;
  const muted = Boolean(settings.speakerMuted[person.id]);
  const focused = settings.focusSpeakerId === person.id;
  const original = settings.originalFor.includes(person.id);
  const differentLanguage = person.speakLang === "auto" || person.speakLang !== myListenLang;

  return (
    <Sheet
      title={
        <span className="row">
          <span className="dot-avatar" style={{ ["--pc" as string]: speakerColor(person.color), width: 40, height: 40 }}>
            {initials(person.name)}
          </span>
          {person.name}
        </span>
      }
      label={person.name}
      onClose={onClose}
    >
      <div className="sheet-section">
        <div className="small muted">
          Speaks {speakLabel(person.speakLang, person.esRegion)} · you hear{" "}
          {hearing === "translation" ? "the interpreter voice" : hearing === "native" ? "their own voice" : "them in the room only"}
        </div>
        <label className="field">
          <span className="field-label">Volume · {Math.round(volume * 100)}%</span>
          <input
            className="range"
            type="range"
            min={0}
            max={1.5}
            step={0.05}
            value={volume}
            onChange={(e) => updateSettings((s) => ({ speakerVolume: { ...s.speakerVolume, [person.id]: Number(e.target.value) } }))}
          />
        </label>
        <div className="setting-row">
          <div>
            <div className="setting-title">Focus on {person.name}</div>
            <div className="setting-sub">Others get quieter while {person.name} talks.</div>
          </div>
          <Switch
            checked={focused}
            onChange={(v) => updateSettings({ focusSpeakerId: v ? person.id : null, mixMode: v ? "focus" : "natural" })}
          />
        </div>
        <div className="setting-row">
          <div>
            <div className="setting-title">Mute for me</div>
            <div className="setting-sub">Only on your phone. Captions keep showing.</div>
          </div>
          <Switch checked={muted} onChange={(v) => updateSettings((s) => ({ speakerMuted: { ...s.speakerMuted, [person.id]: v } }))} />
        </div>
        {differentLanguage && (
          <div className="setting-row">
            <div>
              <div className="setting-title">Hear original voice</div>
              <div className="setting-sub">Skip the interpreter for {person.name} if you understand them.</div>
            </div>
            <Switch
              checked={original}
              onChange={(v) =>
                updateSettings((s) => ({
                  originalFor: v ? [...new Set([...s.originalFor, person.id])] : s.originalFor.filter((x) => x !== person.id),
                }))
              }
            />
          </div>
        )}
      </div>

      <div className="sheet-section">
        <span className="section-label">Recently</span>
        {recent.length === 0 && <p className="small faint">Nothing yet.</p>}
        {recent.map((c) => (
          <div key={c.id} className={c.kind === "source" ? "caption-orig" : ""}>
            {c.kind === "source" ? `“${c.text}”` : c.text}
          </div>
        ))}
      </div>

      {isHost && (
        <div className="sheet-section">
          <span className="section-label">Host</span>
          <div className="row">
            <button className="btn btn-secondary btn-sm grow" onClick={() => void onHostMute()}>
              Mute their mic
            </button>
            <button className="btn btn-danger btn-sm grow" onClick={() => void onHostKick()}>
              Remove from gathering
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
