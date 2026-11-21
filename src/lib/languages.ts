/**
 * Languages this product supports. Deliberately limited to the three the
 * gathering needs; every pair among them is supported by Gemini 3.5 Live
 * Translate. OpenAI gpt-realtime-translate cannot output Polish (see
 * docs/architecture/PROVIDERS.md), so it can only back up `en`/`es` targets.
 */

export type ListenLang = "en" | "pl" | "es";
export type SpeakLang = ListenLang | "auto";
export type EsRegion = "" | "es-AR" | "es-CO" | "es-ES";

export interface LanguageInfo {
  code: ListenLang;
  name: string;
  native: string;
  flag: string;
}

export const LANGUAGES: LanguageInfo[] = [
  { code: "en", name: "English", native: "English", flag: "🇬🇧" },
  { code: "pl", name: "Polish", native: "Polski", flag: "🇵🇱" },
  { code: "es", name: "Spanish", native: "Español", flag: "🇪🇸" },
];

export const ES_REGIONS: { code: Exclude<EsRegion, "">; name: string; flag: string }[] = [
  { code: "es-AR", name: "Argentina", flag: "🇦🇷" },
  { code: "es-CO", name: "Colombia", flag: "🇨🇴" },
  { code: "es-ES", name: "España", flag: "🇪🇸" },
];

export const LISTEN_LANGS: ListenLang[] = ["en", "pl", "es"];
export const SPEAK_LANGS: SpeakLang[] = ["en", "pl", "es", "auto"];

export function isListenLang(v: unknown): v is ListenLang {
  return v === "en" || v === "pl" || v === "es";
}

export function isSpeakLang(v: unknown): v is SpeakLang {
  return isListenLang(v) || v === "auto";
}

export function isEsRegion(v: unknown): v is EsRegion {
  return v === "" || v === "es-AR" || v === "es-CO" || v === "es-ES";
}

export function languageInfo(code: string | undefined): LanguageInfo | undefined {
  return LANGUAGES.find((l) => l.code === code);
}

export function speakLabel(code: string | undefined, region?: string): string {
  if (code === "auto") return "Auto-detect";
  const info = languageInfo(code);
  if (!info) return "Unknown";
  if (code === "es" && region) {
    const r = ES_REGIONS.find((x) => x.code === region);
    if (r) return `${info.native} (${r.name})`;
  }
  return info.native;
}

export function flagFor(code: string | undefined, region?: string): string {
  if (code === "auto") return "🌐";
  if (code === "es" && region) {
    const r = ES_REGIONS.find((x) => x.code === region);
    if (r) return r.flag;
  }
  return languageInfo(code)?.flag ?? "🌐";
}
