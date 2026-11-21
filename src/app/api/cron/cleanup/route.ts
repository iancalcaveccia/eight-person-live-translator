import { safeEqual } from "@/server/crypto";
import { config } from "@/server/env";
import { cleanupExpiredGatherings } from "@/server/gatherings";
import { ApiError, handle, json } from "@/server/http";

export const runtime = "nodejs";

/** Vercel Cron: end expired/abandoned gatherings and prune old rows. */
export const GET = handle(async (req: Request) => {
  const secret = config.cronSecret;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) throw new ApiError(401, "unauthorized");
  const ended = await cleanupExpiredGatherings();
  return json({ ok: true, ended });
});
