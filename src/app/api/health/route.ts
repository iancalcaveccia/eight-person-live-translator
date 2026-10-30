import { getDb } from "@/server/db";
import { config } from "@/server/env";
import { getMediaAdmin } from "@/server/livekit";
import { json } from "@/server/http";

export const runtime = "nodejs";

/** Liveness + configuration presence (booleans only, never values). */
export async function GET() {
  let database = false;
  try {
    const db = await getDb();
    await db.query("select 1");
    database = true;
  } catch {
    database = false;
  }
  const body = {
    ok: database,
    database,
    databaseKind: config.databaseUrl ? "postgres" : "embedded-dev",
    livekit: getMediaAdmin().configured,
    internalApi: Boolean(config.internalApiSecret),
    hostCode: Boolean(config.hostAccessCode),
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
  };
  return json(body, { status: database ? 200 : 503 });
}
