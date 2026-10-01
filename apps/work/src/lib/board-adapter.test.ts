import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlatformAdapter } from "@hq/platform";

import { createBoardDataApi, WORK_MESH_PATHS } from "./board-adapter.js";

function createApi(fetchFn: typeof fetch) {
  return createBoardDataApi({} as PlatformAdapter, fetchFn);
}

function rejectWhenAborted(signal: AbortSignal | null | undefined) {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener(
      "abort",
      () => reject(new DOMException("aborted", "AbortError")),
      { once: true },
    );
  });
}

function responseWithStalledBody(signal: AbortSignal | null | undefined) {
  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, "json", {
    value: () =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      }),
  });
  return response;
}

describe("board thread request deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("bounds a stalled thread-list request and keeps the empty result", async () => {
    const fetchFn = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      rejectWhenAborted(init?.signal),
    ) as unknown as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = createApi(fetchFn).listThreads();
    await Promise.resolve();
    expect(vi.mocked(fetchFn).mock.calls[0]?.[1]?.signal).toBeDefined();

    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toEqual([]);

    expect(warn).toHaveBeenCalledWith(
      "[hq-work-board] thread request failed",
      expect.objectContaining({ endpoint: "threads", event: "timeout" }),
    );
  });

  it("bounds a stalled thread body read and keeps the missing-thread result", async () => {
    const fetchFn = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(responseWithStalledBody(init?.signal)),
    ) as unknown as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = createApi(fetchFn).getThread("cmp_1", "thread_1");
    await Promise.resolve();
    expect(vi.mocked(fetchFn).mock.calls[0]?.[1]?.signal).toBeDefined();

    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith(
      "[hq-work-board] thread request failed",
      expect.objectContaining({ endpoint: "thread", event: "timeout" }),
    );
  });

  it("logs request and JSON failures while retaining thread fallbacks", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret transport detail"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error("private body detail")),
      } as Response) as unknown as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = createApi(fetchFn);

    await expect(api.listThreads()).resolves.toEqual([]);
    await expect(api.getThread("cmp_1", "thread_1")).resolves.toBeNull();

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      "[hq-work-board] thread request failed",
      expect.objectContaining({
        endpoint: "threads",
        event: "transport-error",
      }),
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      "[hq-work-board] thread request failed",
      expect.objectContaining({ endpoint: "thread", event: "body-error" }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      "secret transport detail",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      "private body detail",
    );

    const absentSafeFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(
        new Response("", { status: 501 }),
      ) as unknown as typeof fetch;
    const sessionsApi = createApi(absentSafeFetch);
    await expect(sessionsApi.listWorkSessions()).resolves.toEqual([]);
    expect(absentSafeFetch).toHaveBeenNthCalledWith(
      1,
      WORK_MESH_PATHS.workSessions,
      undefined,
    );
    await expect(sessionsApi.listWorkSessions()).resolves.toEqual([]);
  });
});
