import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkFeedPagingError } from "@hq/core";

import { createHqReconcileFetcher } from "./mesh-runtime.js";

const SYNC_IN = "a".repeat(40);
const SYNC_OUT = "b".repeat(40);
const FEED = "/v1/work-mesh/work";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function workRow(threadId: string) {
  return {
    threadId,
    projectId: `proj_${threadId}`,
    lastActivityAt: "2026-10-14T00:00:00.000Z",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createHqReconcileFetcher work feed paging", () => {
  it("pages the work feed with the same sync cursor and merges rows", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://local.invalid");
      if (!url.searchParams.get("pageCursor")) {
        return json({
          cursor: SYNC_OUT,
          open: [workRow("t1")],
          changed: [],
          hasMore: true,
          nextCursor: "p2",
        });
      }
      return json({
        cursor: SYNC_OUT,
        open: [],
        changed: [workRow("t2")],
        hasMore: false,
      });
    });

    const result = await createHqReconcileFetcher(
      fetchImpl as unknown as typeof fetch,
    )({ path: FEED }, SYNC_IN);

    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual([
      FEED + "?cursor=" + SYNC_IN,
      FEED + "?cursor=" + SYNC_IN + "&pageCursor=p2",
    ]);
    expect(result.cursor).toBe(SYNC_OUT);
    expect(result.state).toMatchObject({
      open: [workRow("t1")],
      changed: [workRow("t2")],
      hasMore: false,
    });
    expect(result.state).not.toHaveProperty("nextCursor");
  });

  it("makes a single request when the server sends no hasMore", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) =>
      json({ cursor: SYNC_OUT, open: [workRow("t1")], changed: [] }),
    );

    const result = await createHqReconcileFetcher(
      fetchImpl as unknown as typeof fetch,
    )({ path: FEED }, undefined);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(FEED);
    expect(result).toEqual({
      state: { cursor: SYNC_OUT, open: [workRow("t1")], changed: [] },
      cursor: SYNC_OUT,
    });
  });

  it("throws on a later-page failure so the sync cursor does not advance", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("pageCursor=")
        ? json({}, 503)
        : json({
            cursor: SYNC_OUT,
            open: [workRow("t1")],
            hasMore: true,
            nextCursor: "p2",
          }),
    );

    const error = await createHqReconcileFetcher(
      fetchImpl as unknown as typeof fetch,
    )({ path: FEED }, SYNC_IN).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkFeedPagingError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns no cursor when the page cap stops the walk", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return json({
        cursor: SYNC_OUT,
        open: [workRow(`t${n}`)],
        hasMore: true,
        nextCursor: `p${n + 1}`,
      });
    });

    const result = await createHqReconcileFetcher(
      fetchImpl as unknown as typeof fetch,
    )({ path: FEED }, SYNC_IN);

    expect(fetchImpl).toHaveBeenCalledTimes(50);
    expect(result.cursor).toBeUndefined();
    expect((result.state as { open: unknown[] }).open).toHaveLength(50);
    expect(warn).toHaveBeenCalledWith(
      "[hq-work-feed] page cap reached",
      expect.objectContaining({ event: "page-cap" }),
    );
  });

  it("does not page other routes that return nextCursor", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ cursor: SYNC_OUT, hasMore: true, nextCursor: "inbox_page_2" }),
    );

    const result = await createHqReconcileFetcher(
      fetchImpl as unknown as typeof fetch,
    )({ path: "/v1/notify/inbox" }, SYNC_IN);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.cursor).toBe(SYNC_OUT);
  });
});
