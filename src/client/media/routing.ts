/**
 * Listener-side subscription rules (CONTRACT section 3). Pure functions so the
 * "never hear the same speaker twice" invariant is unit-tested.
 */
import { parseTranslationTrackName } from "@/lib/contract";

export interface SpeakerInfo {
  id: string;
  speakLang: string | undefined; // en|pl|es|auto
}

export interface ListenerPrefs {
  listenLang: string;
  /** Play same-language voices through the headset (default true). */
  nativePassthrough: boolean;
  /** Speakers this listener wants to hear in their original voice. */
  originalFor: ReadonlySet<string>;
  /** Speakers this listener wants a provider comparison track for. */
  compareFor?: ReadonlyMap<string, string>; // speakerId -> provider
}

export type HearingMode = "native" | "translation" | "none";

/** How listener should hear speaker S. */
export function hearingModeFor(speaker: SpeakerInfo, prefs: ListenerPrefs): HearingMode {
  if (prefs.originalFor.has(speaker.id)) return "native";
  const sl = speaker.speakLang;
  if (!sl) return "none";
  if (sl !== "auto" && sl === prefs.listenLang) return prefs.nativePassthrough ? "native" : "none";
  return "translation";
}

/** Should the listener subscribe to speaker S's microphone? */
export function wantsNativeMic(speaker: SpeakerInfo, prefs: ListenerPrefs): boolean {
  return hearingModeFor(speaker, prefs) === "native";
}

/**
 * Should the listener subscribe to this agent-published track?
 * `speakers` are the humans currently in the room.
 */
export function wantsAgentTrack(
  trackName: string,
  speakers: ReadonlyMap<string, SpeakerInfo>,
  prefs: ListenerPrefs,
): boolean {
  const parsed = parseTranslationTrackName(trackName);
  if (!parsed) return false;
  const speaker = speakers.get(parsed.speakerId);
  if (!speaker) return false;
  if (parsed.targetLang !== prefs.listenLang) return false;
  if (parsed.comparison) {
    return prefs.compareFor?.get(parsed.speakerId) === parsed.provider;
  }
  if (prefs.compareFor?.has(parsed.speakerId)) return false; // comparison replaces primary
  return hearingModeFor(speaker, prefs) === "translation";
}
