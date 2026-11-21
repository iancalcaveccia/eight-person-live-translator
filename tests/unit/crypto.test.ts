import { describe, expect, it } from "vitest";
import {
  deriveInviteToken,
  newRoomName,
  signInternalRequest,
  verifyInternalRequest,
} from "@/server/crypto";

describe("internal request signing (CONTRACT section 6)", () => {
  it("matches the shared test vector used by the Python worker", () => {
    const body = '{"room":"grp_test","identities":["p1"]}';
    expect(signInternalRequest("test-secret", "1700000000", body)).toBe(
      "v1=81db07323246d44a782b096c988c871b5c323017ba636958c89b1bd643c5214d",
    );
  });

  it("verifies within the skew window and rejects outside it or on tampering", () => {
    const body = '{"a":1}';
    const sig = signInternalRequest("s", "1700000000", body);
    expect(verifyInternalRequest("s", "1700000000", sig, body, 1700000050)).toBe(true);
    expect(verifyInternalRequest("s", "1700000000", sig, body, 1700000500)).toBe(false);
    expect(verifyInternalRequest("s", "1700000000", sig, '{"a":2}', 1700000000)).toBe(false);
    expect(verifyInternalRequest("other", "1700000000", sig, body, 1700000000)).toBe(false);
    expect(verifyInternalRequest("s", null, sig, body, 1700000000)).toBe(false);
  });
});

describe("identifiers", () => {
  it("room names are random and well-formed", () => {
    const a = newRoomName();
    const b = newRoomName();
    expect(a).toMatch(/^grp_[a-z2-7]{24}$/);
    expect(a).not.toBe(b);
  });

  it("invite tokens change with the version", () => {
    const t1 = deriveInviteToken("secret", "g", 1);
    const t2 = deriveInviteToken("secret", "g", 2);
    expect(t1).toHaveLength(32);
    expect(t1).not.toBe(t2);
    expect(deriveInviteToken("secret", "g", 1)).toBe(t1);
  });
});
