import { readDiagnostics, type DiagnosticsQuery } from "@/server/diagnostics";
import { handle, json } from "@/server/http";
import { readSignedInternalBody } from "@/server/internal";

export const runtime = "nodejs";

/**
 * Read back content-free diagnostics for a period (signed with the worker's
 * internal secret, so only the worker's operator can call it). Used to review
 * long sessions and tune the interpreter.
 */
export const POST = handle(async (req: Request) => {
  const body = await readSignedInternalBody<DiagnosticsQuery>(req);
  return json(await readDiagnostics(body));
});
