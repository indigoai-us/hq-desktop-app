import { describe, expect, it } from "vitest";

import {
  compareStableTags,
  confirmReleaseChannel,
  verifyStableReleaseOrder,
} from "./release-stable-order.mjs";

const repository = "indigoai-us/hq-desktop-app";
const token = "test-token";

function latestResponse(tag: string, status = 200) {
  return new Response(JSON.stringify({ tag_name: tag }), { status });
}

describe("stable release publication order", () => {
  it.each([
    ["v1.2.3", "v1.2.3", 0],
    ["v1.2.4", "v1.2.3", 1],
    ["v1.10.0", "v1.9.999", 1],
    ["v2.0.0", "v10.0.0", -1],
  ])("compares %s against %s numerically", (left, right, expected) => {
    expect(Math.sign(compareStableTags(left, right))).toBe(expected);
  });

  it("allows the first stable release when latest does not exist", async () => {
    const fetchImpl = async () => new Response(null, { status: 404 });
    await expect(
      verifyStableReleaseOrder({
        repository,
        targetTag: "v1.0.0",
        token,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual({ status: "first-stable", targetTag: "v1.0.0" });
  });

  it("allows an exact stable rerun", async () => {
    const fetchImpl = async () => latestResponse("v1.2.3");
    await expect(
      verifyStableReleaseOrder({
        repository,
        targetTag: "v1.2.3",
        token,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual({
      status: "rerun",
      targetTag: "v1.2.3",
      latestTag: "v1.2.3",
    });
  });

  it("allows a stable version advance", async () => {
    const fetchImpl = async () => latestResponse("v1.2.3");
    await expect(
      verifyStableReleaseOrder({
        repository,
        targetTag: "v1.3.0",
        token,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual({
      status: "advance",
      targetTag: "v1.3.0",
      latestTag: "v1.2.3",
    });
  });

  it("rejects a stable rollback", async () => {
    const fetchImpl = async () => latestResponse("v1.3.0");
    await expect(
      verifyStableReleaseOrder({
        repository,
        targetTag: "v1.2.3",
        token,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow(
      "Refusing stable rollback: v1.2.3 is older than public latest v1.3.0",
    );
  });

  it.each([
    [
      "an API error",
      async () => new Response(null, { status: 503 }),
      "HTTP 503",
    ],
    [
      "a malformed latest tag",
      async () => latestResponse("v1.2.3-beta.1"),
      "unsupported stable tag",
    ],
  ])("fails closed for %s", async (_label, fetchImpl, expected) => {
    await expect(
      verifyStableReleaseOrder({
        repository,
        targetTag: "v1.3.0",
        token,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow(expected);
  });

  it("accepts an explicit 404 as no stable channel for a prerelease", async () => {
    const fetchImpl = async () => new Response(null, { status: 404 });
    await expect(
      confirmReleaseChannel({
        repository,
        targetTag: "v1.3.0-beta.1",
        makeLatest: false,
        token,
        fetchImpl: fetchImpl as typeof fetch,
        attempts: 1,
        retryDelayMs: 0,
      }),
    ).resolves.toEqual({
      status: "no-stable",
      targetTag: "v1.3.0-beta.1",
      latestTag: null,
    });
  });

  it("confirms a prerelease without moving an existing stable latest", async () => {
    const fetchImpl = async () => latestResponse("v1.2.3");
    await expect(
      confirmReleaseChannel({
        repository,
        targetTag: "v1.3.0-beta.1",
        makeLatest: false,
        token,
        fetchImpl: fetchImpl as typeof fetch,
        attempts: 1,
        retryDelayMs: 0,
      }),
    ).resolves.toEqual({
      status: "prerelease-isolated",
      targetTag: "v1.3.0-beta.1",
      latestTag: "v1.2.3",
    });
  });

  it("confirms a stable release became latest", async () => {
    const fetchImpl = async () => latestResponse("v1.3.0");
    await expect(
      confirmReleaseChannel({
        repository,
        targetTag: "v1.3.0",
        makeLatest: true,
        token,
        fetchImpl: fetchImpl as typeof fetch,
        attempts: 1,
        retryDelayMs: 0,
      }),
    ).resolves.toMatchObject({
      status: "stable-latest",
      latestTag: "v1.3.0",
    });
  });

  it.each([401, 403, 429, 500, 503])(
    "fails closed when latest returns HTTP %i",
    async (status) => {
      const fetchImpl = async () => new Response(null, { status });
      await expect(
        confirmReleaseChannel({
          repository,
          targetTag: "v1.3.0-beta.1",
          makeLatest: false,
          token,
          fetchImpl: fetchImpl as typeof fetch,
          attempts: 1,
          retryDelayMs: 0,
        }),
      ).rejects.toThrow(`HTTP ${status}`);
    },
  );

  it("fails closed when the latest request has a network error", async () => {
    const fetchImpl = async () => {
      throw new TypeError("network unavailable");
    };
    await expect(
      confirmReleaseChannel({
        repository,
        targetTag: "v1.3.0-beta.1",
        makeLatest: false,
        token,
        fetchImpl: fetchImpl as typeof fetch,
        attempts: 1,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow("network unavailable");
  });
});
