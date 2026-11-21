import { endGathering } from "@/server/gatherings";
import { clearSessionCookie, json } from "@/server/http";
import { participantRoute } from "@/server/routes";

export const runtime = "nodejs";

/** Host ends the gathering: everyone is disconnected and personal data is deleted. */
export const POST = participantRoute(
  async (_req, ctx) => {
    await endGathering(ctx);
    return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie(ctx.gathering.id) } });
  },
  { mutating: true },
);
