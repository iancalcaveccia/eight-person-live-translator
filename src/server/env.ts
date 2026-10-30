/**
 * Server-only configuration. Never import this from a client component.
 *
 * Every secret here is read from the process environment at call time so that
 * tests can override values and so nothing is inlined into a client bundle.
 */
import "server-only";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }
  return n;
}

function str(name: string): string | undefined {
  const raw = process.env[name];
  return raw && raw.trim() !== "" ? raw.trim() : undefined;
}

/** True when running on Vercel (preview or production). */
export function isHostedDeployment(): boolean {
  return process.env.VERCEL === "1" || process.env.VERCEL_ENV !== undefined;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export const config = {
  get livekitUrl() {
    return str("LIVEKIT_URL");
  },
  get livekitApiKey() {
    return str("LIVEKIT_API_KEY");
  },
  get livekitApiSecret() {
    return str("LIVEKIT_API_SECRET");
  },
  get databaseUrl() {
    return str("DATABASE_URL");
  },
  /** Shared secret for worker -> control plane HMAC calls. */
  get internalApiSecret() {
    return str("INTERNAL_API_SECRET");
  },
  /** Secret used to derive invite tokens. Falls back to a DB-stored random value in local dev. */
  get appSecret() {
    return str("APP_SECRET");
  },
  /** Passcode required to create a gathering. Required on hosted deployments. */
  get hostAccessCode() {
    return str("HOST_ACCESS_CODE");
  },
  get cronSecret() {
    return str("CRON_SECRET");
  },
  get publicAppUrl() {
    return str("NEXT_PUBLIC_APP_URL");
  },
  get maxHumans() {
    return Math.min(8, Math.max(2, num("GATHERING_MAX_HUMANS", 8)));
  },
  get maxGatheringMinutes() {
    return num("MAX_GATHERING_SESSION_MINUTES", 360);
  },
  /** Gathering ends automatically after this many minutes with nobody online. */
  get idleEndMinutes() {
    return num("GATHERING_IDLE_END_MINUTES", 30);
  },
  get maxSpendPerGatheringUsd() {
    return num("MAX_AI_SPEND_PER_GATHERING_USD", 50);
  },
  get maxSpendDailyUsd() {
    const v = str("MAX_AI_SPEND_DAILY_USD");
    return v === undefined ? undefined : num("MAX_AI_SPEND_DAILY_USD", 0);
  },
  get maxSpendMonthlyUsd() {
    return num("MAX_AI_SPEND_MONTHLY_USD", 200);
  },
  /** Fraction of a cap at which clients see a warning. */
  get spendWarningRatio() {
    return num("AI_SPEND_WARNING_RATIO", 0.8);
  },
  get defaultProvider(): "gemini" | "openai" | "mock" {
    const v = str("TRANSLATION_PROVIDER") ?? "gemini";
    return v === "openai" || v === "mock" ? v : "gemini";
  },
  /** LiveKit token lifetime. Only governs joining; LiveKit refreshes tokens for connected clients. */
  get mediaTokenTtlSeconds() {
    return num("MEDIA_TOKEN_TTL_SECONDS", 600);
  },
  rates: {
    get geminiInputUsdPerMin() {
      return num("GEMINI_INPUT_USD_PER_MIN", 0.0053);
    },
    get geminiOutputUsdPerMin() {
      return num("GEMINI_OUTPUT_USD_PER_MIN", 0.0315);
    },
    get openaiUsdPerMin() {
      return num("OPENAI_TRANSLATE_USD_PER_MIN", 0.034);
    },
  },
};

export const CONSENT_VERSION = "2026-10-30";

/** Dispatch name; must match translator/src/agent.py. */
export const TRANSLATOR_AGENT_NAME = "gemini-translator";
