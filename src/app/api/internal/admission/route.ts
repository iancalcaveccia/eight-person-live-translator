import { admission } from "@/server/gatherings";
import { ApiError, handle, json } from "@/server/http";
import { readSignedInternalBody } from "@/server/internal";

export const runtime = "nodejs";

/**
 * Worker asks whether identities present in a group room are authorized
 * there right now (CONTRACT 6.1). Unauthorized ones are evicted by the worker.
 */
export const POST = handle(async (req: Request) => {
  const body = await readSignedInternalBody<{ room?: unknown; identities?: unknown }>(req);
  if (typeof body.room !== "string" || !/^grp_[a-z2-7]{24}$/.test(body.room)) {
    throw new ApiError(400, "invalid_room");
  }
  const identities = Array.isArray(body.identities)
    ? body.identities.filter((x): x is string => typeof x === "string" && x.length <= 64)
    : [];
  const result = await admission(body.room, identities);
  if (!result) throw new ApiError(404, "unknown_room");
  return json(result);
});
