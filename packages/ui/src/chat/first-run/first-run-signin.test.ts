/**
 * The first run's coding-tool sign-in: the repair card's browser sign-in with
 * a bounded wait, so a sign-in that never finishes ends in Retry and Skip for
 * now instead of an endless spinner.
 */
import { describe, expect, it, vi } from "vitest";

import { FIRST_RUN_SIGNIN_COPY, FIRST_RUN_SIGNIN_TIMEOUT_MS, runFirstRunSignIn } from "./first-run-signin.js";

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
    expect(sessions.loginStart).toHaveBeenCalledWith("codex", { force: true });
    expect(time.now() - start).toBeGreaterThanOrEqual(FIRST_RUN_SIGNIN_TIMEOUT_MS);
    expect(time.now() - start).toBeLessThanOrEqual(FIRST_RUN_SIGNIN_TIMEOUT_MS + 1500);
    expect(sessions.loginStatus.mock.calls.length).toBeLessThanOrEqual(Math.ceil(FIRST_RUN_SIGNIN_TIMEOUT_MS / 1500) + 1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
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
