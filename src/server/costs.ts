import "server-only";
import { config } from "./env";

export interface UsageNumbers {
  provider: string;
  inputSeconds: number;
  outputSeconds: number;
  sessionSeconds: number;
}

/**
 * Estimated provider cost for one usage record (CONTRACT section 7).
 * List prices checked 2026-10-30; this is a meter, not an invoice.
 */
export function estimateCostUsd(u: UsageNumbers): number {
  const r = config.rates;
  switch (u.provider) {
    case "gemini":
      return (u.inputSeconds / 60) * r.geminiInputUsdPerMin + (u.outputSeconds / 60) * r.geminiOutputUsdPerMin;
    case "openai":
      return (u.sessionSeconds / 60) * r.openaiUsdPerMin;
    default:
      return 0;
  }
}
