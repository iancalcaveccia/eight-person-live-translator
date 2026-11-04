import "server-only";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyInternalRequest } from "./crypto";
import { config } from "./env";
import { ApiError, readText } from "./http";

/**
 * Authenticate a worker -> control plane call (CONTRACT section 6) and
 * return the parsed JSON body. Bodies are never logged.
 */
export async function readSignedInternalBody<T>(req: Request): Promise<T> {
  const secret = config.internalApiSecret;
  if (!secret) throw new ApiError(503, "internal_api_not_configured");
  const raw = await readText(req, 64 * 1024);
  const ok = verifyInternalRequest(
    secret,
    req.headers.get(TIMESTAMP_HEADER),
    req.headers.get(SIGNATURE_HEADER),
    raw,
  );
  if (!ok) throw new ApiError(401, "bad_signature");
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}
