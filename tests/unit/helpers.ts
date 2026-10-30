import { resetDbForTests } from "@/server/db";
import { buildAccessToken, setMediaAdminForTests, type MediaAdmin, type MintTokenInput } from "@/server/livekit";
import { signInternalRequest } from "@/server/crypto";

export const TEST_LK_KEY = "devkey";
export const TEST_LK_SECRET = "secret-secret-secret-secret-secret-32";

export interface AdminCall {
  op: "remove" | "attrs" | "data" | "deleteRoom" | "mute";
  room: string;
  identity?: string;
  identities?: string[];
  payload?: unknown;
  attributes?: Record<string, string>;
}

/** Records every media side effect; mints real JWTs so grants can be decoded. */
export class FakeMediaAdmin implements MediaAdmin {
  readonly configured = true;
  readonly serverUrl = "ws://livekit.test";
  calls: AdminCall[] = [];
  minted: MintTokenInput[] = [];

  async mintToken(input: MintTokenInput): Promise<string> {
    this.minted.push(input);
    return buildAccessToken(TEST_LK_KEY, TEST_LK_SECRET, input).toJwt();
  }
  async removeParticipant(room: string, identity: string) {
    this.calls.push({ op: "remove", room, identity });
  }
  async updateAttributes(room: string, identity: string, attributes: Record<string, string>) {
    this.calls.push({ op: "attrs", room, identity, attributes });
  }
  async sendData(room: string, identities: string[], payload: unknown) {
    this.calls.push({ op: "data", room, identities, payload });
  }
  async deleteRoom(room: string) {
    this.calls.push({ op: "deleteRoom", room });
  }
  async muteMicrophone(room: string, identity: string) {
    this.calls.push({ op: "mute", room, identity });
    return true;
  }
  removals(identity: string) {
    return this.calls.filter((c) => c.op === "remove" && c.identity === identity).map((c) => c.room);
  }
}

export async function freshEnvironment(env: Record<string, string | undefined> = {}) {
  const defaults: Record<string, string | undefined> = {
    HOST_ACCESS_CODE: "host-code-123",
    INTERNAL_API_SECRET: "internal-secret",
    APP_SECRET: "app-secret-for-tests",
    MAX_AI_SPEND_PER_GATHERING_USD: "50",
    MAX_AI_SPEND_MONTHLY_USD: "200",
    MAX_AI_SPEND_DAILY_USD: undefined,
    VERCEL: undefined,
    VERCEL_ENV: undefined,
    DATABASE_URL: undefined,
  };
  for (const [k, v] of Object.entries({ ...defaults, ...env })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const db = await resetDbForTests();
  const admin = new FakeMediaAdmin();
  setMediaAdminForTests(admin);
  return { db, admin };
}

export function decodeJwt(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** A browser-like client holding gathering cookies. */
export class Client {
  cookies = new Map<string, string>();
  constructor(public ip = "203.0.113.10") {}

  private cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
  }

  async call(
    handler: unknown,
    opts: { method?: string; params?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-forwarded-for": this.ip,
      host: "app.test",
      ...opts.headers,
    };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    const req = new Request("http://app.test/api/x", {
      method: opts.method ?? "POST",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const res = await (handler as Handler)(req, { params: Promise.resolve(opts.params ?? {}) });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const [pair] = setCookie.split(";");
      const idx = pair.indexOf("=");
      const name = pair.slice(0, idx);
      const value = decodeURIComponent(pair.slice(idx + 1));
      if (value === "" || /Max-Age=0/.test(setCookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  }
}

export function signedRequest(body: unknown, secret = "internal-secret", ts = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body);
  return new Request("http://app.test/api/internal/x", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-interp-timestamp": String(ts),
      "x-interp-signature": signInternalRequest(secret, String(ts), raw),
    },
    body: raw,
  });
}

export function inviteTokenFromPath(path: string): string {
  const m = /#k=([A-Za-z0-9_-]+)/.exec(path);
  if (!m) throw new Error(`no invite token in ${path}`);
  return m[1];
}
