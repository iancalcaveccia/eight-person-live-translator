import { getState } from "@/server/gatherings";
import { json } from "@/server/http";
import { participantRoute } from "@/server/routes";

export const runtime = "nodejs";

/** Presence + groups + invitations for the caller (polled every few seconds). */
export const GET = participantRoute(async (_req, ctx) => json(await getState(ctx)));
