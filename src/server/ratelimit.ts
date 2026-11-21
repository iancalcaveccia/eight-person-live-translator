import "server-only";
import type { Queryable } from "./db";
import { ApiError } from "./http";

/**
 * Fixed-window rate limit stored in Postgres (shared across serverless
 * instances). Throws 429 when `limit` is exceeded within `windowSeconds`.
 */
export async function rateLimit(
  q: Queryable,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const rows = await q.query<{ count: number }>(
    `insert into rate_limits (bucket, window_start, count)
     values ($1, to_timestamp(floor(extract(epoch from now()) / $2) * $2), 1)
     on conflict (bucket, window_start) do update set count = rate_limits.count + 1
     returning count`,
    [bucket, windowSeconds],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (count > limit) {
    throw new ApiError(429, "rate_limited", "Too many requests, please slow down", {
      retryAfterSeconds: windowSeconds,
    });
  }
}

export async function pruneRateLimits(q: Queryable): Promise<void> {
  await q.query("delete from rate_limits where window_start < now() - interval '1 day'");
}
