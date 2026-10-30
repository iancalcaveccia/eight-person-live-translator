import "server-only";
import { authenticate, type AuthContext } from "./gatherings";
import { assertSameOrigin, handle, requireUuid } from "./http";

type RouteCtx<P> = { params: Promise<P> };

/**
 * Route wrapper for participant-authenticated endpoints: validates the
 * gathering id, enforces same-origin on mutations and resolves the caller
 * from their httpOnly gathering cookie.
 */
export function participantRoute<P extends { gid: string }>(
  fn: (req: Request, ctx: AuthContext, params: P) => Promise<Response>,
  opts: { mutating?: boolean } = {},
) {
  return handle(async (req: Request, routeCtx: RouteCtx<P>) => {
    const params = await routeCtx.params;
    const gid = requireUuid(params.gid, "gathering id");
    if (opts.mutating) assertSameOrigin(req);
    const ctx = await authenticate(req, gid);
    return fn(req, ctx, params);
  });
}
