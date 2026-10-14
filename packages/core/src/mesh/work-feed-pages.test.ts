import { describe, expect, it, vi } from "vitest";

import {
  WORK_FEED_MAX_PAGES,
  WorkFeedPagingError,
  fetchWorkFeedPages,
  isWorkFeedPath,
  workFeedPagePath,
} from "./work-feed-pages.js";

const SYNC = "c".repeat(40);

function row(threadId: string, lastActivityAt = "2026-10-14T00:00:00.000Z") {
  return { threadId, projectId: `proj_${threadId}`, lastActivityAt };
}

describe("fetchWorkFeedPages", () => {
  it("merges open and changed across pages and drops the paging fields", async () => {
    const pages: Record<string, unknown> = {
      first: {
        contractVersion: 2,
        cursor: SYNC,
        cursorExpiresAt: "2026-10-15T00:00:00.000Z",
        reset: false,
        open: [row("t1"), row("t2")],
        changed: [],
        hasMore: true,
        nextCursor: "p2",
      },
      p2: {
        contractVersion: 2,
        cursor: SYNC,
        open: [row("t3")],
        changed: [row("t4")],
        hasMore: true,
        nextCursor: "p3",
      },
      p3: {
        contractVersion: 2,
        cursor: SYNC,
        open: [],
        changed: [row("t5")],
        hasMore: false,
      },
    };
    const fetchPage = vi.fn(async (pageCursor: string | undefined) =>
      pages[pageCursor ?? "first"],
    );

    const result = await fetchWorkFeedPages(fetchPage);

    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([undefined, "p2", "p3"]);
    expect(result.pages).toBe(3);
    expect(result.truncated).toBe(false);
    const state = result.state as Record<string, unknown>;
    expect((state.open as Array<{ threadId: string }>).map((r) => r.threadId)).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
    expect((state.changed as Array<{ threadId: string }>).map((r) => r.threadId)).toEqual([
      "t4",
      "t5",
    ]);
    expect(state.cursor).toBe(SYNC);
    expect(state.cursorExpiresAt).toBe("2026-10-15T00:00:00.000Z");
    expect(state.contractVersion).toBe(2);
    expect(state.hasMore).toBe(false);
    expect(state).not.toHaveProperty("nextCursor");
  });

  it("treats a response without hasMore as a single page (pre-paging servers)", async () => {
    const legacy = { cursor: SYNC, open: [row("t1")], changed: [row("t2")] };
    const fetchPage = vi.fn(async () => legacy);

    const result = await fetchWorkFeedPages(fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(undefined);
    expect(result).toMatchObject({ pages: 1, truncated: false });
    expect(result.state).toMatchObject({
      cursor: SYNC,
      open: [row("t1")],
      changed: [row("t2")],
    });
  });

  it("returns a single-page response untouched", async () => {
    const legacy = { cursor: SYNC, open: [row("t1")], changed: [] };
    const result = await fetchWorkFeedPages(async () => legacy);
    expect(result.state).toBe(legacy);
  });

  it("ignores a nextCursor when hasMore is not true", async () => {
    const fetchPage = vi.fn(async () => ({
      cursor: SYNC,
      open: [row("t1")],
      hasMore: false,
      nextCursor: "stale",
    }));

    const result = await fetchWorkFeedPages(fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(result.truncated).toBe(false);
    expect(result.state).toMatchObject({ hasMore: false });
  });

  it("returns a non-object first page untouched", async () => {
    const fetchPage = vi.fn(async () => null);
    await expect(fetchWorkFeedPages(fetchPage)).resolves.toEqual({
      state: null,
      pages: 1,
      truncated: false,
    });
  });

  it("stops at the page cap with a warning and keeps the newest rows", async () => {
    let n = 0;
    const fetchPage = vi.fn(async () => {
      n += 1;
      return {
        cursor: SYNC,
        open: [row(`t${n}`)],
        changed: [],
        hasMore: true,
        nextCursor: `p${n + 1}`,
      };
    });
    const warn = vi.fn();

    const result = await fetchWorkFeedPages(fetchPage, { maxPages: 3, warn });

    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(result.pages).toBe(3);
    expect(result.truncated).toBe(true);
    const state = result.state as Record<string, unknown>;
    expect((state.open as unknown[]).length).toBe(3);
    expect(state.hasMore).toBe(true);
    expect(state.nextCursor).toBe("p4");
    expect(warn).toHaveBeenCalledWith(
      "[hq-work-feed] page cap reached",
      expect.objectContaining({ event: "page-cap", pages: 3, maxPages: 3 }),
    );
  });

  it("defaults the page cap to WORK_FEED_MAX_PAGES", async () => {
    let n = 0;
    const fetchPage = vi.fn(async () => {
      n += 1;
      return { cursor: SYNC, open: [row(`t${n}`)], hasMore: true, nextCursor: `p${n + 1}` };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchWorkFeedPages(fetchPage);

    expect(fetchPage).toHaveBeenCalledTimes(WORK_FEED_MAX_PAGES);
    expect(WORK_FEED_MAX_PAGES).toBe(50);
    expect(result.truncated).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "[hq-work-feed] page cap reached",
      expect.objectContaining({ event: "page-cap" }),
    );
    warn.mockRestore();
  });

  it("stops when the server repeats a page cursor", async () => {
    const fetchPage = vi.fn(async () => ({
      cursor: SYNC,
      open: [row("t1")],
      hasMore: true,
      nextCursor: "same",
    }));
    const warn = vi.fn();

    const result = await fetchWorkFeedPages(fetchPage, { warn });

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.truncated).toBe(true);
    expect((result.state as { open: unknown[] }).open).toEqual([row("t1")]);
    expect(warn).toHaveBeenCalledWith(
      "[hq-work-feed] page cursor repeated",
      expect.objectContaining({ event: "page-cursor-repeat" }),
    );
  });

  it("propagates a first-page error unchanged", async () => {
    const boom = new Error("first page failed");
    await expect(
      fetchWorkFeedPages(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it("throws WorkFeedPagingError with the merged rows when a later page fails", async () => {
    const boom = new Error("page 3 failed");
    const fetchPage = vi.fn(async (pageCursor: string | undefined) => {
      if (pageCursor === undefined) {
        return { cursor: SYNC, open: [row("t1")], hasMore: true, nextCursor: "p2" };
      }
      if (pageCursor === "p2") {
        return { cursor: SYNC, changed: [row("t2")], hasMore: true, nextCursor: "p3" };
      }
      throw boom;
    });

    const error = await fetchWorkFeedPages(fetchPage).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkFeedPagingError);
    const paging = error as WorkFeedPagingError;
    expect(paging.failure).toBe(boom);
    expect(paging.partial.pages).toBe(2);
    expect(paging.partial.truncated).toBe(true);
    expect(paging.partial.state).toMatchObject({
      cursor: SYNC,
      open: [row("t1")],
      changed: [row("t2")],
      hasMore: true,
    });
  });

  it("throws WorkFeedPagingError when a later page is not an object", async () => {
    const fetchPage = vi.fn(async (pageCursor: string | undefined) =>
      pageCursor === undefined
        ? { cursor: SYNC, open: [row("t1")], hasMore: true, nextCursor: "p2" }
        : null,
    );
    await expect(fetchWorkFeedPages(fetchPage)).rejects.toBeInstanceOf(
      WorkFeedPagingError,
    );
  });

  it("restarts the merge when the sync cursor changes mid-walk", async () => {
    const other = "d".repeat(40);
    const fetchPage = vi.fn(async (pageCursor: string | undefined) => {
      if (pageCursor === undefined) {
        return { cursor: SYNC, open: [row("t1")], hasMore: true, nextCursor: "p2" };
      }
      if (pageCursor === "p2") {
        // Server restarted the walk at page one with a new sync cursor.
        return { cursor: other, open: [row("t1"), row("t2")], hasMore: true, nextCursor: "q2" };
      }
      return { cursor: other, changed: [row("t3")], hasMore: false };
    });
    const warn = vi.fn();

    const result = await fetchWorkFeedPages(fetchPage, { warn });

    const state = result.state as Record<string, unknown>;
    expect(state.cursor).toBe(other);
    expect(state.open).toEqual([row("t1"), row("t2")]);
    expect(state.changed).toEqual([row("t3")]);
    expect(warn).toHaveBeenCalledWith(
      "[hq-work-feed] sync cursor changed mid-walk; restarting merge",
      expect.objectContaining({ event: "walk-restart" }),
    );
  });

  it("drops a row repeated across pages in the same section", async () => {
    const fetchPage = vi.fn(async (pageCursor: string | undefined) =>
      pageCursor === undefined
        ? { cursor: SYNC, open: [row("t1")], hasMore: true, nextCursor: "p2" }
        : { cursor: SYNC, open: [row("t1"), row("t2")], hasMore: false },
    );

    const result = await fetchWorkFeedPages(fetchPage);

    expect((result.state as { open: unknown[] }).open).toEqual([row("t1"), row("t2")]);
  });
});

describe("workFeedPagePath", () => {
  it("keeps the first-page path unchanged", () => {
    expect(workFeedPagePath("/v1/work-mesh/work", undefined, undefined)).toBe(
      "/v1/work-mesh/work",
    );
    expect(workFeedPagePath("/v1/work-mesh/work", SYNC, undefined)).toBe(
      `/v1/work-mesh/work?cursor=${SYNC}`,
    );
  });

  it("sends the same sync cursor with the page cursor", () => {
    expect(workFeedPagePath("/v1/work-mesh/work", SYNC, "abc_-1")).toBe(
      `/v1/work-mesh/work?cursor=${SYNC}&pageCursor=abc_-1`,
    );
  });
});

describe("isWorkFeedPath", () => {
  it("matches only the work feed route", () => {
    expect(isWorkFeedPath("/v1/work-mesh/work")).toBe(true);
    expect(isWorkFeedPath("/v1/work-mesh/work?cursor=x")).toBe(true);
    expect(isWorkFeedPath("/v1/work-mesh/work-sessions")).toBe(false);
    expect(isWorkFeedPath("/v1/notify/inbox")).toBe(false);
  });
});
