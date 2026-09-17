import { describe, expect, it } from "vitest";

import {
  createReleaseLookup,
  isPublishedStableRelease,
  parseCandidates,
  selectPreviousPublishedTag,
} from "./release-previous-published-tag.mjs";

const repository = "indigoai-us/hq-desktop-app";
const token = "test-token";

type FakeRelease = { tag_name: string; draft?: boolean; prerelease?: boolean };

/**
 * A fake `GET /repos/{repo}/releases/tags/{tag}`: tags in the list answer 200
 * with the release, everything else answers 404 the way GitHub does for a tag
 * that was pushed but whose release run never published.
 */
function fakeReleaseApi(releases: FakeRelease[]) {
  const calls: string[] = [];
  const byTag = new Map(releases.map((release) => [release.tag_name, release]));
  const fetchImpl = async (url: string | URL | Request) => {
    const tag = decodeURIComponent(String(url).split("/releases/tags/")[1] ?? "");
    calls.push(tag);
    const release = byTag.get(tag);
    return release
      ? new Response(JSON.stringify(release), { status: 200 })
      : new Response(null, { status: 404 });
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function lookupFrom(releases: FakeRelease[]) {
  const { calls, fetchImpl } = fakeReleaseApi(releases);
  return { calls, lookupRelease: createReleaseLookup({ repository, token, fetchImpl }) };
}

describe("previous published stable release", () => {
  // The bug this file exists for: v0.10.277 was tagged, failed both Windows
  // builds, and never published. The old `git describe` selection named it
  // "previous" anyway, so the repeat-notes guard refused v0.10.278 for
  // repeating notes no user has ever seen.
  it("skips a tag whose release run never published", async () => {
    const { calls, lookupRelease } = lookupFrom([
      { tag_name: "v0.10.276" },
      { tag_name: "v0.10.275" },
    ]);

    await expect(
      selectPreviousPublishedTag({
        candidates: ["v0.10.277", "v0.10.276", "v0.10.275"],
        lookupRelease,
      }),
    ).resolves.toEqual({
      tag: "v0.10.276",
      skipped: ["v0.10.277"],
      exhausted: false,
    });
    expect(calls).toEqual(["v0.10.277", "v0.10.276"]);
  });

  // The whole point of the change is that it is a no-op on the happy path.
  it("takes the nearest ancestor when it published, with one API call", async () => {
    const { calls, lookupRelease } = lookupFrom([
      { tag_name: "v0.10.277" },
      { tag_name: "v0.10.276" },
    ]);

    await expect(
      selectPreviousPublishedTag({
        candidates: ["v0.10.277", "v0.10.276"],
        lookupRelease,
      }),
    ).resolves.toEqual({ tag: "v0.10.277", skipped: [], exhausted: false });
    expect(calls).toEqual(["v0.10.277"]);
  });

  it("walks past a run of unpublished tags", async () => {
    const { lookupRelease } = lookupFrom([{ tag_name: "v0.10.270" }]);

    await expect(
      selectPreviousPublishedTag({
        candidates: ["v0.10.273", "v0.10.272", "v0.10.271", "v0.10.270"],
        lookupRelease,
      }),
    ).resolves.toEqual({
      tag: "v0.10.270",
      skipped: ["v0.10.273", "v0.10.272", "v0.10.271"],
      exhausted: false,
    });
  });

  it("reports no previous release when nothing in the walk published", async () => {
    const { lookupRelease } = lookupFrom([]);

    await expect(
      selectPreviousPublishedTag({
        candidates: ["v0.10.277", "v0.10.276"],
        lookupRelease,
      }),
    ).resolves.toEqual({
      tag: null,
      skipped: ["v0.10.277", "v0.10.276"],
      exhausted: false,
    });
  });

  it("stops after maxChecks and says the walk was cut short", async () => {
    const { calls, lookupRelease } = lookupFrom([{ tag_name: "v0.10.270" }]);

    await expect(
      selectPreviousPublishedTag({
        candidates: ["v0.10.273", "v0.10.272", "v0.10.271", "v0.10.270"],
        lookupRelease,
        maxChecks: 2,
      }),
    ).resolves.toEqual({
      tag: null,
      skipped: ["v0.10.273", "v0.10.272"],
      exhausted: true,
    });
    expect(calls).toEqual(["v0.10.273", "v0.10.272"]);
  });

  // A draft is the hidden staging release the publish job builds before it
  // flips it public, so a release run that died mid-publish leaves one behind.
  // Its notes reached nobody and must not count as shipped.
  it.each([
    ["draft", { tag_name: "v0.10.277", draft: true }],
    ["prerelease", { tag_name: "v0.10.277", prerelease: true }],
  ])("does not treat a %s release as published", async (_label, release) => {
    const { lookupRelease } = lookupFrom([release, { tag_name: "v0.10.276" }]);

    await expect(
      selectPreviousPublishedTag({
        candidates: ["v0.10.277", "v0.10.276"],
        lookupRelease,
      }),
    ).resolves.toEqual({
      tag: "v0.10.276",
      skipped: ["v0.10.277"],
      exhausted: false,
    });
  });

  it.each([
    [{ tag_name: "v0.10.276" }, true],
    [{ tag_name: "v0.10.276", draft: false, prerelease: false }, true],
    [null, false],
    [undefined, false],
  ])("classifies %o as published=%s", (release, expected) => {
    expect(isPublishedStableRelease(release)).toBe(expected);
  });

  // Fail closed. Answering "unpublished" on a rate limit would walk straight
  // past the real previous release and wave repeated notes into a release.
  it("fails the lookup on an API error instead of assuming unpublished", async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 403 })) as unknown as typeof fetch;

    await expect(
      selectPreviousPublishedTag({
        candidates: ["v0.10.277"],
        lookupRelease: createReleaseLookup({ repository, token, fetchImpl }),
      }),
    ).rejects.toThrow(/could not read the release for v0\.10\.277: HTTP 403/);
  });

  it.each([
    [{ repository: "not-a-repo", token }, /invalid repository/],
    [{ repository, token: "" }, /GitHub token is required/],
  ])("refuses to look anything up with %o", (options, message) => {
    expect(() => createReleaseLookup(options)).toThrow(message);
  });

  it("reads candidates nearest-first and ignores blank lines", () => {
    expect(parseCandidates("v0.10.277\n\n  v0.10.276  \n")).toEqual([
      "v0.10.277",
      "v0.10.276",
    ]);
  });

  // A prerelease or a stray tag in the candidate list means the workflow's
  // `git describe` walk is wrong; skipping it quietly would hide that.
  it.each(["v0.10.277-beta.1", "release-277", "v0.10"])(
    "rejects %s as a candidate",
    (tag) => {
      expect(() => parseCandidates(tag)).toThrow(/not a strict stable tag/);
    },
  );

  it.each([0, -1, 1.5])("rejects maxChecks %s", async (maxChecks) => {
    await expect(
      selectPreviousPublishedTag({
        candidates: ["v0.10.277"],
        lookupRelease: async () => null,
        maxChecks,
      }),
    ).rejects.toThrow(/maxChecks must be a positive integer/);
  });
});
