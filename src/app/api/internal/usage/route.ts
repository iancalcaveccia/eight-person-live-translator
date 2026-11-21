import { recordUsage, type UsageRecordInput } from "@/server/gatherings";
import { ApiError, handle, json } from "@/server/http";
import { readSignedInternalBody } from "@/server/internal";

export const runtime = "nodejs";

/**
 * Worker reports audio durations per (speaker, target, provider); the server
 * prices them, enforces caps and tells the worker whether to keep translating.
 */
export const POST = handle(async (req: Request) => {
  const body = await readSignedInternalBody<{ room?: unknown; records?: unknown }>(req);
  if (typeof body.room !== "string" || !/^grp_[a-z2-7]{24}$/.test(body.room)) {
    throw new ApiError(400, "invalid_room");
  }
  const records = Array.isArray(body.records) ? (body.records as UsageRecordInput[]) : [];
  return json(await recordUsage(body.room, records));
});
