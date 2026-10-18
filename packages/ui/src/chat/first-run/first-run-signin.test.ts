/**
 * The first run's coding-tool sign-in: the repair card's browser sign-in with
 * a bounded wait, so a sign-in that never finishes ends in Retry and Skip for
 * now instead of an endless spinner.
 */
import { describe, expect, it, vi } from "vitest";

import {
  FIRST_RUN_INSTALL_IDLE_GRACE_MS,
  FIRST_RUN_INSTALL_WAIT_MS,
  FIRST_RUN_SIGNIN_COPY,
  FIRST_RUN_SIGNIN_TIMEOUT_MS,
  runFirstRunSignIn,
  waitForToolInstall,
} from "./first-run-signin.js";
import { INSTALL_QUEUE_PROGRESS_EVENT, type InstallQueueHost } from "../../shell/finishing-setup.js";

const ok = <T>(value: T) => ({ ok: true as const, value });

function clock() {
  let at = 1_000;
  return {
    now: () => at,
    sleep: vi.fn(async (ms: number) => {
      at += ms;
    }),
  };
}

describe("runFirstRunSignIn", () => {
  it("waits about five minutes at most, then gives up", async () => {
    expect(FIRST_RUN_SIGNIN_TIMEOUT_MS).toBe(5 * 60_000);
    const time = clock();
    const start = time.now();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sessions = {
      loginStart: vi.fn(async () => ok({ state: "waiting" })),
      loginStatus: vi.fn(async () => ok({ state: "waiting" })),
    };
    const result = await runFirstRunSignIn("codex", { sessions, now: time.now, sleep: time.sleep, pollMs: 1500 });
    expect(result).toBe(false);
    expect(sessions.loginStart).toHaveBeenCalledWith("codex", { force: false });
    expect(time.now() - start).toBeGreaterThanOrEqual(FIRST_RUN_SIGNIN_TIMEOUT_MS);
    expect(time.now() - start).toBeLessThanOrEqual(FIRST_RUN_SIGNIN_TIMEOUT_MS + 1500);
    expect(sessions.loginStatus.mock.calls.length).toBeLessThanOrEqual(Math.ceil(FIRST_RUN_SIGNIN_TIMEOUT_MS / 1500) + 1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("never forces the sign-in, so a person already signed in is never signed out first", async () => {
    // The "already signed in" read can be wrong (a failed or slow preflight).
    // Unforced, the tool's own probe answers connected without a sign-out.
    const time = clock();
    const sessions = {
      loginStart: vi.fn(async () => ok({ state: "connected" })),
      loginStatus: vi.fn(async () => ok({ state: "waiting" })),
    };
    await expect(runFirstRunSignIn("claude", { sessions, now: time.now, sleep: time.sleep })).resolves.toBe(true);
    expect(sessions.loginStart).toHaveBeenCalledTimes(1);
    expect(sessions.loginStart).toHaveBeenCalledWith("claude", { force: false });
    expect(sessions.loginStatus).not.toHaveBeenCalled();

    const asked = { loginStart: vi.fn(async () => ok({ state: "connected" })), loginStatus: sessions.loginStatus };
    await runFirstRunSignIn("codex", { sessions: asked, force: true, now: time.now, sleep: time.sleep });
    expect(asked.loginStart).toHaveBeenCalledWith("codex", { force: false });
  });

  it("is true once the sign-in connects", async () => {
    const time = clock();
    const sessions = {
      loginStart: vi.fn(async () => ok({ state: "waiting" })),
      loginStatus: vi
        .fn()
        .mockResolvedValueOnce(ok({ state: "waiting" }))
        .mockResolvedValueOnce(ok({ state: "connected" })),
    };
    await expect(runFirstRunSignIn("claude", { sessions, now: time.now, sleep: time.sleep })).resolves.toBe(true);
    expect(sessions.loginStatus).toHaveBeenCalledTimes(2);
  });

  it("stops polling when cancelled and never throws", async () => {
    const time = clock();
    let stop = false;
    const sessions = {
      loginStart: vi.fn(async () => ok({ state: "waiting" })),
      loginStatus: vi.fn(async () => {
        stop = true;
        return ok({ state: "waiting" });
      }),
    };
    await expect(
      runFirstRunSignIn("codex", { sessions, now: time.now, sleep: time.sleep, cancelled: () => stop }),
    ).resolves.toBe(false);
    expect(sessions.loginStatus).toHaveBeenCalledTimes(1);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = {
      loginStart: vi.fn(async () => ok({ state: "waiting" })),
      loginStatus: vi.fn(async () => ok({ state: "waiting" })),
    };
    await expect(
      runFirstRunSignIn("codex", {
        sessions: broken,
        now: () => {
          throw new Error("clock gone");
        },
      }),
    ).resolves.toBe(false);
    warn.mockRestore();
  });

  it("names the tool while it waits", () => {
    expect(FIRST_RUN_SIGNIN_COPY.waiting("Claude Code")).toBe("Signing in to Claude Code…");
    expect(FIRST_RUN_SIGNIN_COPY.waiting("Codex")).toBe("Signing in to Codex…");
  });
});

describe("waitForToolInstall", () => {
  const status = (over: Record<string, unknown> = {}) => ({
    state: "running",
    current: "Codex",
    currentId: "codex",
    done: 4,
    total: 12,
    failed: [],
    unsettled: ["codex", "qmd"],
    unfinished: ["codex", "qmd"],
    ...over,
  });

  function fakeQueue(initial: unknown) {
    let current = initial;
    const handlers = new Map<string, (event: { payload?: unknown }) => void>();
    const unlisten = vi.fn();
    const queue: InstallQueueHost = {
      getStatus: vi.fn(async () => current),
      retry: vi.fn(async () => {
        current = status({ state: "idle", unsettled: ["codex"], unfinished: ["codex"] });
        return null;
      }),
      listen: vi.fn(async (event: string, handler: (event: { payload?: unknown }) => void) => {
        handlers.set(event, handler);
        return unlisten;
      }),
    };
    const emit = (payload: unknown) => {
      current = payload;
      handlers.get(INSTALL_QUEUE_PROGRESS_EVENT)?.({ payload });
    };
    return { queue, emit, unlisten };
  }

  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };

  it("bounds the wait above the queue's 20 minute tool install limit", () => {
    expect(FIRST_RUN_INSTALL_WAIT_MS).toBe(25 * 60_000);
  });

  it("does not wait for a tool the queue has already installed", async () => {
    const { queue } = fakeQueue(status({ unsettled: ["qmd"], unfinished: ["qmd"] }));
    expect(await waitForToolInstall("codex", queue, { cancelled: () => false })).toBe("present");
    expect(queue.listen).not.toHaveBeenCalled();
  });

  it("waits on the progress event until the item installs", async () => {
    const { queue, emit, unlisten } = fakeQueue(status());
    const result = waitForToolInstall("codex", queue, { cancelled: () => false, pollMs: 60_000 });
    await flush();
    expect(queue.listen).toHaveBeenCalledWith(INSTALL_QUEUE_PROGRESS_EVENT, expect.any(Function));
    emit(status({ current: "qmd", currentId: "qmd", unsettled: ["qmd"], unfinished: ["qmd"] }));
    expect(await result).toBe("installed");
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("reports a failed item as failed", async () => {
    const { queue, emit } = fakeQueue(status());
    const result = waitForToolInstall("codex", queue, { cancelled: () => false, pollMs: 60_000 });
    await flush();
    emit(status({ state: "attention", failed: ["codex"], unsettled: [], unfinished: ["codex"] }));
    expect(await result).toBe("failed");
  });

  it("a queue that stopped short of the item is failed, not an endless wait", async () => {
    const { queue } = fakeQueue(status({ state: "attention" }));
    expect(await waitForToolInstall("claude", queue, { cancelled: () => false })).toBe("present");
    expect(await waitForToolInstall("codex", queue, { cancelled: () => false })).toBe("failed");
    expect(queue.listen).not.toHaveBeenCalled();
    expect(queue.retry).not.toHaveBeenCalled();
  });

  it("an idle queue before the launch resume starts it is waited on, not failed", async () => {
    const { queue, emit } = fakeQueue(status({ state: "idle" }));
    const result = waitForToolInstall("codex", queue, { cancelled: () => false, pollMs: 60_000 });
    await flush();
    expect(queue.listen).toHaveBeenCalledWith(INSTALL_QUEUE_PROGRESS_EVENT, expect.any(Function));
    emit(status());
    await flush();
    emit(status({ current: "qmd", currentId: "qmd", unsettled: ["qmd"], unfinished: ["qmd"] }));
    expect(await result).toBe("installed");
    expect(queue.retry).not.toHaveBeenCalled();
  });

  it("an idle queue that never starts within the grace is failed", async () => {
    vi.useFakeTimers();
    try {
      const { queue } = fakeQueue(status({ state: "idle" }));
      let settled: string | null = null;
      void waitForToolInstall("codex", queue, { cancelled: () => false, pollMs: 2_000 }).then((r) => {
        settled = r;
      });
      await vi.advanceTimersByTimeAsync(FIRST_RUN_INSTALL_IDLE_GRACE_MS - 1);
      expect(settled).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe("failed");
      expect(queue.retry).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up at the bound", async () => {
    const { queue } = fakeQueue(status());
    expect(await waitForToolInstall("codex", queue, { cancelled: () => false, timeoutMs: 5, pollMs: 1 })).toBe("failed");
  });

  it("stops when cancelled", async () => {
    let cancelled = false;
    const { queue } = fakeQueue(status());
    const result = waitForToolInstall("codex", queue, { cancelled: () => cancelled, pollMs: 1 });
    cancelled = true;
    expect(await result).toBe("failed");
  });

  it("Retry queues a failed item again and waits through the runner's idle first status", async () => {
    const { queue, emit } = fakeQueue(status({ state: "attention", failed: ["codex"], unsettled: [], unfinished: ["codex"] }));
    const result = waitForToolInstall("codex", queue, { cancelled: () => false, retry: true, pollMs: 60_000 });
    await flush();
    expect(queue.retry).toHaveBeenCalledTimes(1);
    emit(status({ state: "complete", unsettled: [], unfinished: [] }));
    expect(await result).toBe("installed");
  });

  it("a tool blocked by a failed prerequisite is failed, and Retry queues the queue's failures again", async () => {
    const blockedStatus = status({ state: "attention", failed: ["node"], unsettled: [], unfinished: ["node", "codex"] });
    const { queue, emit } = fakeQueue(blockedStatus);
    expect(await waitForToolInstall("codex", queue, { cancelled: () => false })).toBe("failed");
    expect(queue.retry).not.toHaveBeenCalled();
    const result = waitForToolInstall("codex", queue, { cancelled: () => false, retry: true, pollMs: 60_000 });
    await flush();
    expect(queue.retry).toHaveBeenCalledTimes(1);
    emit(status({ state: "complete", unsettled: [], unfinished: [] }));
    expect(await result).toBe("installed");
  });

  it("Retry does not re-queue an item that is still running", async () => {
    const { queue, emit } = fakeQueue(status());
    const result = waitForToolInstall("codex", queue, { cancelled: () => false, retry: true, pollMs: 60_000 });
    await flush();
    emit(status({ unsettled: [], unfinished: [] }));
    expect(await result).toBe("installed");
    expect(queue.retry).not.toHaveBeenCalled();
  });

  it("an older payload with no unsettled list waits while the queue runs", async () => {
    const { queue, emit } = fakeQueue(status({ unsettled: undefined, unfinished: undefined }));
    const result = waitForToolInstall("codex", queue, { cancelled: () => false, pollMs: 60_000 });
    await flush();
    emit(status({ state: "complete", unsettled: undefined, unfinished: undefined }));
    expect(await result).toBe("installed");
  });

  it("a tool the queue does not install never waits", async () => {
    const { queue } = fakeQueue(status());
    expect(await waitForToolInstall("grok", queue, { cancelled: () => false })).toBe("present");
    expect(queue.getStatus).not.toHaveBeenCalled();
  });

  it("no readable status means nothing to wait for", async () => {
    const { queue } = fakeQueue(null);
    expect(await waitForToolInstall("codex", queue, { cancelled: () => false })).toBe("present");
  });
});
