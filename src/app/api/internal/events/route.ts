import { recordWorkerEvents, type WorkerEventInput } from "@/server/diagnostics";
import { ApiError, handle, json } from "@/server/http";
import { readSignedInternalBody } from "@/server/internal";

export const runtime = "nodejs";

/** Worker -> control plane: content-free diagnostics (signed, CONTRACT section 6). */
export const POST = handle(async (req: Request) => {
  const body = await readSignedInternalBody<{ room?: unknown; events?: unknown }>(req);
  if (typeof body.room !== "string") throw new ApiError(400, "invalid_room");
  const events = Array.isArray(body.events) ? (body.events as WorkerEventInput[]) : [];
  return json({ stored: await recordWorkerEvents(body.room, events) });
});
