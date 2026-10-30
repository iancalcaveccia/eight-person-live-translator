import { returnToMain } from "@/server/gatherings";
import { json } from "@/server/http";
import { participantRoute } from "@/server/routes";

export const runtime = "nodejs";

/** One-tap return to the shared main conversation. */
export const POST = participantRoute(async (_req, ctx) => json(await returnToMain(ctx)), { mutating: true });
