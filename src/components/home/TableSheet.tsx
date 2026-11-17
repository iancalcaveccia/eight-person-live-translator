"use client";

import { useState } from "react";
import { api, ClientApiError } from "@/client/api";
import type { PersonView, TableView } from "@/lib/api-types";
import { flagFor } from "@/lib/languages";
import { ShareIcon } from "../icons";
import Sheet from "../room/Sheet";
import { colorFor } from "./colors";

/** Manage a saved table: its people, its link, its name; leave it. */
export default function TableSheet({
  table,
  me,
  onClose,
  onChanged,
}: {
  table: TableView;
  me: PersonView;
  onClose: () => void;
  onChanged: () => void;
}) {
  const owner = table.role === "owner";
  const [name, setName] = useState(table.name);
  const [path, setPath] = useState(table.inviteUrlPath);
  const [confirm, setConfirm] = useState<null | "leave" | { remove: string }>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = typeof window === "undefined" ? path : `${window.location.origin}${path}`;

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof ClientApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    const data = { title: `Join “${table.name}” on Mesa`, text: "Live interpretation: everyone speaks their own language", url };
    if (navigator.share) await navigator.share(data).catch(() => undefined);
    else await copy();
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked */
    }
  }

  const removing = typeof confirm === "object" && confirm !== null ? table.members.find((m) => m.id === confirm.remove) : undefined;

  return (
    <Sheet title={table.name} onClose={onClose}>
      <div className="sheet-section">
        <span className="section-label">People ({table.members.length})</span>
        <ul className="people-list">
          {table.members.map((m) => (
            <li key={m.id} className="contact">
              <span className="dot-avatar" style={{ ["--pc" as string]: colorFor(m.id) }}>
                {m.displayName.slice(0, 1).toUpperCase()}
              </span>
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="contact-name">
                  {m.displayName} {m.isMe && <span className="faint">(you)</span>}
                </span>
                <span className="small muted contact-sub">
                  {flagFor(m.speakLang)} {m.role === "owner" ? "· looks after this table" : ""}
                </span>
              </span>
              {owner && !m.isMe && (
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirm({ remove: m.id })}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
        {removing && (
          <div className="stack notice">
            <span>
              Remove <strong>{removing.displayName}</strong>? They leave the conversation now, and the table gets a new link so the old one
              can&apos;t bring them back.
            </span>
            <div className="row">
              <button className="btn btn-ghost btn-sm grow" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger btn-sm grow"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const r = await api.removeFromTable(table.id, removing.id);
                    if (r.inviteUrlPath) setPath(r.inviteUrlPath);
                    setConfirm(null);
                  })
                }
              >
                Remove
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="sheet-section">
        <span className="section-label">Invite someone new</span>
        <div className="link-box">{url}</div>
        <div className="row">
          <button className="btn btn-primary grow" onClick={() => void share()}>
            <ShareIcon width={18} height={18} /> Share
          </button>
          <button className="btn btn-secondary grow" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
        <p className="small faint">Whoever opens it joins this table. Treat it like a key.</p>
        {owner && (
          <button
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const r = await api.rotateTableLink(table.id);
                setPath(r.inviteUrlPath);
              })
            }
          >
            Replace link (the old one stops working)
          </button>
        )}
      </div>

      {owner && (
        <div className="sheet-section">
          <label className="field">
            <span className="field-label">Table name</span>
            <span className="row">
              <input className="input grow" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
              <button
                className="btn btn-secondary"
                disabled={busy || !name.trim() || name.trim() === table.name}
                onClick={() => void act(() => api.renameTable(table.id, name.trim()).then(() => undefined))}
              >
                Rename
              </button>
            </span>
          </label>
        </div>
      )}

      <div className="sheet-section">
        {error && <p className="error-text">{error}</p>}
        {confirm === "leave" ? (
          <div className="stack">
            <p className="small">
              “{table.name}” disappears from your home screen. {table.members.length === 1 ? "You're the last one, so the table is deleted." : "The others keep it."}
            </p>
            <div className="row">
              <button className="btn btn-ghost grow" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger grow"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api.removeFromTable(table.id, me.id);
                    onClose();
                  })
                }
              >
                Leave table
              </button>
            </div>
          </div>
        ) : (
          <button className="btn btn-ghost btn-block danger-text" onClick={() => setConfirm("leave")}>
            Leave this table
          </button>
        )}
      </div>
    </Sheet>
  );
}
