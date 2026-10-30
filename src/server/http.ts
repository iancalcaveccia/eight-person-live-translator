import "server-only";
import { isProduction } from "./env";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

/** Wrap a handler so thrown ApiErrors become JSON and nothing internal leaks. */
export function handle<A extends unknown[]>(
  fn: (req: Request, ...args: A) => Promise<Response>,
): (req: Request, ...args: A) => Promise<Response> {
  return async (req: Request, ...args: A) => {
    try {
      return await fn(req, ...args);
    } catch (err) {
      if (err instanceof ApiError) {
        return json({ error: err.code, message: err.message, ...err.extra }, { status: err.status });
      }
      // Log only the error class/message, never request bodies or secrets.
      console.error("[api] unhandled error:", err instanceof Error ? `${err.name}: ${err.message}` : "unknown");
      return json({ error: "internal_error", message: "Something went wrong" }, { status: 500 });
    }
  };
}

const MAX_BODY_BYTES = 16 * 1024;

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  const text = await readText(req);
  if (!text) return {} as T;
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiError(400, "invalid_json", "Body must be a JSON object");
    }
    return parsed as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, "invalid_json", "Body is not valid JSON");
  }
}

export async function readText(req: Request, limit = MAX_BODY_BYTES): Promise<string> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > limit) throw new ApiError(413, "body_too_large");
  const text = await req.text();
  if (text.length > limit) throw new ApiError(413, "body_too_large");
  return text;
}

// -------------------------------------------------------------------- cookies

export function parseCookies(req: Request): Map<string, string> {
  const out = new Map<string, string>();
  const header = req.headers.get("cookie");
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        out.set(k, decodeURIComponent(v));
      } catch {
        out.set(k, v);
      }
    }
  }
  return out;
}

export function sessionCookieName(gatheringId: string): string {
  return `ig_${gatheringId.replace(/-/g, "")}`;
}

export function serializeSessionCookie(gatheringId: string, value: string, maxAgeSeconds: number): string {
  const parts = [
    `${sessionCookieName(gatheringId)}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (isProduction()) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(gatheringId: string): string {
  return serializeSessionCookie(gatheringId, "", 0);
}

// --------------------------------------------------------- request hygiene

/**
 * CSRF defence in depth on top of SameSite=Lax: state-changing browser
 * requests must come from our own origin.
 */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (!origin) {
    // Non-browser clients (tests, curl) omit Origin; cookies still required.
    return;
  }
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ApiError(403, "bad_origin");
  }
  if (!host || originHost !== host) {
    throw new ApiError(403, "bad_origin", "Cross-origin request rejected");
  }
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim().slice(0, 64);
  return req.headers.get("x-real-ip")?.slice(0, 64) ?? "unknown";
}

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export function requireUuid(v: unknown, name = "id"): string {
  if (!isUuid(v)) throw new ApiError(400, "invalid_id", `Invalid ${name}`);
  return v.toLowerCase();
}
