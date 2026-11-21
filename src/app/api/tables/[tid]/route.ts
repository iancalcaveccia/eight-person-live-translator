import { assertSameOrigin, handle, json, readJson, requireUuid } from "@/server/http";
import { renameTable, requirePerson } from "@/server/people";
import { cleanText } from "@/server/validation";

export const runtime = "nodejs";

/** Rename a table (its owner only). */
export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ tid: string }> }) => {
  assertSameOrigin(req);
  const tid = requireUuid((await ctx.params).tid, "table id");
  const person = await requirePerson(req);
  const body = await readJson(req);
  await renameTable(person, tid, cleanText(body.name, "Table name", 60));
  return json({ ok: true });
});
