import { rotateInvite } from "@/server/gatherings";
import { json } from "@/server/http";
import { participantRoute } from "@/server/routes";

export const runtime = "nodejs";

/** Host invalidates the current invite link/QR and gets a new one. */
export const POST = participantRoute(async (_req, ctx) => json({ inviteUrlPath: await rotateInvite(ctx) }), {
  mutating: true,
});
