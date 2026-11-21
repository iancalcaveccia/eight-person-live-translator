/**
 * Shared names from docs/architecture/CONTRACT.md. Keep in sync with
 * translator/src/config.py.
 */

export const ATTR = {
  version: "interp.v",
  speakLang: "speak_lang",
  listenLang: "listen_lang",
  esRegion: "es_region",
  role: "role",
  color: "color",
  gatheringId: "gathering_id",
  groupId: "group_id",
  epoch: "epoch",
  agentStatus: "interp.status",
} as const;

export const TOPIC = {
  captions: "lk.translation",
  events: "interp.events",
  control: "interp.control",
} as const;

export const TRANSLATION_TRACK_PREFIX = "tx:";
export const COMPARISON_TRACK_PREFIX = "txc:";

export interface ParsedTranslationTrack {
  speakerId: string;
  targetLang: string;
  provider?: string;
  comparison: boolean;
}

export function parseTranslationTrackName(name: string): ParsedTranslationTrack | null {
  if (name.startsWith(TRANSLATION_TRACK_PREFIX)) {
    const parts = name.slice(TRANSLATION_TRACK_PREFIX.length).split(":");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return { speakerId: parts[0], targetLang: parts[1], comparison: false };
  }
  if (name.startsWith(COMPARISON_TRACK_PREFIX)) {
    const parts = name.slice(COMPARISON_TRACK_PREFIX.length).split(":");
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
    return { speakerId: parts[0], targetLang: parts[1], provider: parts[2], comparison: true };
  }
  return null;
}

export function translationTrackName(speakerId: string, targetLang: string): string {
  return `${TRANSLATION_TRACK_PREFIX}${speakerId}:${targetLang}`;
}

/** Worker events on topic `interp.events` (CONTRACT 5.2). */
export type WorkerEvent =
  | { t: "onset"; speaker: string; ts: number }
  | {
      t: "first_audio";
      speaker: string;
      target: string;
      provider: string;
      latencyMs: number;
    }
  | {
      t: "session";
      speaker: string;
      target: string;
      provider: string;
      state: "connecting" | "live" | "delayed" | "reconnecting" | "error" | "stopped";
      backlogMs?: number;
      reason?: string | null;
    }
  | { t: "budget"; state: "ok" | "warning" | "exceeded"; reason?: string | null }
  | {
      t: "stats";
      sessions: {
        speaker: string;
        target: string;
        provider: string;
        firstAudioP50Ms?: number | null;
        firstAudioP95Ms?: number | null;
        backlogMs?: number;
        stalls?: number;
        droppedMs?: number;
      }[];
    };

/** Control-plane nudges on topic `interp.control` (CONTRACT 5.3). */
export type ControlEvent = { t: "refresh" } | { t: "moved"; groupId: string } | { t: "ended" };
