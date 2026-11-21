"use client";

/**
 * Per-device listener preferences (mixing, captions, devices). Stored in
 * localStorage as conveniences only; failures fall back to defaults.
 */
import { useSyncExternalStore } from "react";
import type { MixMode } from "./media/mixer-policy";

export type NoiseMode = "standard" | "krisp" | "voice-focus";
export type MicMode = "open" | "hold";

export interface ListenerSettings {
  mixMode: MixMode;
  focusSpeakerId: string | null;
  translationVolume: number;
  originalVolume: number;
  nativePassthrough: boolean;
  captions: boolean;
  showOriginalCaptions: boolean;
  speakerVolume: Record<string, number>;
  speakerMuted: Record<string, boolean>;
  originalFor: string[];
  micDeviceId: string | null;
  outputDeviceId: string | null;
  noiseMode: NoiseMode;
  micMode: MicMode;
  keepAwake: boolean;
  diagnostics: boolean;
}

export const DEFAULT_SETTINGS: ListenerSettings = {
  mixMode: "natural",
  focusSpeakerId: null,
  translationVolume: 1,
  originalVolume: 1,
  nativePassthrough: true,
  captions: true,
  showOriginalCaptions: false,
  speakerVolume: {},
  speakerMuted: {},
  originalFor: [],
  micDeviceId: null,
  outputDeviceId: null,
  noiseMode: "standard",
  micMode: "open",
  keepAwake: true,
  diagnostics: false,
};

const KEY = "interp.settings.v1";
let current: ListenerSettings = DEFAULT_SETTINGS;
let loaded = false;
const listeners = new Set<() => void>();

function load(): ListenerSettings {
  if (loaded) return current;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) current = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    current = DEFAULT_SETTINGS;
  }
  return current;
}

export function getSettings(): ListenerSettings {
  return typeof window === "undefined" ? DEFAULT_SETTINGS : load();
}

export function updateSettings(patch: Partial<ListenerSettings> | ((s: ListenerSettings) => Partial<ListenerSettings>)) {
  const base = getSettings();
  const next = { ...base, ...(typeof patch === "function" ? patch(base) : patch) };
  current = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private mode / storage blocked: keep in memory only.
  }
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useSettings(): ListenerSettings {
  return useSyncExternalStore(subscribe, getSettings, () => DEFAULT_SETTINGS);
}
