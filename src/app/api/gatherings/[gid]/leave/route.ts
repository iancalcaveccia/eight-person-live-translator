import { leaveGathering } from "@/server/gatherings";
import { clearSessionCookie, json } from "@/server/http";
import { participantRoute } from "@/server/routes";

export const runtime = "nodejs";

/** Leave the gathering for good (frees your seat; you need the invite to come back). */
export const POST = participantRoute(
  async (_req, ctx) => {
    await leaveGathering(ctx);
    return json({ ok: true }, { headers: { "set-cookie": clearSessionCookie(ctx.gathering.id) } });
  },
  { mutating: true },
);
