import { getDb } from "@/server/db";
import { budgetFor, usageReport } from "@/server/gatherings";
import { json } from "@/server/http";
import { participantRoute } from "@/server/routes";

export const runtime = "nodejs";

/** Content-free usage, cost and latency summary for this gathering. */
export const GET = participantRoute(async (_req, ctx) => {
  const db = await getDb();
  return json({
    budget: await budgetFor(db, ctx.gathering),
    byLanguage: await usageReport(db, ctx.gathering.id),
  });
});
