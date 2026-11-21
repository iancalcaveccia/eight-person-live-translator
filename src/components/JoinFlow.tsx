"use client";

import { useState } from "react";
import type { PersonView } from "@/lib/api-types";
import { flagFor, speakLabel } from "@/lib/languages";
import { BrandGlyph } from "./BrandMark";
import ConsentBox from "./ConsentBox";
import HeadsetCheck from "./HeadsetCheck";
import LanguagePicker, { type LanguageValue } from "./LanguagePicker";
import RememberBox from "./RememberBox";
import { useStoredName } from "@/client/browser-values";

export interface JoinDetails {
  displayName: string;
  langs: LanguageValue;
  remember: boolean;
}

/**
 * Joining someone's table or gathering. New people: name & languages →
 * headset → consent (+ remember me). Remembered people: one tap.
 */
export default function JoinFlow({
  heading,
  intro,
  person,
  onJoin,
  error,
  busy,
}: {
  heading: string;
  intro: React.ReactNode;
  person: PersonView | null;
  onJoin: (d: JoinDetails) => Promise<void>;
  error: string | null;
  busy: boolean;
}) {
  const storedName = useStoredName();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [editedName, setName] = useState<string | null>(null);
  const name = editedName ?? storedName;
  const [langs, setLangs] = useState<LanguageValue>({ speakLang: "pl", listenLang: "pl", esRegion: "" });
  const [consent, setConsent] = useState(false);
  const [remember, setRemember] = useState(true);
  const [checkHeadset, setCheckHeadset] = useState(false);

  if (person) {
    const mine: LanguageValue = { speakLang: person.speakLang, listenLang: person.listenLang, esRegion: person.esRegion };
    return (
      <main className="page">
        <div className="container stack-lg">
          <div className="hero-mark" style={{ width: 44, height: 44, borderRadius: 14 }}>
            <BrandGlyph size={24} />
          </div>
          <div className="stack">
            <h1 className="display h-lg">{heading}</h1>
            <div className="muted">{intro}</div>
          </div>
          <div className="card card-tight row">
            <div className="dot-avatar" style={{ ["--pc" as string]: "var(--c0)" }}>
              {person.displayName.slice(0, 1).toUpperCase()}
            </div>
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{person.displayName}</div>
              <div className="small muted">
                Speaks {flagFor(mine.speakLang, mine.esRegion)} {speakLabel(mine.speakLang, mine.esRegion)} · hears{" "}
                {speakLabel(mine.listenLang)}
              </div>
            </div>
          </div>
          {!person.consentCurrent && <ConsentBox checked={consent} onChange={setConsent} />}
          {checkHeadset ? (
            <HeadsetCheck />
          ) : (
            <button className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => setCheckHeadset(true)}>
              Check my headset first
            </button>
          )}
          {error && <p className="error-text">{error}</p>}
          <button
            className="btn btn-primary btn-block"
            disabled={busy || (!person.consentCurrent && !consent)}
            onClick={() => void onJoin({ displayName: person.displayName, langs: mine, remember: true })}
          >
            {busy ? <span className="spinner" /> : `Join as ${person.displayName}`}
          </button>
          <p className="small faint" style={{ textAlign: "center" }}>
            Not you? Open Mesa&apos;s home screen and choose “Forget me on this phone”.
          </p>
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
              <h1 className="display h-lg">{heading}</h1>
              <div className="muted">{intro}</div>
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
              <p className="muted">Your microphone starts muted. Tap the big button when you want to talk.</p>
            </div>
            <ConsentBox checked={consent} onChange={setConsent} />
            <RememberBox checked={remember} onChange={setRemember} />
            {error && <p className="error-text">{error}</p>}
            <div className="row">
              <button className="btn btn-ghost" onClick={() => setStep(2)}>
                Back
              </button>
              <button
                className="btn btn-primary grow"
                onClick={() => void onJoin({ displayName: name.trim(), langs, remember })}
                disabled={!consent || busy}
              >
                {busy ? <span className="spinner" /> : "Join the table"}
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
