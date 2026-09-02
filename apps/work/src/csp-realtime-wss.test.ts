/**
 * The deployed CSP must permit the realtime (MQTT-over-WebSocket) socket.
 *
 * Ported from hq-console/tests/csp-realtime-wss.test.ts, whose root cause it
 * pins: `connect-src 'self' https:` does NOT cover a `wss:` URL — CSP scheme
 * matching only widens `http:` to `https:`, never `https:` to `wss:` — so the
 * browser refuses the socket to `wss://{endpoint}/mqtt` and realtime silently
 * degrades (a CSP-refused WebSocket throws SecurityError from the
 * constructor, easily misread as an environment block).
 *
 * Here the CSP is built by `$lib/server/csp` and set from hooks.server.ts, so
 * the test asserts the REAL production value, not a fixture.
 *
 * The grant is scoped to AWS rather than a blanket `wss:`: CSP host patterns
 * allow only a leading wildcard, so `wss://*.amazonaws.com` is the tightest
 * expression that still covers the account- and region-specific IoT ATS
 * endpoint (`{prefix}-ats.iot.{region}.amazonaws.com`).
 */

import { describe, expect, it } from "vitest";

import { buildCsp } from "./lib/server/csp";

function directive(csp: string, name: string): string | undefined {
  return csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
}

describe("CSP — realtime push (US-006)", () => {
  it("connect-src allows the AWS IoT WebSocket", () => {
    const connectSrc = directive(buildCsp(), "connect-src");
    expect(connectSrc, "CSP declares connect-src").toBeDefined();
    expect(
      connectSrc,
      "must allow the realtime wss socket — 'https:' does not cover 'wss:'",
    ).toContain("wss://*.amazonaws.com");
  });

  it("connect-src allows the configured direct hq-pro API origin", () => {
    const connectSrc = directive(
      buildCsp("https://hqapi.example.test/v1"),
      "connect-src",
    );
    expect(connectSrc).toContain("https://hqapi.example.test");
    expect(connectSrc).not.toContain("https://hqapi.example.test/v1");
  });

  it("the wss grant stays scoped to AWS, never a blanket wss:", () => {
    const connectSrc = directive(buildCsp(), "connect-src") ?? "";
    const sources = connectSrc.split(/\s+/).slice(1);
    expect(sources, "must not open every wss origin").not.toContain("wss:");
  });

  it("neither default-src nor connect-src is dropped (default-src would govern)", () => {
    const csp = buildCsp();
    expect(directive(csp, "default-src")).toBeDefined();
    expect(directive(csp, "connect-src")).toBeDefined();
  });

  it("frame-src allows vault PDF previews", () => {
    const frameSrc = directive(buildCsp(), "frame-src") ?? "";
    expect(frameSrc).toContain("https:");
    expect(frameSrc).toContain("blob:");
  });

  it("img-src allows local thumbs and vault HTTPS previews", () => {
    const imgSrc = directive(buildCsp(), "img-src") ?? "";
    expect(imgSrc).toContain("blob:");
    expect(imgSrc).toContain("https:");
  });

  it("connect-src allows presigned S3 attachment uploads", () => {
    const connectSrc = directive(buildCsp(), "connect-src") ?? "";
    expect(connectSrc).toContain("https://*.amazonaws.com");
  });

  it("connect-src includes 'self' and the Cognito endpoints", () => {
    const connectSrc = directive(buildCsp(), "connect-src") ?? "";
    expect(connectSrc).toContain("'self'");
    expect(connectSrc).toContain(
      "https://vault-indigo-hq-prod.auth.us-east-1.amazoncognito.com",
    );
  });
});
