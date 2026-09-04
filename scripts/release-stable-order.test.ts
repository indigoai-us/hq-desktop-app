import { describe, expect, it } from "vitest";

import {
  compareStableTags,
  confirmReleaseChannel,
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

  it("confirms a staged stable tag has not become latest yet", async () => {
    const fetchImpl = async () => latestResponse("v1.2.3");
    await expect(
      confirmReleaseChannel({
        repository,
        targetTag: "v1.3.0",
        makeLatest: false,
        token,
        fetchImpl: fetchImpl as typeof fetch,
        attempts: 1,
        retryDelayMs: 0,
      }),
    ).resolves.toEqual({
      status: "staged-not-latest",
      targetTag: "v1.3.0",
      latestTag: "v1.2.3",
    });
  });

  it("fails closed if a staged stable tag became latest before promotion", async () => {
    const fetchImpl = async () => latestResponse("v1.3.0");
    await expect(
      confirmReleaseChannel({
        repository,
        targetTag: "v1.3.0",
        makeLatest: false,
        token,
        fetchImpl: fetchImpl as typeof fetch,
        attempts: 1,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow("unexpectedly became latest before promotion");
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

type LineageHandlers = {
  latest: () => Response;
  compare?: (base: string, head: string, page: number) => Response;
  ref?: (tag: string) => Response;
  tagObject?: (sha: string) => Response;
  onCompare?: (base: string, head: string) => void;
};

// A URL-dispatching fetch stub, since the lineage gate reads four distinct
// GitHub endpoints (releases/latest, compare, git/ref/tags, git/tags) in one
// call rather than the single endpoint the order gate hits.
function lineageFetch(handlers: LineageHandlers): typeof fetch {
  return (async (input: string | URL) => {
    const href = String(input);
    if (href.includes("/releases/latest")) {
      return handlers.latest();
    }
    if (href.includes("/git/ref/tags/")) {
      const tag = href.slice(href.indexOf("/git/ref/tags/") + "/git/ref/tags/".length);
      if (!handlers.ref) throw new Error(`unexpected tag ref request: ${tag}`);
      return handlers.ref(tag);
    }
    if (href.includes("/git/tags/")) {
      const sha = href.slice(href.indexOf("/git/tags/") + "/git/tags/".length);
      if (!handlers.tagObject) throw new Error(`unexpected tag object request: ${sha}`);
      return handlers.tagObject(sha);
    }
    if (href.includes("/compare/")) {
      const spec = href.slice(href.indexOf("/compare/") + "/compare/".length);
      const [range, query] = spec.split("?");
      const [base, head] = range.split("...");
      const page = Number(new URLSearchParams(query ?? "").get("page") ?? "1");
      handlers.onCompare?.(base, head);
      if (!handlers.compare) throw new Error(`unexpected compare request: ${range}`);
      return handlers.compare(base, head, page);
    }
    throw new Error(`unexpected URL: ${href}`);
  }) as unknown as typeof fetch;
}

describe("stable release lineage (commit ancestry gate)", () => {
  it("rejects a higher tag whose commit is behind public latest (v0.10.106 -> v0.10.107)", async () => {
    // The exact production shape that reopened this lane: v0.10.107 carried a
    // bigger number but sat on the pre-fix v0.10.105 commit, 33 commits behind.
    const fetchImpl = lineageFetch({
      latest: () => jsonResponse({ tag_name: "v0.10.106" }),
      compare: () => jsonResponse({ status: "behind", ahead_by: 0, behind_by: 33 }),
      ref: () => jsonResponse({ object: { type: "tag", sha: "tagobj-107" } }),
      tagObject: () =>
        jsonResponse({
          message: "HQ v0.10.107 - rollback to last pre-v2-chat stable (v0.10.105)\n",
        }),
    });

    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v0.10.107",
        token,
        fetchImpl,
      }),
    ).rejects.toThrow(
      /Refusing stable lineage rollback: v0\.10\.107 is behind public latest v0\.10\.106 by 33 commit/,
    );
  });

  it("rejects the second recorded rollback (v0.10.108 -> v0.10.109, behind 49)", async () => {
    const fetchImpl = lineageFetch({
      latest: () => jsonResponse({ tag_name: "v0.10.108" }),
      compare: () => jsonResponse({ status: "behind", ahead_by: 0, behind_by: 49 }),
      // A lightweight tag (ref object type "commit") carries no message, so the
      // declared-rollback escape hatch cannot apply — it fails closed.
      ref: () => jsonResponse({ object: { type: "commit", sha: "commit-109" } }),
    });

    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v0.10.109",
        token,
        fetchImpl,
      }),
    ).rejects.toThrow(
      /Refusing stable lineage rollback: v0\.10\.109 is behind public latest v0\.10\.108 by 49 commit/,
    );
  });

  it("rejects a diverged tag cut from a side branch", async () => {
    const fetchImpl = lineageFetch({
      latest: () => jsonResponse({ tag_name: "v0.10.106" }),
      compare: () => jsonResponse({ status: "diverged", ahead_by: 5, behind_by: 7 }),
      ref: () => jsonResponse({ object: { type: "commit", sha: "commit-107" } }),
    });

    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v0.10.107",
        token,
        fetchImpl,
      }),
    ).rejects.toThrow(/Refusing stable lineage rollback: v0\.10\.107 is diverged/);
  });

  it("allows a stable tag that descends from public latest (real v0.10.105 -> v0.10.106)", async () => {
    let compareCalls = 0;
    const fetchImpl = lineageFetch({
      latest: () => jsonResponse({ tag_name: "v0.10.105" }),
      onCompare: () => {
        compareCalls += 1;
      },
      compare: () => jsonResponse({ status: "ahead", ahead_by: 33, behind_by: 0 }),
    });

    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v0.10.106",
        token,
        fetchImpl,
      }),
    ).resolves.toEqual({
      status: "advance",
      targetTag: "v0.10.106",
      latestTag: "v0.10.105",
    });
    expect(compareCalls).toBe(1);
  });

  it("allows an identical stable rerun by lineage", async () => {
    const fetchImpl = lineageFetch({
      latest: () => jsonResponse({ tag_name: "v0.10.106" }),
      compare: () => jsonResponse({ status: "identical", ahead_by: 0, behind_by: 0 }),
    });

    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v0.10.106",
        token,
        fetchImpl,
      }),
    ).resolves.toEqual({
      status: "rerun",
      targetTag: "v0.10.106",
      latestTag: "v0.10.106",
    });
  });

  it("allows a declared rollback whose trailer names the current public latest", async () => {
    const fetchImpl = lineageFetch({
      latest: () => jsonResponse({ tag_name: "v0.10.106" }),
      compare: (base, head) => {
        if (base === "v0.10.106" && head === "v0.10.107") {
          return jsonResponse({ status: "behind", ahead_by: 0, behind_by: 33 });
        }
        if (base === "v0.10.107" && head === "v0.10.106") {
          return jsonResponse({
            status: "ahead",
            ahead_by: 2,
            behind_by: 0,
            total_commits: 2,
            commits: [
              { sha: "aaaaaaaaaaaa1", commit: { message: "fix: durable wedge clock\n\nbody" } },
              { sha: "bbbbbbbbbbbb2", commit: { message: "test: cap regression coverage" } },
            ],
          });
        }
        throw new Error(`unexpected compare ${base}...${head}`);
      },
      ref: () => jsonResponse({ object: { type: "tag", sha: "tagobj-107" } }),
      tagObject: () =>
        jsonResponse({
          message: "HQ v0.10.107 emergency rollback\n\nRollback-Of: v0.10.106\n",
        }),
    });

    const result = await verifyStableReleaseLineage({
      repository,
      targetTag: "v0.10.107",
      token,
      fetchImpl,
    });

    expect(result).toMatchObject({
      status: "declared-rollback",
      targetTag: "v0.10.107",
      latestTag: "v0.10.106",
      rollbackOf: "v0.10.106",
    });
    expect(result.withdrawnCount).toBe(2);
    expect(result.withdrawnCommits).toHaveLength(2);
    expect(result.withdrawnCommits[0]).toEqual({
      sha: "aaaaaaaaaaaa1",
      title: "fix: durable wedge clock",
    });
  });

  it("rejects a rollback trailer that names a tag other than public latest", async () => {
    const fetchImpl = lineageFetch({
      latest: () => jsonResponse({ tag_name: "v0.10.106" }),
      compare: () => jsonResponse({ status: "behind", ahead_by: 0, behind_by: 33 }),
      ref: () => jsonResponse({ object: { type: "tag", sha: "tagobj-107" } }),
      // A stale or copied trailer names a different (older) latest — must not
      // validate against the actual current public latest.
      tagObject: () =>
        jsonResponse({ message: "HQ v0.10.107\n\nRollback-Of: v0.10.100\n" }),
    });

    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v0.10.107",
        token,
        fetchImpl,
      }),
    ).rejects.toThrow(/Refusing stable lineage rollback: v0\.10\.107 is behind/);
  });

  it("short-circuits to first-stable without a compare call when no public latest exists", async () => {
    let compareCalls = 0;
    const fetchImpl = lineageFetch({
      latest: () => new Response(null, { status: 404 }),
      onCompare: () => {
        compareCalls += 1;
      },
      compare: () => jsonResponse({ status: "ahead" }),
    });

    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v1.0.0",
        token,
        fetchImpl,
      }),
    ).resolves.toEqual({ status: "first-stable", targetTag: "v1.0.0" });
    expect(compareCalls).toBe(0);
  });

  it("fails closed on an unrecognized compare status", async () => {
    const fetchImpl = lineageFetch({
      latest: () => jsonResponse({ tag_name: "v0.10.106" }),
      compare: () => jsonResponse({ status: "sideways" }),
    });

    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v0.10.107",
        token,
        fetchImpl,
      }),
    ).rejects.toThrow(/unrecognized compare status 'sideways'/);
  });

  it("fails closed when the compare endpoint errors", async () => {
    const fetchImpl = lineageFetch({
      latest: () => jsonResponse({ tag_name: "v0.10.106" }),
      compare: () => new Response(null, { status: 503 }),
    });

    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v0.10.107",
        token,
        fetchImpl,
      }),
    ).rejects.toThrow("HTTP 503");
  });

  it("paginates the withdrawn-commit comparison so a large rollback is not undercounted", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      sha: `p1-${i}`,
      commit: { message: `fix ${i}` },
    }));
    const secondPage = Array.from({ length: 50 }, (_, i) => ({
      sha: `p2-${i}`,
      commit: { message: `fix ${100 + i}` },
    }));
    const fetchImpl = lineageFetch({
      latest: () => jsonResponse({ tag_name: "v0.10.106" }),
      compare: (base, head, page) => {
        if (base === "v0.10.106" && head === "v0.10.107") {
          return jsonResponse({
            status: "behind",
            ahead_by: 0,
            behind_by: 150,
            total_commits: 150,
          });
        }
        // Reverse compare (withdrawn commits) truncates at 100/page.
        return jsonResponse({
          status: "ahead",
          ahead_by: 150,
          behind_by: 0,
          total_commits: 150,
          commits: page === 1 ? firstPage : secondPage,
        });
      },
      ref: () => jsonResponse({ object: { type: "tag", sha: "tagobj" } }),
      tagObject: () => jsonResponse({ message: "rollback\n\nRollback-Of: v0.10.106\n" }),
    });

    const result = await verifyStableReleaseLineage({
      repository,
      targetTag: "v0.10.107",
      token,
      fetchImpl,
    });

    expect(result.status).toBe("declared-rollback");
    expect(result.withdrawnCount).toBe(150);
    expect(result.withdrawnCommits).toHaveLength(150);
  });

  it("rejects a Rollback-Of mention that is not in the tag's trailer block", async () => {
    const fetchImpl = lineageFetch({
      latest: () => jsonResponse({ tag_name: "v0.10.106" }),
      compare: () => jsonResponse({ status: "behind", ahead_by: 0, behind_by: 33 }),
      ref: () => jsonResponse({ object: { type: "tag", sha: "tagobj-107" } }),
      // The trailer text appears only in the body; the message ends with prose,
      // so there is no real trailer block declaring the rollback.
      tagObject: () =>
        jsonResponse({
          message:
            "HQ v0.10.107\n\nThis mentions Rollback-Of: v0.10.106 but only in prose.\n\nNot a trailer.\n",
        }),
    });

    await expect(
      verifyStableReleaseLineage({
        repository,
        targetTag: "v0.10.107",
        token,
        fetchImpl,
      }),
    ).rejects.toThrow(/Refusing stable lineage rollback: v0\.10\.107 is behind/);
  });

  it("reads the terminal trailer block, not an earlier body mention", async () => {
    const fetchImpl = lineageFetch({
      latest: () => jsonResponse({ tag_name: "v0.10.106" }),
      compare: (base, head) => {
        if (base === "v0.10.106" && head === "v0.10.107") {
          return jsonResponse({ status: "behind", ahead_by: 0, behind_by: 33 });
        }
        return jsonResponse({
          status: "ahead",
          ahead_by: 1,
          behind_by: 0,
          total_commits: 1,
          commits: [{ sha: "c1", commit: { message: "fix" } }],
        });
      },
      ref: () => jsonResponse({ object: { type: "tag", sha: "tagobj-107" } }),
      // An earlier body line names a different tag; only the final trailer block
      // (naming the real current public latest) authorizes the rollback.
      tagObject: () =>
        jsonResponse({
          message:
            "HQ v0.10.107\n\nEarlier we discussed Rollback-Of: v0.10.999\n\nRollback-Of: v0.10.106\n",
        }),
    });

    const result = await verifyStableReleaseLineage({
      repository,
      targetTag: "v0.10.107",
      token,
      fetchImpl,
    });

    expect(result.status).toBe("declared-rollback");
    expect(result.rollbackOf).toBe("v0.10.106");
  });
});
