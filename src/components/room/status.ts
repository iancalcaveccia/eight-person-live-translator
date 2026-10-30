import type { MediaSnapshot } from "@/client/media/session";
import { hearingModeFor } from "@/client/media/routing";
import type { ListenerSettings } from "@/client/prefs";

export interface StatusView {
  tone: "live" | "warn" | "err" | "neutral";
  label: string;
  detail?: string;
}

/** Cold start on LiveKit's free plan can take 10–20 s; beyond this, say so honestly. */
export const INTERPRETER_MISSING_MS = 25_000;

/** The compact "Live / ~N s behind / Delayed / Reconnecting" status (spec 02). */
export function computeStatus(
  s: MediaSnapshot,
  settings: ListenerSettings,
  listenLang: string,
  translationAllowed: boolean,
  latencyP50: number | null,
  nowMs: number = typeof performance === "undefined" ? 0 : performance.now(),
): StatusView {
  switch (s.status) {
    case "idle":
    case "connecting":
      return { tone: "warn", label: "Connecting…" };
    case "switching":
      return { tone: "warn", label: "Switching…" };
    case "reconnecting":
    case "offline":
      return { tone: "err", label: "Reconnecting…", detail: s.error ?? undefined };
    case "failed":
      return { tone: "err", label: "Unavailable", detail: s.error ?? undefined };
    case "replaced":
      return { tone: "neutral", label: "Open elsewhere" };
    case "ended":
    case "kicked":
      return { tone: "neutral", label: "Ended" };
    default:
      break;
  }
  const prefs = { listenLang, nativePassthrough: settings.nativePassthrough, originalFor: new Set(settings.originalFor) };
  const needsTranslation = s.humans.some((h) => hearingModeFor({ id: h.id, speakLang: h.speakLang }, prefs) === "translation");
  if (!needsTranslation) {
    return s.humans.length === 0
      ? { tone: "neutral", label: "Waiting for others" }
      : { tone: "live", label: "Live", detail: "Everyone here speaks your language" };
  }
  if (!translationAllowed || s.budgetState === "exceeded") {
    return { tone: "err", label: "Translation paused", detail: "Spending limit reached" };
  }
  if (!s.agentPresent) {
    const waited = s.connectedAt === null ? 0 : nowMs - s.connectedAt;
    if (waited > INTERPRETER_MISSING_MS) {
      return {
        tone: "err",
        label: "Interpreter unavailable",
        detail: "The translation service has not joined. It may be busy or offline; captions and translation will start when it does.",
      };
    }
    return { tone: "warn", label: "Starting interpreter…" };
  }
  const mine = Object.values(s.translation).filter((t) => t.target === listenLang);
  if (mine.some((t) => t.state === "reconnecting" || t.state === "error")) {
    return { tone: "warn", label: "Interpreter reconnecting" };
  }
  if (mine.some((t) => t.state === "delayed")) return { tone: "warn", label: "Delayed" };
  if (latencyP50 !== null) return { tone: "live", label: `Live · ~${(latencyP50 / 1000).toFixed(1)} s behind` };
  return { tone: "live", label: "Live" };
}
