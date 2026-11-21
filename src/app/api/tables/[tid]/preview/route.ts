import { assertSameOrigin, clientIp, handle, json, readJson, requireUuid } from "@/server/http";
import { previewTable } from "@/server/people";

export const runtime = "nodejs";

/** Table name and first names for someone holding a valid table link (POST keeps the token out of URLs and logs). */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ tid: string }> }) => {
  assertSameOrigin(req);
  const tid = requireUuid((await ctx.params).tid, "table id");
  const body = await readJson(req);
  return json(await previewTable(tid, body.inviteToken, clientIp(req)));
});
