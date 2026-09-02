import { describe, expect, it } from "vitest";

import { pkceChallenge, randomToken } from "./pkce.js";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe("randomToken", () => {
  it("is base64url with no padding and unique per call", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).toMatch(BASE64URL);
    expect(a).not.toContain("=");
    expect(a).not.toBe(b);
  });

  it("byte length controls output length (32 bytes → 43 base64url chars)", () => {
    expect(randomToken(32).length).toBe(43);
    expect(randomToken(16).length).toBe(22);
  });
});

describe("pkceChallenge (S256)", () => {
  it("matches the RFC 7636 test vector", async () => {
    // From RFC 7636 Appendix B.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await pkceChallenge(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("is deterministic and base64url without padding", async () => {
    const c1 = await pkceChallenge("verifier-123");
    const c2 = await pkceChallenge("verifier-123");
    expect(c1).toBe(c2);
    expect(c1).toMatch(BASE64URL);
    expect(c1).not.toContain("=");
  });
});
