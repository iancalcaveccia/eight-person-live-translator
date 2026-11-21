"use client";

import { useState } from "react";
import { LinkIcon } from "../icons";

/**
 * Open an invite link inside Mesa. Useful in the home-screen app on iPhone,
 * where links from WhatsApp open in Safari instead of the app.
 */
export default function PasteLink() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function open(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const u = new URL(value.trim(), window.location.origin);
      if (!/^\/(t|g)\/[0-9a-f-]{36}\/join$/i.test(u.pathname) || !/(^#|&)k=[A-Za-z0-9_-]{16,64}/.test(u.hash)) throw new Error("bad");
      // Full navigation so the join page reads the token from the fragment.
      window.location.assign(u.pathname + u.hash);
    } catch {
      setError("That doesn't look like a Mesa invite link.");
    }
  }

  return (
    <form className="stack paste-link" onSubmit={open}>
      <label className="field">
        <span className="field-label">Got an invite link?</span>
        <span className="row">
          <input
            className="input grow"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Paste it here"
            inputMode="url"
            autoComplete="off"
            aria-label="Invite link"
          />
          <button className="btn btn-secondary" disabled={!value.trim()} aria-label="Open invite link">
            <LinkIcon width={18} height={18} /> Open
          </button>
        </span>
      </label>
      {error && <p className="error-text">{error}</p>}
    </form>
  );
}
