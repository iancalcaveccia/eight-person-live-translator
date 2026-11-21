import { assertSameOrigin, handle, json, requireUuid } from "@/server/http";
import { requirePerson, rotateTableInvite } from "@/server/people";

export const runtime = "nodejs";

/** Replace the table's link (owner only). Members keep their seat; the old link stops working. */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ tid: string }> }) => {
  assertSameOrigin(req);
  const tid = requireUuid((await ctx.params).tid, "table id");
  const person = await requirePerson(req);
  return json({ inviteUrlPath: await rotateTableInvite(person, tid) });
});
