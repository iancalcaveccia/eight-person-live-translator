"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ClientApiError } from "@/client/api";
import { BrandGlyph } from "@/components/BrandMark";
import ConsentBox from "@/components/ConsentBox";
import HeadsetCheck from "@/components/HeadsetCheck";
import LanguagePicker, { type LanguageValue } from "@/components/LanguagePicker";
import { rememberName, useInviteToken, useStoredName } from "@/client/browser-values";

export default function JoinPage({ params }: { params: Promise<{ gid: string }> }) {
  const { gid } = use(params);
  const router = useRouter();
  const inviteToken = useInviteToken();
  const storedName = useStoredName();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [editedName, setName] = useState<string | null>(null);
  const name = editedName ?? storedName;
  const [langs, setLangs] = useState<LanguageValue>({ speakLang: "pl", listenLang: "pl", esRegion: "" });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already joined on this device? Go straight back in.
  useEffect(() => {
    let cancelled = false;
    api
      .state(gid)
      .then(() => !cancelled && router.replace(`/g/${gid}`))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [gid, router]);

  async function join() {
    setBusy(true);
    setError(null);
    try {
      await api.join(gid, { inviteToken: inviteToken ?? "", displayName: name.trim(), ...langs, consent: true });
      rememberName(name.trim());
      router.replace(`/g/${gid}`);
    } catch (err) {
      setError(err instanceof ClientApiError ? err.message : "Could not join");
      setBusy(false);
    }
  }

  if (inviteToken === null) {
    return (
      <main className="full-center">
        <div className="spinner" />
      </main>
    );
  }

  if (!inviteToken) {
    return (
      <main className="full-center">
        <div className="container stack">
          <h1 className="display h-md">This link is incomplete</h1>
          <p className="muted">Ask the host to share the invite link again, or scan their QR code.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="container stack-lg">
        <div className="row">
          <div className="hero-mark" style={{ width: 44, height: 44, borderRadius: 14 }}>
            <BrandGlyph size={24} />
          </div>
          <div className="steps grow" aria-label={`Step ${step} of 3`}>
            {[1, 2, 3].map((n) => (
              <span key={n} data-on={n <= step} />
            ))}
          </div>
        </div>

        {step === 1 && (
          <form
            className="stack-lg rise"
            onSubmit={(e) => {
              e.preventDefault();
              setStep(2);
            }}
          >
            <div className="stack">
              <h1 className="display h-lg">You&apos;re invited</h1>
              <p className="muted">Tell the table who you are and which languages you use.</p>
            </div>
            <label className="field">
              <span className="field-label">Your name</span>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Kasia"
                maxLength={40}
                required
                autoComplete="given-name"
              />
            </label>
            <LanguagePicker value={langs} onChange={setLangs} />
            <button className="btn btn-primary btn-block" disabled={!name.trim()}>
              Continue
            </button>
          </form>
        )}

        {step === 2 && (
          <div className="stack-lg rise">
            <div className="stack">
              <h1 className="display h-lg">Your headset</h1>
              <p className="muted">
                Wear your Bluetooth headset. A microphone close to your mouth helps the interpreter hear you — and not
                your neighbours.
              </p>
            </div>
            <HeadsetCheck />
            <div className="row">
              <button className="btn btn-ghost" onClick={() => setStep(1)}>
                Back
              </button>
              <button className="btn btn-primary grow" onClick={() => setStep(3)}>
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="stack-lg rise">
            <div className="stack">
              <h1 className="display h-lg">One last thing</h1>
              <p className="muted">Keep this screen open while you talk. Your microphone starts muted.</p>
            </div>
            <ConsentBox checked={consent} onChange={setConsent} />
            {error && <p className="error-text">{error}</p>}
            <div className="row">
              <button className="btn btn-ghost" onClick={() => setStep(2)}>
                Back
              </button>
              <button className="btn btn-primary grow" onClick={join} disabled={!consent || busy}>
                {busy ? <span className="spinner" /> : "Join the table"}
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
