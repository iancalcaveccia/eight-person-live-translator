"use client";

import { useState } from "react";
import { api, ClientApiError } from "@/client/api";
import type { PersonView } from "@/lib/api-types";
import LanguagePicker, { type LanguageValue } from "../LanguagePicker";
import Sheet from "../room/Sheet";

export default function ProfileSheet({ person, onClose, onChanged }: { person: PersonView; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState(person.displayName);
  const [langs, setLangs] = useState<LanguageValue>({ speakLang: person.speakLang, listenLang: person.listenLang, esRegion: person.esRegion });
  const [confirmForget, setConfirmForget] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof ClientApiError ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <Sheet title="You" onClose={onClose}>
      <div className="sheet-section">
        <label className="field">
          <span className="field-label">Your name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="given-name" />
        </label>
        <LanguagePicker value={langs} onChange={setLangs} compact />
        {error && <p className="error-text">{error}</p>}
        <button
          className="btn btn-primary btn-block"
          disabled={busy || !name.trim()}
          onClick={() => void act(() => api.editProfile({ displayName: name.trim(), ...langs }))}
        >
          Save
        </button>
      </div>

      <div className="sheet-section">
        <span className="section-label">Forget me</span>
        {confirmForget ? (
          <div className="stack">
            <p className="small">
              Deletes your name and languages from Mesa and takes you off all your tables. This phone will ask for your
              name again. A table link brings you back any time.
            </p>
            <div className="row">
              <button className="btn btn-ghost grow" onClick={() => setConfirmForget(false)}>
                Cancel
              </button>
              <button className="btn btn-danger grow" disabled={busy} onClick={() => void act(() => api.forgetMe(true))}>
                Forget me
              </button>
            </div>
          </div>
        ) : (
          <button className="btn btn-ghost btn-block danger-text" onClick={() => setConfirmForget(true)}>
            Forget me on Mesa
          </button>
        )}
      </div>
    </Sheet>
  );
}
