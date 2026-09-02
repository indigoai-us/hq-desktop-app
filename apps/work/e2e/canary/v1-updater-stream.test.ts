import { expect, test } from "@playwright/test";

// V1 updater-stream canary (guards against the 0.10.108 incident shape).
//
// V1 desktop users update from the hq-desktop-app "latest" release manifest.
// This canary asserts that manifest still serves the V1 (0.10.x) line, so V1
// users can never silently receive a V2 build again.
//
// Retirement: only the future deliberate-cutover project may retire or relax
// this test. Do NOT loosen the assertion to make CI green — a red canary means
// the live V1 updater stream is serving something other than V1.
const MANIFEST_URL =
  "https://github.com/indigoai-us/hq-desktop-app/releases/latest/download/latest.json";

const V1_LINE = /^0\.10\./;
const V2_MANIFEST_URL =
  "https://indigo-electron-releases.s3.us-east-1.amazonaws.com/hq-work/latest.json";
const V2_LINE = /^0\.1\./;

test.describe("canary: V1 updater stream", () => {
  test("latest.json serves the 0.10.x (V1) line", async ({ request }) => {
    const response = await request.get(MANIFEST_URL, {
      // GitHub serves this via a redirect to a signed asset URL; the request
      // fixture follows redirects by default.
      timeout: 30_000,
    });

    expect(
      response.ok(),
      `Fetching V1 updater manifest failed: HTTP ${response.status()} ${response.statusText()}`,
    ).toBe(true);

    const manifest = (await response.json()) as { version?: unknown };

    expect(
      typeof manifest.version,
      `latest.json has no string "version" field: ${JSON.stringify(manifest).slice(0, 200)}`,
    ).toBe("string");

    const version = manifest.version as string;
    expect(
      version,
      `V1 UPDATER STREAM COMPROMISED: latest.json serves "${version}", expected the 0.10.x V1 line. ` +
        "V1 users may be receiving a non-V1 build (0.10.108 incident shape). Investigate immediately.",
    ).toMatch(V1_LINE);
  });
});

test.describe("canary: V2 updater stream", () => {
  test("latest.json and its signed desktop artifact are publicly readable", async ({
    request,
  }) => {
    const response = await request.get(V2_MANIFEST_URL, { timeout: 30_000 });
    expect(
      response.ok(),
      `Fetching V2 updater manifest failed anonymously: HTTP ${response.status()} ${response.statusText()}`,
    ).toBe(true);

    const manifest = (await response.json()) as {
      version?: unknown;
      platforms?: { "darwin-aarch64"?: { signature?: unknown; url?: unknown } };
    };
    expect(manifest.version).toEqual(expect.any(String));
    expect(manifest.version as string).toMatch(V2_LINE);

    const platform = manifest.platforms?.["darwin-aarch64"];
    expect(platform?.signature).toEqual(expect.any(String));
    expect((platform?.signature as string).length).toBeGreaterThan(100);
    expect(platform?.url).toEqual(expect.any(String));
    expect(platform?.url as string).toMatch(
      /^https:\/\/indigo-electron-releases\.s3\.us-east-1\.amazonaws\.com\/hq-work\/v0\.1\.\d+\/(?:\d+-\d+\/)?HQ-Work_0\.1\.\d+_aarch64\.app\.tar\.gz$/,
    );

    const artifact = await request.get(platform?.url as string, {
      timeout: 30_000,
      headers: { Range: "bytes=0-1023" },
    });
    expect(
      [200, 206],
      `Fetching V2 updater artifact failed anonymously: HTTP ${artifact.status()} ${artifact.statusText()}`,
    ).toContain(artifact.status());
  });
});
