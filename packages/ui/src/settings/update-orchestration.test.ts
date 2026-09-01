import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_UPDATE_CHECK_TIMEOUT_MS,
  appStatusFrom,
  cliStatusFrom,
  coreStatusFrom,
  probeFailure,
  runUpdateCheck,
} from "./update-orchestration";

const ok = <T,>(value: T) => ({ ok: true as const, value });
const fail = (reason: string, message = "boom") => ({
  ok: false as const,
  reason,
  message,
});

function adapter(overrides: Partial<Record<string, () => Promise<unknown>>> = {}) {
  return {
    getVersions: overrides.getVersions ?? (async () => ok({ core: "15.0.118", cli: "1.2.3" })),
    checkForUpdates: overrides.checkForUpdates ?? (async () => ok(null)),
    checkCoreState:
      overrides.checkCoreState ?? (async () => ok({ versionBehind: false })),
    checkCliUpdate: overrides.checkCliUpdate ?? (async () => ok(null)),
  } as never;
}

describe("update orchestration status mapping (adopted from the native pane)", () => {
  it("maps app results", () => {
    expect(appStatusFrom(ok(null))).toBe("up-to-date");
    expect(appStatusFrom(ok({ version: "1.0.0" }))).toBe("available");
    expect(appStatusFrom(fail("invoke"))).toBe("unchecked");
    expect(appStatusFrom(fail("timeout"))).toBe("failed");
  });

  it("maps core results including probe failure and unlocated root", () => {
    expect(coreStatusFrom(ok({ versionBehind: false }), "15.0.118", null)).toBe(
      "up-to-date",
    );
    expect(coreStatusFrom(ok({ versionBehind: true }), "15.0.118", null)).toBe(
      "available",
    );
    expect(coreStatusFrom(ok(null), null, null)).toBe("unlocated");
    expect(coreStatusFrom(fail("invoke"), null, null)).toBe("unchecked");
    expect(coreStatusFrom(ok(null), "15.0.118", "probe blew up")).toBe("failed");
    expect(coreStatusFrom(fail("timeout"), "15.0.118", null)).toBe("failed");
  });

  it("maps cli results", () => {
    expect(cliStatusFrom(ok(null), "1.2.3", null)).toBe("up-to-date");
    expect(cliStatusFrom(ok({ latest: "1.3.0" }), "1.2.3", null)).toBe("available");
    expect(cliStatusFrom(ok(null), null, null)).toBe("unlocated");
    expect(cliStatusFrom(fail("timeout"), "1.2.3", null)).toBe("failed");
  });

  it("reads the native probe failure envelope", () => {
    expect(probeFailure(undefined)).toBeNull();
    expect(probeFailure({ status: "ok" })).toBeNull();
    expect(probeFailure({ status: "failed", message: " nope " })).toBe("nope");
    expect(probeFailure({ status: "failed" })).toBe("The native version probe failed.");
  });
});

describe("regression: busy state always resolves", () => {
  it("never leaves a row checking when one call hangs forever", async () => {
    vi.useFakeTimers();
    try {
      const rows: string[] = [];
      const run = runUpdateCheck(
        adapter({
          // The exact shape that pinned the pane: a call that never settles.
          checkForUpdates: () => new Promise(() => {}),
        }),
        { timeoutMs: 1_000, onRow: (row, status) => rows.push(`${row}:${status}`) },
      );
      await vi.advanceTimersByTimeAsync(1_500);
      const outcome = await run;
      expect(outcome.appStatus).toBe("failed");
      // The rows that CAN answer still answer — no all-or-nothing gating.
      expect(outcome.coreStatus).toBe("up-to-date");
      expect(outcome.cliStatus).toBe("up-to-date");
      expect(rows).toContain("core:up-to-date");
      expect(rows).toContain("app:failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves when every call hangs", async () => {
    vi.useFakeTimers();
    try {
      const hang = () => new Promise<never>(() => {});
      const run = runUpdateCheck(
        adapter({
          getVersions: hang,
          checkForUpdates: hang,
          checkCoreState: hang,
          checkCliUpdate: hang,
        }),
        { timeoutMs: 500 },
      );
      await vi.advanceTimersByTimeAsync(900);
      const outcome = await run;
      expect(outcome.appStatus).toBe("failed");
      expect(outcome.coreStatus).toBe("failed");
      expect(outcome.cliStatus).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns a rejected adapter call into a result instead of an exception", async () => {
    const outcome = await runUpdateCheck(
      adapter({
        checkCoreState: async () => {
          throw new Error("native gone");
        },
      }),
    );
    expect(outcome.coreStatus).toBe("unchecked");
    expect(outcome.appStatus).toBe("up-to-date");
  });

  it("commits a slow row independently of a fast one", async () => {
    const order: string[] = [];
    const outcome = await runUpdateCheck(
      adapter({
        checkForUpdates: async () => ok({ version: "0.10.174" }),
        checkCliUpdate: () =>
          new Promise((resolve) => setTimeout(() => resolve(ok(null)), 20)),
      }),
      { onRow: (row) => order.push(row) },
    );
    expect(outcome.appStatus).toBe("available");
    expect(order[0]).toBe("app");
  });

  it("exposes a sane default ceiling", () => {
    expect(DEFAULT_UPDATE_CHECK_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
