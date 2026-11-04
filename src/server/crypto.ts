import "server-only";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Cryptographically random lowercase base32 string. */
export function randomBase32(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += BASE32[bytes[i] & 31];
  return out;
}

export function newId(): string {
  return randomUUID();
}

/** LiveKit room name for a group: random, never derived from user input. */
export function newRoomName(): string {
  return `grp_${randomBase32(24)}`;
}

/** 256-bit session secret for the participant cookie. */
export function newSessionSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still burn comparable time; avoid early-exit timing differences.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

/**
 * Invite token for a gathering, derived (not stored) so any admitted member
 * can re-share the link and the host can rotate it by bumping the version.
 */
export function deriveInviteToken(appSecret: string, gatheringId: string, version: number): string {
  return createHmac("sha256", appSecret)
    .update(`invite:v1:${gatheringId}:${version}`)
    .digest("base64url")
    .slice(0, 32);
}

// ---------------------------------------------------- internal API signatures

export const SIGNATURE_HEADER = "x-interp-signature";
export const TIMESTAMP_HEADER = "x-interp-timestamp";
export const MAX_CLOCK_SKEW_SECONDS = 120;

export function signInternalRequest(secret: string, timestamp: string, rawBody: string): string {
  return `v1=${hmacHex(secret, `${timestamp}.${rawBody}`)}`;
}

export function verifyInternalRequest(
  secret: string,
  timestamp: string | null,
  signature: string | null,
  rawBody: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!timestamp || !signature || !/^\d{9,12}$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) return false;
  const expected = signInternalRequest(secret, timestamp, rawBody);
  return safeEqual(expected, signature);
}
