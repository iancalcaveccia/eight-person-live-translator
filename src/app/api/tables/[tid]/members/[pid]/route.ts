import { assertSameOrigin, handle, json, requireUuid } from "@/server/http";
import { leaveTable, removeTableMember, requirePerson } from "@/server/people";

export const runtime = "nodejs";

/** Your own id: leave the table. Someone else's: the owner removes them (and the link is replaced). */
export const DELETE = handle(async (req: Request, ctx: { params: Promise<{ tid: string; pid: string }> }) => {
  assertSameOrigin(req);
  const params = await ctx.params;
  const tid = requireUuid(params.tid, "table id");
  const pid = requireUuid(params.pid, "person id");
  const person = await requirePerson(req);
  if (pid === person.id) {
    await leaveTable(person, tid);
    return json({ ok: true });
  }
  return json({ ok: true, inviteUrlPath: await removeTableMember(person, tid, pid) });
});
