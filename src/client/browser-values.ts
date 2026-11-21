"use client";

/**
 * Browser-only values read through useSyncExternalStore so server-rendered
 * HTML and the first client render match (no hydration mismatch); the real
 * value appears right after hydration.
 */
import { useSyncExternalStore } from "react";

const subscribeNever = () => () => {};

const NAME_KEY = "interp.lastName";

function readInviteToken(): string {
  const m = /(?:^|[#&])k=([A-Za-z0-9_-]{16,64})/.exec(window.location.hash);
  return m ? m[1] : "";
}

/** Invite token from the URL fragment; `null` until hydrated. */
export function useInviteToken(): string | null {
  return useSyncExternalStore(subscribeNever, readInviteToken, () => null);
}

function readStoredName(): string {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Last display name used on this device ("" on the server). */
export function useStoredName(): string {
  return useSyncExternalStore(subscribeNever, readStoredName, () => "");
}

export function rememberName(name: string): void {
  try {
    window.localStorage.setItem(NAME_KEY, name);
  } catch {
    /* storage blocked */
  }
}
