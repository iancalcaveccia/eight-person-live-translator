"use client";

import { ES_REGIONS, LANGUAGES, type EsRegion, type ListenLang, type SpeakLang } from "@/lib/languages";

export interface LanguageValue {
  speakLang: SpeakLang;
  listenLang: ListenLang;
  esRegion: EsRegion;
}

export default function LanguagePicker({
  value,
  onChange,
  compact = false,
}: {
  value: LanguageValue;
  onChange: (v: LanguageValue) => void;
  compact?: boolean;
}) {
  const showRegion = value.speakLang === "es" || value.listenLang === "es";

  function setSpeak(speakLang: SpeakLang) {
    // Most people want to hear the language they speak; keep them in sync
    // until the user picks a listening language explicitly.
    const synced = value.listenLang === value.speakLang;
    const listenLang: ListenLang = synced && speakLang !== "auto" ? speakLang : value.listenLang;
    onChange({ ...value, speakLang, listenLang });
  }

  return (
    <div className="stack">
      <div className="field">
        <span className="field-label">I speak</span>
        <div className="chips" role="group" aria-label="Language I speak">
          {LANGUAGES.map((l) => (
            <button
              key={l.code}
              type="button"
              className="chip"
              aria-pressed={value.speakLang === l.code}
              onClick={() => setSpeak(l.code)}
            >
              <span className="flag">{l.flag}</span>
              {l.native}
            </button>
          ))}
          <button
            type="button"
            className="chip"
            aria-pressed={value.speakLang === "auto"}
            onClick={() => setSpeak("auto")}
            title="Detects the language as you talk. Everyone hears you through the interpreter voice."
          >
            <span className="flag">🌐</span>I switch languages
          </button>
        </div>
        {value.speakLang === "auto" && !compact && (
          <p className="small faint">
            Auto-detect lets you switch languages mid-conversation. Everyone (even same-language guests) hears you
            through the AI voice, and nearby voices are slightly more likely to be picked up.
          </p>
        )}
      </div>

      <div className="field">
        <span className="field-label">I want to hear everyone in</span>
        <div className="chips" role="group" aria-label="Language I want to hear">
          {LANGUAGES.map((l) => (
            <button
              key={l.code}
              type="button"
              className="chip"
              aria-pressed={value.listenLang === l.code}
              onClick={() => onChange({ ...value, listenLang: l.code })}
            >
              <span className="flag">{l.flag}</span>
              {l.native}
            </button>
          ))}
        </div>
      </div>

      {showRegion && (
        <div className="field">
          <span className="field-label">Spanish preference</span>
          <div className="chips" role="group" aria-label="Spanish regional preference">
            {ES_REGIONS.map((r) => (
              <button
                key={r.code}
                type="button"
                className="chip"
                aria-pressed={value.esRegion === r.code}
                onClick={() => onChange({ ...value, esRegion: r.code })}
              >
                <span className="flag">{r.flag}</span>
                {r.name}
              </button>
            ))}
            <button
              type="button"
              className="chip"
              aria-pressed={value.esRegion === ""}
              onClick={() => onChange({ ...value, esRegion: "" })}
            >
              Any
            </button>
          </div>
          {!compact && (
            <p className="small faint">
              Shown to others and used for testing. The live translation models only offer one Spanish voice, so
              they can&apos;t yet produce a specific Argentine, Colombian or Castilian accent.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
