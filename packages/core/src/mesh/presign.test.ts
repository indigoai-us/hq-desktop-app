import { describe, expect, it } from "vitest";

import {
  amzDateOf,
  presignIotWssUrl,
  rfc3986Encode,
  type MeshCredentials,
} from "./presign.js";

const CREDS: MeshCredentials = {
  accessKeyId: "ASIAFIXEDVECTOR00001",
  secretAccessKey: "fixedSecretKeyForVectorTests/0001",
  sessionToken: "FwoGZXIvYXdzEFixedVectorToken+With/Special=Chars0001",
};
const ENDPOINT = "a1example-ats.iot.us-east-1.amazonaws.com";
const REGION = "us-east-1";
const NOW = new Date("2026-08-14T12:00:00.000Z");

/** Independently derived fixed vector (WebCrypto reference implementation). */
const EXPECTED_URL =
  "wss://a1example-ats.iot.us-east-1.amazonaws.com/mqtt" +
  "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
  "&X-Amz-Credential=ASIAFIXEDVECTOR00001%2F20260814%2Fus-east-1%2Fiotdevicegateway%2Faws4_request" +
  "&X-Amz-Date=20260814T120000Z" +
  "&X-Amz-SignedHeaders=host" +
  "&X-Amz-Signature=0fc6f54651cd53342e675005c6206e1f118a536e9967d3211403c9e649224958" +
  "&X-Amz-Security-Token=FwoGZXIvYXdzEFixedVectorToken%2BWith%2FSpecial%3DChars0001";

describe("presignIotWssUrl", () => {
  it("produces the exact expected URL for the fixed vector", async () => {
    const url = await presignIotWssUrl(CREDS, ENDPOINT, REGION, NOW);
    expect(url).toBe(EXPECTED_URL);
  });

  it("is deterministic for a fixed clock", async () => {
    const a = await presignIotWssUrl(CREDS, ENDPOINT, REGION, NOW);
    const b = await presignIotWssUrl(CREDS, ENDPOINT, REGION, NOW);
    expect(a).toBe(b);
  });

  it("appends the session token AFTER the signature, outside the signed query", async () => {
    const url = await presignIotWssUrl(CREDS, ENDPOINT, REGION, NOW);
    const query = url.split("?")[1];
    const params = query.split("&").map((p) => p.split("=")[0]);
    // Token must be the LAST parameter, after X-Amz-Signature.
    expect(params[params.length - 1]).toBe("X-Amz-Security-Token");
    expect(params.indexOf("X-Amz-Signature")).toBe(params.length - 2);
    // The token must not be part of the signed (canonical) portion: signing
    // the same request WITHOUT a token yields the identical signature.
    const noToken = await presignIotWssUrl(
      { ...CREDS, sessionToken: "" },
      ENDPOINT,
      REGION,
      NOW,
    );
    expect(url.startsWith(noToken)).toBe(true);
    expect(noToken).not.toContain("X-Amz-Security-Token");
  });

  it("changing the token does not change the signature", async () => {
    const other = await presignIotWssUrl(
      { ...CREDS, sessionToken: "completely-different-token" },
      ENDPOINT,
      REGION,
      NOW,
    );
    const sigOf = (u: string) => /X-Amz-Signature=([0-9a-f]+)/.exec(u)?.[1];
    expect(sigOf(other)).toBe(sigOf(EXPECTED_URL));
  });
});

describe("helpers", () => {
  it("amzDateOf formats compact UTC", () => {
    expect(amzDateOf(NOW)).toBe("20260814T120000Z");
  });

  it("rfc3986Encode escapes !*'() beyond encodeURIComponent", () => {
    expect(rfc3986Encode("a!b*c'd(e)f")).toBe("a%21b%2Ac%27d%28e%29f");
  });
});
