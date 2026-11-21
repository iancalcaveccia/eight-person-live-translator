"use client";

/**
 * "Add Mesa to your home screen". Android/Chrome fires `beforeinstallprompt`
 * (captured early by an inline script in the root layout, before React
 * hydrates); iPhone has no prompt API, so the UI shows the Share-sheet steps.
 */
import { useSyncExternalStore } from "react";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

declare global {
  interface Window {
    __mesaInstall?: InstallPromptEvent | null;
  }
}

export type InstallState = "installed" | "prompt" | "ios" | "manual" | "unknown";

const listeners = new Set<() => void>();
let wired = false;

function emit() {
  for (const l of listeners) l();
}

function wire() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("mesa-install", emit);
  window.addEventListener("appinstalled", () => {
    window.__mesaInstall = null;
    emit();
  });
  try {
    window.matchMedia("(display-mode: standalone)").addEventListener("change", emit);
  } catch {
    /* old browsers */
  }
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) return true;
  } catch {
    /* ignore */
  }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function read(): InstallState {
  if (isStandalone()) return "installed";
  if (window.__mesaInstall) return "prompt";
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (iOS) return "ios";
  return /Android|Mobile/.test(ua) ? "manual" : "unknown";
}

function subscribe(cb: () => void) {
  wire();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribe, read, () => "unknown");
}

/** Show the browser's own install dialog (Android/Chrome). Returns true if the person accepted. */
export async function promptInstall(): Promise<boolean> {
  const ev = window.__mesaInstall;
  if (!ev) return false;
  window.__mesaInstall = null;
  emit();
  try {
    await ev.prompt();
    const choice = await ev.userChoice;
    return choice.outcome === "accepted";
  } catch {
    return false;
  }
}
