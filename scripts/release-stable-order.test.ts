import { describe, expect, it } from "vitest";

import {
  compareStableTags,
  confirmReleaseChannel,
  formatRollbackSummary,
  verifyStableReleaseLineage,
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

type CompareShape = {
  status: string;
  ahead_by?: number;
  behind_by?: number;
  commits?: Array<{ sha: string; commit: { message: string } }>;
  httpStatus?: number;
};

type LineageConfig = {
  latest?: string | null;
  latestStatus?: number;
  compares?: Record<string, CompareShape>;
  ref?: { objectType: string; sha?: string; httpStatus?: number };
  tagObject?: { message?: string; httpStatus?: number };
};

// One injected fetch that routes by URL across the four endpoints the lineage
// gate walks: releases/latest, compare, git/ref/tags, git/tags. The compare
// shapes are the real ones recorded from production history.
function lineageFetch(config: LineageConfig) {
  const calls: string[] = [];
  const impl = async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/releases/latest")) {
      if (config.latest == null) {
        return new Response(null, { status: config.latestStatus ?? 404 });
      }
      return latestResponse(config.latest, config.latestStatus ?? 200);
    }
    const compareMatch = /\/compare\/(.+)$/.exec(url);
    if (compareMatch) {
      const key = compareMatch[1];
      const entry = config.compares?.[key];
      if (!entry) {
        throw new Error(`unexpected compare request for ${key}`);
      }
      if (entry.httpStatus && entry.httpStatus >= 400) {
        return new Response(null, { status: entry.httpStatus });
      }
      return new Response(
        JSON.stringify({
          status: entry.status,
          ahead_by: entry.ahead_by ?? 0,
          behind_by: entry.behind_by ?? 0,
          commits: entry.commits ?? [],
        }),
        { status: 200 },
      );
    }
    if (url.includes("/git/ref/tags/")) {
      const ref = config.ref ?? { objectType: "tag", sha: "annotated-sha" };
      if (ref.httpStatus && ref.httpStatus >= 400) {
        return new Response(null, { status: ref.httpStatus });
      }
      return new Response(
        JSON.stringify({
          object: { type: ref.objectType, sha: ref.sha ?? "annotated-sha" },
        }),
        { status: 200 },
      );
    }
    if (url.includes("/git/tags/")) {
      const tagObject = config.tagObject ?? { message: "" };
      if (tagObject.httpStatus && tagObject.httpStatus >= 400) {
        return new Response(null, { status: tagObject.httpStatus });
      }
      return new Response(JSON.stringify({ message: tagObject.message ?? "" }), {
        status: 200,
      });
    }
    throw new Error(`unexpected request for ${url}`);
  };
  return { impl, calls };
}

describe("stable release commit lineage", () => {
  it("rejects the v0.10.107 rollback recorded against public latest v0.10.106", async () => {
    const { impl } = lineageFetch({
      latest: "v0.10.106",
      compares: {
        "v0.10.106...v0.10.107": { status: "behind", ahead_by: 0, behind_by: 33 },
      },
    });
    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v0.10.107",
        token,
        fetchImpl: impl as typeof fetch,
      }),
    ).rejects.toThrow(/v0\.10\.107 is behind public latest v0\.10\.106 by 33 commit/);
  });

  it("rejects the v0.10.109 rollback recorded against public latest v0.10.108", async () => {
    const { impl } = lineageFetch({
      latest: "v0.10.108",
      compares: {
        "v0.10.108...v0.10.109": { status: "behind", ahead_by: 0, behind_by: 49 },
      },
    });
    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v0.10.109",
        token,
        fetchImpl: impl as typeof fetch,
      }),
    ).rejects.toThrow(/v0\.10\.109 is behind public latest v0\.10\.108 by 49 commit/);
  });

  it("rejects a diverged tag cut from a side branch", async () => {
    const { impl } = lineageFetch({
      latest: "v0.10.106",
      compares: {
        "v0.10.106...v0.10.200": { status: "diverged", ahead_by: 5, behind_by: 7 },
      },
    });
    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v0.10.200",
        token,
        fetchImpl: impl as typeof fetch,
      }),
    ).rejects.toThrow(/Refusing stable lineage rollback: v0\.10\.200 is diverged/);
  });

  it("allows the real v0.10.105 -> v0.10.106 advance", async () => {
    const { impl } = lineageFetch({
      latest: "v0.10.105",
      compares: {
        "v0.10.105...v0.10.106": { status: "ahead", ahead_by: 33, behind_by: 0 },
      },
    });
    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v0.10.106",
        token,
        fetchImpl: impl as typeof fetch,
      }),
    ).resolves.toEqual({
      status: "advance",
      targetTag: "v0.10.106",
      latestTag: "v0.10.105",
      compareStatus: "ahead",
    });
  });

  it("allows an identical rerun of the current public latest", async () => {
    const { impl } = lineageFetch({
      latest: "v0.10.106",
      compares: {
        "v0.10.106...v0.10.106": { status: "identical", ahead_by: 0, behind_by: 0 },
      },
    });
    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v0.10.106",
        token,
        fetchImpl: impl as typeof fetch,
      }),
    ).resolves.toEqual({
      status: "rerun",
      targetTag: "v0.10.106",
      latestTag: "v0.10.106",
      compareStatus: "identical",
    });
  });

  it("allows a behind target whose annotated tag declares Rollback-Of the exact public latest", async () => {
    const { impl } = lineageFetch({
      latest: "v0.10.106",
      compares: {
        "v0.10.106...v0.10.107": { status: "behind", ahead_by: 0, behind_by: 33 },
        "v0.10.107...v0.10.106": {
          status: "ahead",
          ahead_by: 33,
          behind_by: 0,
          commits: [
            {
              sha: "b8e74e289d845c45c612cb99d4758202d22b6599",
              commit: { message: "fix: durable wedge clock\n\nbody text" },
            },
            {
              sha: "c1488b0314100fca5161e8a03ed6097b256f1a2b",
              commit: { message: "chore: bump" },
            },
          ],
        },
      },
      ref: { objectType: "tag", sha: "annotated-107" },
      tagObject: {
        message:
          "HQ v0.10.107 - rollback to last pre-v2-chat stable (v0.10.105)\n\nRollback-Of: v0.10.106\n",
      },
    });
    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v0.10.107",
        token,
        fetchImpl: impl as typeof fetch,
      }),
    ).resolves.toEqual({
      status: "declared-rollback",
      targetTag: "v0.10.107",
      latestTag: "v0.10.106",
      compareStatus: "behind",
      behindBy: 33,
      withdrawnCommits: [
        {
          sha: "b8e74e289d845c45c612cb99d4758202d22b6599",
          title: "fix: durable wedge clock",
        },
        { sha: "c1488b0314100fca5161e8a03ed6097b256f1a2b", title: "chore: bump" },
      ],
    });
  });

  it("rejects a rollback trailer naming a tag other than the current public latest", async () => {
    const { impl } = lineageFetch({
      latest: "v0.10.106",
      compares: {
        "v0.10.106...v0.10.107": { status: "behind", ahead_by: 0, behind_by: 33 },
      },
      ref: { objectType: "tag", sha: "annotated-107" },
      tagObject: { message: "rollback\n\nRollback-Of: v0.10.105\n" },
    });
    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v0.10.107",
        token,
        fetchImpl: impl as typeof fetch,
      }),
    ).rejects.toThrow(/Refusing stable lineage rollback/);
  });

  it("rejects a lightweight tag that carries no annotated message", async () => {
    const { impl } = lineageFetch({
      latest: "v0.10.106",
      compares: {
        "v0.10.106...v0.10.107": { status: "behind", ahead_by: 0, behind_by: 33 },
      },
      ref: { objectType: "commit", sha: "commit-107" },
    });
    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v0.10.107",
        token,
        fetchImpl: impl as typeof fetch,
      }),
    ).rejects.toThrow(/Refusing stable lineage rollback/);
  });

  it("short-circuits the first stable release without a compare call", async () => {
    const { impl, calls } = lineageFetch({ latest: null });
    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v1.0.0",
        token,
        fetchImpl: impl as typeof fetch,
      }),
    ).resolves.toEqual({ status: "first-stable", targetTag: "v1.0.0" });
    expect(calls.some((url) => url.includes("/compare/"))).toBe(false);
  });

  it("fails closed when the compare endpoint errors", async () => {
    const { impl } = lineageFetch({
      latest: "v0.10.106",
      compares: {
        "v0.10.106...v0.10.107": { status: "behind", httpStatus: 502 },
      },
    });
    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v0.10.107",
        token,
        fetchImpl: impl as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 502/);
  });

  it("fails closed on an unrecognized compare status", async () => {
    const { impl } = lineageFetch({
      latest: "v0.10.106",
      compares: { "v0.10.106...v0.10.107": { status: "sideways" } },
    });
    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v0.10.107",
        token,
        fetchImpl: impl as typeof fetch,
      }),
    ).rejects.toThrow(/unrecognized compare status/);
  });

  it("compares the pinned built commit, not the re-resolved tag, when a head sha is given", async () => {
    // A tag force-moved to an ahead commit during the long native builds would
    // let a re-resolved tag pass; pinning the exact built commit makes the gate
    // evaluate the artifacts that actually exist, so the stale build is rejected.
    const builtSha = "0123456789abcdef0123456789abcdef01234567";
    const { impl, calls } = lineageFetch({
      latest: "v0.10.106",
      compares: {
        [`v0.10.106...${builtSha}`]: {
          status: "behind",
          ahead_by: 0,
          behind_by: 33,
        },
      },
    });
    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v0.10.107",
        headSha: builtSha,
        token,
        fetchImpl: impl as typeof fetch,
      }),
    ).rejects.toThrow(/v0\.10\.107 is behind public latest v0\.10\.106 by 33 commit/);
    expect(calls.some((url) => url.includes(`/compare/v0.10.106...${builtSha}`))).toBe(
      true,
    );
    expect(calls.some((url) => url.includes("/compare/v0.10.106...v0.10.107"))).toBe(
      false,
    );
  });

  it("counts withdrawn commits from behind_by and discloses compare truncation", () => {
    const summary = formatRollbackSummary({
      targetTag: "v0.10.107",
      latestTag: "v0.10.106",
      behindBy: 33,
      withdrawnCommits: [
        {
          sha: "b8e74e289d845c45c612cb99d4758202d22b6599",
          title: "fix: durable wedge clock",
        },
        { sha: "c1488b0314100fca5161e8a03ed6097b256f1a2b", title: "chore: bump" },
      ],
    });
    // The headline count is the authoritative behind_by (33), never the
    // enumerated length (2) which GitHub caps at 250.
    expect(summary).toContain("Withdrawing 33 merged commit(s)");
    expect(summary).toContain("(33 commit(s) behind)");
    expect(summary).toContain("…and 31 more not listed");
    expect(summary).toContain("`b8e74e289d84` fix: durable wedge clock");
  });

  it("omits the truncation note when every withdrawn commit is enumerated", () => {
    const summary = formatRollbackSummary({
      targetTag: "v0.10.107",
      latestTag: "v0.10.106",
      behindBy: 2,
      withdrawnCommits: [
        {
          sha: "b8e74e289d845c45c612cb99d4758202d22b6599",
          title: "fix: durable wedge clock",
        },
        { sha: "c1488b0314100fca5161e8a03ed6097b256f1a2b", title: "chore: bump" },
      ],
    });
    expect(summary).toContain("Withdrawing 2 merged commit(s)");
    expect(summary).not.toContain("more not listed");
  });
});
