"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ClientApiError, type PublicConfig } from "@/client/api";
import { BrandGlyph } from "@/components/BrandMark";
import ConsentBox from "@/components/ConsentBox";
import LanguagePicker, { type LanguageValue } from "@/components/LanguagePicker";
import { GroupsIcon, LockIcon, WaveIcon } from "@/components/icons";
import { rememberName, useStoredName } from "@/client/browser-values";

export default function Home() {
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.config().then(setCfg).catch(() => setCfg(null));
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.createGathering({
        title: title.trim() || "Our table",
        displayName: name.trim(),
        hostCode: hostCode || undefined,
        ...langs,
        consent: true,
      });
      rememberName(name.trim());
      router.push(`/g/${res.gatheringId}?invite=1`);
    } catch (err) {
      setError(err instanceof ClientApiError ? err.message : "Could not create the gathering");
      setBusy(false);
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
            <Feature icon={<GroupsIcon />} title="Up to eight people, side conversations">
              Split into private groups — living room and balcony — and come back anytime.
            </Feature>
            <Feature icon={<LockIcon />} title="Private by default">
              Invite-only, nothing recorded, server-enforced privacy between groups.
            </Feature>
          </div>
          <div className="stack rise rise-3">
            <button className="btn btn-primary btn-block" onClick={() => setStep("create")}>
              Start a gathering
            </button>
            <p className="small faint" style={{ textAlign: "center" }}>
              Joining someone? Open their invite link or scan their QR code.
            </p>
          </div>
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
          <h1 className="display h-lg">Start a gathering</h1>
          <p className="muted">You&apos;ll get a link and QR code to share with up to {cfg?.maxHumans ?? 8} people.</p>
        </div>

        <div className="stack">
          <label className="field">
            <span className="field-label">Gathering name</span>
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
          {cfg?.hostCodeRequired !== false && (
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

