"use client";

import { useState, useSyncExternalStore } from "react";
import { promptInstall, useInstallState } from "@/client/install";
import { CloseIcon, HomeAddIcon } from "./icons";

const DISMISS_KEY = "mesa.installHidden";
const noop = () => () => {};

function readHidden(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * "Add Mesa to your home screen": the browser's own dialog on Android/Chrome,
 * the Share-sheet steps on iPhone. Hidden once installed (or dismissed, unless
 * `always`, as in Settings).
 */
export default function InstallCard({ always = false }: { always?: boolean }) {
  const state = useInstallState();
  const storedHidden = useSyncExternalStore(noop, readHidden, () => true);
  const [hiddenNow, setHiddenNow] = useState(false);
  const [busy, setBusy] = useState(false);

  if (state === "unknown") return null;
  if (state === "installed") {
    return always ? <p className="small muted">✓ Mesa is on your home screen.</p> : null;
  }
  if (!always && (storedHidden || hiddenNow)) return null;

  const hide = () => {
    setHiddenNow(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* storage blocked */
    }
  };

  return (
    <div className="install-card" role="note">
      <div className="install-icon">
        <HomeAddIcon />
      </div>
      <div className="grow">
        <div className="install-title">Put Mesa on your home screen</div>
        {state === "prompt" && (
          <>
            <div className="small muted">It opens full screen like an app. No app store needed.</div>
            <button
              className="btn btn-primary btn-sm install-btn"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await promptInstall();
                setBusy(false);
              }}
            >
              Add to home screen
            </button>
          </>
        )}
        {state === "ios" && (
          <div className="small muted">
            In Safari, tap <strong>Share</strong> <span aria-hidden>(□↑)</span>, then <strong>Add to Home Screen</strong>.
            Do it after you&apos;ve joined, so the app remembers you.
          </div>
        )}
        {state === "manual" && (
          <div className="small muted">
            Open the browser menu <span aria-hidden>(⋮)</span> and choose <strong>Add to Home screen</strong> or{" "}
            <strong>Install app</strong>.
          </div>
        )}
      </div>
      {!always && (
        <button className="icon-btn icon-btn-sm" aria-label="Hide" onClick={hide}>
          <CloseIcon width={16} height={16} />
        </button>
      )}
    </div>
  );
}
