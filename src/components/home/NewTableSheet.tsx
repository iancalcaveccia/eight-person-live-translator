"use client";

import { useEffect, useState } from "react";
import { api, ClientApiError } from "@/client/api";
import type { ContactView } from "@/lib/api-types";
import { flagFor } from "@/lib/languages";
import Sheet from "../room/Sheet";

export default function NewTableSheet({
  people,
  onClose,
  onCreated,
}: {
  people: ContactView[];
  onClose: () => void;
  onCreated: (gatheringId: string) => void;
}) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [hostCode, setHostCode] = useState("");
  const [codeNeeded, setCodeNeeded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .config()
      .then((c) => setCodeNeeded(c.hostCodeRequired))
      .catch(() => undefined);
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.createTable(name.trim() || "Our table", [...picked], hostCode || undefined);
      onCreated(r.gatheringId);
    } catch (err) {
      setError(err instanceof ClientApiError ? err.message : "Could not create the table");
      setBusy(false);
    }
  }

  return (
    <Sheet title="New table" onClose={onClose}>
      <form className="stack" onSubmit={create}>
        <label className="field">
          <span className="field-label">Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Family dinner" maxLength={60} autoFocus />
        </label>
        {people.length > 0 && (
          <fieldset className="stack" style={{ border: 0 }}>
            <legend className="field-label" style={{ marginBottom: 8 }}>
              Who&apos;s at it? (optional)
            </legend>
            {people.map((p) => (
              <label key={p.id} className="check pick-row">
                <input
                  type="checkbox"
                  checked={picked.has(p.id)}
                  onChange={(e) =>
                    setPicked((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(p.id);
                      else n.delete(p.id);
                      return n;
                    })
                  }
                />
                <span>
                  {p.displayName} <span className="faint">{flagFor(p.speakLang)}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {codeNeeded && (
          <label className="field">
            <span className="field-label">Host access code</span>
            <input className="input" type="password" autoComplete="off" value={hostCode} onChange={(e) => setHostCode(e.target.value)} />
          </label>
        )}
        <p className="small faint">You&apos;ll get a link to invite anyone else. People you pick here see the table on their home screen.</p>
        {error && <p className="error-text">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? <span className="spinner" /> : "Create & sit down"}
        </button>
      </form>
    </Sheet>
  );
}
