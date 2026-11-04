import "server-only";
import { isEsRegion, isListenLang, isSpeakLang, type EsRegion, type ListenLang, type SpeakLang } from "@/lib/languages";
import { ApiError } from "./http";

// Control characters (including bidi overrides) are stripped from names.
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

export function cleanText(v: unknown, field: string, max: number, min = 1): string {
  if (typeof v !== "string") throw new ApiError(400, "invalid_input", `${field} is required`);
  const s = v.replace(CONTROL, "").replace(/\s+/g, " ").trim();
  if (s.length < min) throw new ApiError(400, "invalid_input", `${field} is required`);
  if (s.length > max) throw new ApiError(400, "invalid_input", `${field} must be at most ${max} characters`);
  return s;
}

export interface LanguagePrefs {
  speakLang: SpeakLang;
  listenLang: ListenLang;
  esRegion: EsRegion;
}

export function parseLanguagePrefs(body: Record<string, unknown>): LanguagePrefs {
  const { speakLang, listenLang } = body;
  const esRegion = body.esRegion ?? "";
  if (!isSpeakLang(speakLang)) throw new ApiError(400, "invalid_input", "speakLang must be en, pl, es or auto");
  if (!isListenLang(listenLang)) throw new ApiError(400, "invalid_input", "listenLang must be en, pl or es");
  if (!isEsRegion(esRegion)) throw new ApiError(400, "invalid_input", "esRegion must be es-AR, es-CO, es-ES or empty");
  return { speakLang, listenLang, esRegion };
}

export function parsePartialPrefs(body: Record<string, unknown>): Partial<LanguagePrefs> {
  const out: Partial<LanguagePrefs> = {};
  if (body.speakLang !== undefined) {
    if (!isSpeakLang(body.speakLang)) throw new ApiError(400, "invalid_input", "invalid speakLang");
    out.speakLang = body.speakLang;
  }
  if (body.listenLang !== undefined) {
    if (!isListenLang(body.listenLang)) throw new ApiError(400, "invalid_input", "invalid listenLang");
    out.listenLang = body.listenLang;
  }
  if (body.esRegion !== undefined) {
    if (!isEsRegion(body.esRegion)) throw new ApiError(400, "invalid_input", "invalid esRegion");
    out.esRegion = body.esRegion;
  }
  return out;
}

export function requireConsent(body: Record<string, unknown>): void {
  if (body.consent !== true) {
    throw new ApiError(
      400,
      "consent_required",
      "You must agree to live AI processing of your microphone audio before joining",
    );
  }
}
