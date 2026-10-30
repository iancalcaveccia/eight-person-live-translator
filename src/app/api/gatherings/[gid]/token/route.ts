import { mintMediaToken } from "@/server/gatherings";
import { json } from "@/server/http";
import { participantRoute } from "@/server/routes";

export const runtime = "nodejs";

/**
 * Short-lived LiveKit token for the caller's CURRENT group room only. The
 * room is chosen by the server from Postgres; the client cannot name one.
 */
export const POST = participantRoute(async (_req, ctx) => json(await mintMediaToken(ctx)), { mutating: true });
