import { updatePreferences } from "@/server/gatherings";
import { json, readJson } from "@/server/http";
import { participantRoute } from "@/server/routes";
import { cleanText, parsePartialPrefs } from "@/server/validation";

export const runtime = "nodejs";

/** Change name / speaking language / listening language / Spanish region. */
export const PATCH = participantRoute(
  async (req, ctx) => {
    const body = await readJson(req);
    const prefs = parsePartialPrefs(body);
    const displayName = body.displayName === undefined ? undefined : cleanText(body.displayName, "Your name", 40);
    await updatePreferences(ctx, { ...prefs, displayName });
    return json({ ok: true });
  },
  { mutating: true },
);
