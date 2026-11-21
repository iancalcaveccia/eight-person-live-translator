"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ClientApiError, type PublicConfig } from "@/client/api";
import { rememberName, useStoredName } from "@/client/browser-values";
import { BrandGlyph } from "../BrandMark";
import ConsentBox from "../ConsentBox";
import InstallCard from "../InstallCard";
import LanguagePicker, { type LanguageValue } from "../LanguagePicker";
import RememberBox from "../RememberBox";
import { GroupsIcon, LockIcon, WaveIcon } from "../icons";
import PasteLink from "./PasteLink";

/** First visit on this phone (nobody remembered yet). */
export default function Welcome({ onRemembered }: { onRemembered: () => void }) {
  const router = useRouter();
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [step, setStep] = useState<"intro" | "create">("intro");
  const [title, setTitle] = useState("");
  const storedName = useStoredName();
  const [editedName, setName] = useState<string | null>(null);
  const name = editedName ?? storedName;
  const [hostCode, setHostCode] = useState("");
  const [langs, setLangs] = useState<LanguageValue>({ speakLang: "es", listenLang: "es", esRegion: "" });
  const [consent, setConsent] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.config().then(setCfg).catch(() => setCfg(null));
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const displayName = name.trim();
    let remembered = false;
    try {
      if (remember) {
        // Saved table: its link works next time too, and everyone who joins is remembered.
        await api.rememberMe({ displayName, ...langs, consent: true });
        remembered = true;
        const res = await api.createTable(title.trim() || "Our table", [], hostCode || undefined);
        rememberName(displayName);
        router.push(`/g/${res.gatheringId}?invite=1`);
      } else {
        const res = await api.createGathering({
          title: title.trim() || "Our table",
          displayName,
          hostCode: hostCode || undefined,
          ...langs,
          consent: true,
        });
        rememberName(displayName);
        router.push(`/g/${res.gatheringId}?invite=1`);
      }
    } catch (err) {
      setError(err instanceof ClientApiError ? err.message : "Could not start");
      setBusy(false);
      if (remembered) onRemembered();
    }
  }

  if (step === "intro") {
    return (
      <main className="page page-center">
        <div className="container stack-lg">
          <div className="hero-mark rise">
            <BrandGlyph />
          </div>
          <div className="stack rise rise-1">
            <h1 className="display h-xl">
              One table,
              <br />
              <em>every</em> language.
            </h1>
            <p className="lead">
              Everyone speaks naturally in English, Polish or Spanish — and hears everyone else live in their own
              language, in their own headset. No buttons, no taking turns.
            </p>
          </div>
          <div className="feature-list rise rise-2">
            <Feature icon={<WaveIcon />} title="Interpretation while you talk">
              Translation starts a few seconds into a sentence, not after it ends.
            </Feature>
            <Feature icon={<GroupsIcon />} title="Your people, saved">
              Set up a table once. Next time everyone just taps it — no forms, no new link.
            </Feature>
            <Feature icon={<LockIcon />} title="Private by default">
              Invite-only, nothing recorded, server-enforced privacy between groups.
            </Feature>
          </div>
          <div className="stack rise rise-3">
            <button className="btn btn-primary btn-block" onClick={() => setStep("create")}>
              Start a table
            </button>
            <p className="small faint" style={{ textAlign: "center" }}>
              Joining someone? Open their invite link or scan their QR code.
            </p>
          </div>
          <PasteLink />
          <InstallCard />
        </div>
      </main>
    );
  }

  return (
    <main className="page">
      <form className="container stack-lg" onSubmit={create}>
        <div className="stack">
          <button type="button" className="btn btn-ghost" style={{ alignSelf: "flex-start", paddingLeft: 0 }} onClick={() => setStep("intro")}>
            ← Back
          </button>
          <h1 className="display h-lg">Start a table</h1>
          <p className="muted">You&apos;ll get a link and QR code to share with up to {cfg?.maxHumans ?? 8} people.</p>
        </div>

        <div className="stack">
          <label className="field">
            <span className="field-label">Table name</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sunday dinner" maxLength={60} />
          </label>
          <label className="field">
            <span className="field-label">Your name</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ian"
              maxLength={40}
              required
              autoComplete="given-name"
            />
          </label>
          {cfg?.hostCodeRequired === true && (
            <label className="field">
              <span className="field-label">Host access code</span>
              <input
                className="input"
                value={hostCode}
                onChange={(e) => setHostCode(e.target.value)}
                type="password"
                autoComplete="off"
                placeholder="Set by the app owner"
              />
            </label>
          )}
        </div>

        <LanguagePicker value={langs} onChange={setLangs} />
        <ConsentBox checked={consent} onChange={setConsent} />
        <RememberBox checked={remember} onChange={setRemember} />

        {cfg && !cfg.mediaConfigured && (
          <div className="notice notice-warn">Live audio is not configured on this server yet (LiveKit credentials missing).</div>
        )}
        {error && <p className="error-text">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy || !name.trim() || !consent}>
          {busy ? <span className="spinner" /> : "Create & get invite"}
        </button>
      </form>
    </main>
  );
}

function Feature({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="feature">
      <div className="feature-icon">{icon}</div>
      <div>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div className="small muted">{children}</div>
      </div>
    </div>
  );
}
