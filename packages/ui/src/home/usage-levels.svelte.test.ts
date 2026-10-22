// @vitest-environment happy-dom
//
// Company levels, live (US-019): the level follows the server usage history,
// and the level-up card fires once per person per account, only after the
// history answers, and only when it can be remembered.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetUsageLevelsForTests,
  observeAccountRow,
  observeCoreView,
  observeUsageLevel,
  setUsageLevelHistoryLoader,
  setUsageLevelOpener,
  setUsageLevelViewer,
  usageLevelState,
  usageLevelViewer,
} from "./usage-levels.svelte";
import { dismissToast, toastItems } from "../shell/toast-stack.svelte";
import { clearAccountCaches } from "../common/account-caches";
import { usageLevelCardText } from "./usage-level-announce";
import type { LevelStorage } from "./usage-levels";
import type { CoreUsageView } from "./core-usage-model";

function memory(): LevelStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const levelToasts = () => toastItems().filter((t) => t.testId === "usage-level-toast");

beforeEach(() => {
  __resetUsageLevelsForTests();
  for (const t of [...toastItems()]) dismissToast(t.id);
});

afterEach(() => {
  __resetUsageLevelsForTests();
  for (const t of [...toastItems()]) dismissToast(t.id);
  vi.restoreAllMocks();
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
type Row = { month: string; usageCents: number; complete: boolean };
const history = (months: Row[]) => ({ ok: true, value: { months } });
/** A history that has only this month, open: the plain case for a card. */
const openOctober = (cents = 0) => history([{ month: "2026-10", usageCents: cents, complete: false }]);
const useHistory = (months: Row[] = []) => {
  const loader = vi.fn(async (_key: string) => history(months));
  setUsageLevelHistoryLoader(loader);
  return loader;
};

describe("observeUsageLevel", () => {
  it("shows one card when a level unlocks, once the history answers, and not again on the next read", async () => {
    const storage = memory();
    setUsageLevelViewer("prs_owner");
    setUsageLevelHistoryLoader(async () => openOctober(50_000));
    const counts = { "agent-run": 1240, "member-sync": 3100 };
    const state = observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 61_000, counts }, { storage });
    expect(state).toMatchObject({ level: 4, bestCents: 61_000, bestMonth: "2026-10", freshAt: null });
    expect(levelToasts()).toHaveLength(0);
    await flush();
    expect(usageLevelState("cmp_ridge")?.freshAt).toEqual(expect.any(Number));
    expect(levelToasts()).toHaveLength(1);
    expect(levelToasts()[0].title).toBe("Ridge reached Level 4: Scale");
    expect(levelToasts()[0].detail).toBe("October 2026 passed $500. The team did 1,240 agent runs and 3,100 syncs.");
    expect(levelToasts()[0].look).toBe("holo");

    dismissToast(levelToasts()[0].id);
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 70_000, counts }, { storage });
    expect(levelToasts()).toHaveLength(0);
    expect(usageLevelState("cmp_ridge")?.bestCents).toBe(70_000);
  });

  it("remembers across a restart: a shown level does not fire again", async () => {
    const storage = memory();
    setUsageLevelViewer("prs_owner");
    useHistory();
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 12_000 }, { storage });
    await flush();
    expect(levelToasts()).toHaveLength(1);
    for (const t of [...toastItems()]) dismissToast(t.id);

    __resetUsageLevelsForTests();
    setUsageLevelViewer("prs_owner");
    useHistory();
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 12_500 }, { storage });
    await flush();
    expect(usageLevelState("cmp_ridge")).toMatchObject({ level: 3, freshAt: null });
    expect(levelToasts()).toHaveLength(0);
  });

  it("keeps the level a closed month reached when a new month starts low, and fires for a higher level later", async () => {
    const storage = memory();
    setUsageLevelViewer("prs_owner");
    useHistory([
      { month: "2026-10", usageCents: 12_000, complete: true },
      { month: "2026-11", usageCents: 100, complete: false },
    ]);
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-11-01", cents: 100 }, { storage });
    await flush();
    expect(usageLevelState("cmp_ridge")).toMatchObject({ level: 3, bestCents: 12_000, bestMonth: "2026-10" });
    expect(levelToasts()).toHaveLength(0);
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-11-01", cents: 55_000 }, { storage });
    expect(levelToasts().map((t) => t.title)).toEqual(["Ridge reached Level 4: Scale"]);
  });

  it("gives each signed-in person their own card for the same company", async () => {
    const storage = memory();
    setUsageLevelViewer("prs_a");
    useHistory();
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 1_500 }, { storage });
    await flush();
    for (const t of [...toastItems()]) dismissToast(t.id);
    setUsageLevelViewer("prs_b");
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 1_500 }, { storage });
    await flush();
    expect(levelToasts()).toHaveLength(1);
  });

  it("shows the level but no card, and reads no history, with no signed-in person", async () => {
    const storage = memory();
    const loader = useHistory([{ month: "2026-09", usageCents: 61_000, complete: true }]);
    const state = observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 1_500 }, { storage });
    await flush();
    expect(state?.level).toBe(1);
    expect(loader).not.toHaveBeenCalled();
    expect(levelToasts()).toHaveLength(0);
    expect(storage.data.size).toBe(0);
  });

  it("shows no card when storage refuses the record (it would come back on every read)", async () => {
    setUsageLevelViewer("prs_owner");
    useHistory();
    const refusing: LevelStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const state = observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 1_500 }, { storage: refusing });
    await flush();
    expect(state?.level).toBe(1);
    expect(usageLevelState("cmp_ridge")?.level).toBe(1);
    expect(levelToasts()).toHaveLength(0);
  });

  it("speaks to the person on their personal account, and its See usage opens that account", async () => {
    const storage = memory();
    const open = vi.fn();
    setUsageLevelViewer("prs_owner");
    setUsageLevelOpener(open);
    useHistory();
    observeUsageLevel("personal", "Personal", { periodStart: "2026-10-01", cents: 5_200, counts: { "agent-run": 1 } }, { storage });
    await flush();
    const toast = levelToasts()[0];
    expect(toast.title).toBe("You reached Level 2: Prototype");
    expect(toast.detail).toContain("You did 1 agent run.");
    toast.actions?.[0].onAction();
    expect(open).toHaveBeenCalledWith("personal");
  });

  it("closes a card still on screen at sign-out, so the next person never sees it", async () => {
    setUsageLevelViewer("prs_a");
    useHistory();
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 1_500, counts: { "agent-run": 9 } }, { storage: memory() });
    await flush();
    expect(levelToasts()).toHaveLength(1);
    clearAccountCaches();
    expect(levelToasts()).toHaveLength(0);
    expect(usageLevelState("cmp_ridge")).toBeNull();
  });

  it("closes the last person's card when another person signs in", async () => {
    setUsageLevelViewer("prs_a");
    useHistory();
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 1_500 }, { storage: memory() });
    await flush();
    expect(levelToasts()).toHaveLength(1);
    setUsageLevelViewer("prs_b");
    expect(levelToasts()).toHaveLength(0);
    expect(usageLevelState("cmp_ridge")).toBeNull();
  });

  it("keeps a level read before sign-in finished, and still gives the card once the person is known", async () => {
    const storage = memory();
    useHistory();
    expect(observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 12_000 }, { storage })?.level).toBe(3);
    setUsageLevelViewer("prs_owner");
    expect(usageLevelState("cmp_ridge")?.level).toBe(3);
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 12_000 }, { storage });
    await flush();
    expect(levelToasts().map((t) => t.title)).toEqual(["Ridge reached Level 3: Launch"]);
  });

  it("shows a level without a card when told not to announce, and announces it later", async () => {
    const storage = memory();
    setUsageLevelViewer("prs_owner");
    useHistory();
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 6_000 }, { storage, announce: false });
    await flush();
    expect(usageLevelState("cmp_ridge")?.level).toBe(2);
    expect(levelToasts()).toHaveLength(0);
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 6_000 }, { storage });
    expect(levelToasts().map((t) => t.title)).toEqual(["Ridge reached Level 2: Prototype"]);
  });

  it("ignores a period it can't read", () => {
    setUsageLevelViewer("prs_owner");
    expect(observeUsageLevel("cmp", "C", { periodStart: "soon", cents: 5_000 }, { storage: memory() })).toBeNull();
  });
});

describe("observeCoreView / observeAccountRow", () => {
  const ready = (usage: Record<string, unknown> | null): CoreUsageView =>
    ({ kind: "ready", companyName: "Ridge", planLabel: "Usage plan", paid: true, usage, usageUnavailable: false, notice: null }) as CoreUsageView;

  it("counts a month statement from the Core menu", () => {
    setUsageLevelViewer("prs_owner");
    vi.spyOn(Storage.prototype, "getItem").mockReturnValue(null);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {});
    const state = observeCoreView("cmp_ridge", ready({ mode: "allowance", periodStart: "2026-10-01", totalCents: 120_000, counts: {} }));
    expect(state?.level).toBe(5);
  });

  it("does not count trial usage or a company off usage pricing", () => {
    expect(observeCoreView("cmp_t", ready({ mode: "trial", periodStart: null, totalCents: 200_000, counts: {} }))).toBeNull();
    expect(observeCoreView("cmp_o", ready(null))).toBeNull();
    expect(observeAccountRow("cmp_t", "T", { kind: "ready", trial: { endsAt: "x" }, usage: { periodStart: "2026-10-01", usageCents: 90_000, lines: [] } })).toBeNull();
  });

  it("counts a Settings > Usage line with its meter counts", () => {
    const state = observeAccountRow("cmp_s", "S", {
      kind: "ready",
      trial: null,
      usage: { periodStart: "2026-10-01", usageCents: 10_000, lines: [{ key: "agent-run", usage: 3 }] },
    });
    expect(state?.level).toBe(3);
  });
});

describe("usageLevelCardText", () => {
  it("names at most two meters so the notice keeps to two lines", () => {
    const { detail } = usageLevelCardText({ accountKey: "cmp", accountName: "Ridge", level: 4, month: "2026-10", counts: { "agent-run": 5, "member-sync": 6, "hq-mcp-call": 7 } });
    expect(detail).toBe("October 2026 passed $500. The team did 5 agent runs and 6 syncs.");
  });

  it("leaves out the team line when no meter has a count", () => {
    expect(usageLevelCardText({ accountKey: "cmp", accountName: "Ridge", level: 7, month: "2026-10", counts: {} })).toEqual({
      title: "Ridge reached Level 7: Landmark",
      detail: "October 2026 passed $10k.",
    });
  });
});

describe("levels from the usage history (hq-pro #5087)", () => {
  it("the best month is the largest month the history returns, open months included", async () => {
    const storage = memory();
    setUsageLevelViewer("prs_owner");
    useHistory([
      { month: "2026-07", usageCents: 6_000, complete: true },
      { month: "2026-08", usageCents: 120_000, complete: false },
      { month: "2026-09", usageCents: 61_000, complete: true },
      { month: "2026-10", usageCents: 2_000, complete: false },
    ]);
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 2_500 }, { storage });
    await flush();
    expect(usageLevelState("cmp_ridge")).toMatchObject({ level: 5, bestCents: 120_000, bestMonth: "2026-08" });
  });

  it("this month's statement wins over the history's older figure for the same month", async () => {
    setUsageLevelViewer("prs_owner");
    useHistory([{ month: "2026-10", usageCents: 2_000, complete: false }]);
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 11_000 }, { storage: memory() });
    await flush();
    expect(usageLevelState("cmp_ridge")).toMatchObject({ level: 3, bestCents: 11_000, bestMonth: "2026-10" });
  });

  it("stores nothing about spend on the device, only the shown level", async () => {
    const storage = memory();
    setUsageLevelViewer("prs_owner");
    useHistory([{ month: "2026-09", usageCents: 6_000, complete: true }]);
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 61_000 }, { storage });
    await flush();
    expect([...storage.data.values()].map((v) => JSON.parse(v))).toEqual([{ announced: 4 }]);
  });

  it("a stale best month left in storage by an earlier build does not raise the level", async () => {
    const storage = memory();
    storage.data.set("hq.usage.levels.v1.prs_owner.cmp_ridge", JSON.stringify({ bestCents: 1_000_000, bestMonth: "2025-01", level: 7, announced: 1 }));
    setUsageLevelViewer("prs_owner");
    useHistory([{ month: "2026-09", usageCents: 6_000, complete: true }]);
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 2_000 }, { storage });
    await flush();
    expect(usageLevelState("cmp_ridge")).toMatchObject({ level: 2, bestCents: 6_000, bestMonth: "2026-09" });
    expect(levelToasts().map((t) => t.title)).toEqual(["Ridge reached Level 2: Prototype"]);
  });

  it("a fresh device shows the level an earlier month reached, without repeating its card", async () => {
    const storage = memory();
    setUsageLevelViewer("prs_owner");
    const loader = useHistory([
      { month: "2026-09", usageCents: 61_000, complete: true },
      { month: "2026-10", usageCents: 2_000, complete: false },
    ]);
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 2_000 }, { storage });
    expect(usageLevelState("cmp_ridge")?.level).toBe(1);
    expect(levelToasts()).toHaveLength(0);
    await flush();
    expect(loader).toHaveBeenCalledWith("cmp_ridge");
    expect(usageLevelState("cmp_ridge")).toMatchObject({ level: 4, bestCents: 61_000, bestMonth: "2026-09" });
    expect(levelToasts()).toHaveLength(0);

    // Later reads in the session do not read the history again, or fire a card.
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 3_000 }, { storage });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(levelToasts()).toHaveLength(0);
    expect(usageLevelState("cmp_ridge")?.level).toBe(4);
  });

  it("a fresh device does not repeat the card for a past month the server still marks incomplete", async () => {
    // hq-pro marks a closed month incomplete when one of its meters is
    // missing; the person most likely saw its card on another computer.
    const storage = memory();
    setUsageLevelViewer("prs_owner");
    useHistory([
      { month: "2026-08", usageCents: 61_000, complete: false },
      { month: "2026-10", usageCents: 2_000, complete: false },
    ]);
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 2_000 }, { storage });
    await flush();
    expect(usageLevelState("cmp_ridge")).toMatchObject({ level: 4, bestMonth: "2026-08" });
    expect(levelToasts()).toHaveLength(0);
  });

  it("a fresh device still gets the card for a higher level this month reached", async () => {
    const storage = memory();
    setUsageLevelViewer("prs_owner");
    useHistory([{ month: "2026-09", usageCents: 6_000, complete: true }]);
    const counts = { "agent-run": 1240, "member-sync": 3100 };
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 61_000, counts }, { storage });
    expect(usageLevelState("cmp_ridge")?.level).toBe(4);
    expect(levelToasts()).toHaveLength(0);
    await flush();
    expect(levelToasts()).toHaveLength(1);
    expect(levelToasts()[0].title).toBe("Ridge reached Level 4: Scale");
    expect(levelToasts()[0].detail).toBe("October 2026 passed $500. The team did 1,240 agent runs and 3,100 syncs.");
  });

  it("a device with its own record gets one card for a level a missed month reached, naming that month", async () => {
    const storage = memory();
    storage.data.set("hq.usage.levels.v1.prs_owner.cmp_ridge", JSON.stringify({ announced: 1 }));
    setUsageLevelViewer("prs_owner");
    useHistory([
      { month: "2026-08", usageCents: 1_500, complete: true },
      { month: "2026-09", usageCents: 61_000, complete: true },
    ]);
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 2_000, counts: { "agent-run": 9 } }, { storage });
    await flush();
    expect(levelToasts()).toHaveLength(1);
    expect(levelToasts()[0].title).toBe("Ridge reached Level 4: Scale");
    // This month's counts are not September's, so the card leaves them out.
    expect(levelToasts()[0].detail).toBe("September 2026 passed $500.");
  });

  it("a refused, missing, failed or unreadable history read shows this month's level, no card, and does not throw", async () => {
    const storage = memory();
    setUsageLevelViewer("prs_owner");
    setUsageLevelHistoryLoader((key) => {
      if (key === "cmp_403") return Promise.resolve({ ok: false });
      if (key === "cmp_off") return Promise.reject(new Error("offline"));
      if (key === "cmp_junk") return Promise.resolve({ ok: true, value: { months: "nope" } });
      if (key === "cmp_none") return null;
      throw new Error("loader broke");
    });
    for (const key of ["cmp_403", "cmp_off", "cmp_junk", "cmp_none", "cmp_throw"]) {
      expect(() => observeUsageLevel(key, key, { periodStart: "2026-10-01", cents: 6_000 }, { storage })).not.toThrow();
    }
    await flush();
    for (const key of ["cmp_403", "cmp_off", "cmp_junk", "cmp_none", "cmp_throw"]) {
      expect(usageLevelState(key)).toMatchObject({ level: 2, bestCents: 6_000, bestMonth: "2026-10" });
    }
    // Later reads in the session stay on this month and still give no card.
    observeUsageLevel("cmp_403", "cmp_403", { periodStart: "2026-10-01", cents: 61_000 }, { storage });
    expect(usageLevelState("cmp_403")?.level).toBe(4);
    expect(levelToasts()).toHaveLength(0);
    expect(storage.data.size).toBe(0);
  });

  it("a host with no history loader shows this month's level and no card", () => {
    const storage = memory();
    setUsageLevelViewer("prs_owner");
    const state = observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 61_000 }, { storage });
    expect(state?.level).toBe(4);
    expect(levelToasts()).toHaveLength(0);
    expect(storage.data.size).toBe(0);
  });

  it("the personal account reads its own history", async () => {
    const storage = memory();
    setUsageLevelViewer("prs_owner");
    const loader = useHistory([{ month: "2026-09", usageCents: 12_000, complete: true }]);
    observeUsageLevel("personal", "Personal", { periodStart: "2026-10-01", cents: 500 }, { storage });
    await flush();
    expect(loader).toHaveBeenCalledWith("personal");
    expect(usageLevelState("personal")).toMatchObject({ level: 3, bestMonth: "2026-09" });
  });

  it("a history read still out at sign-out is dropped and fires nothing", async () => {
    const storage = memory();
    setUsageLevelViewer("prs_owner");
    type Answer = { ok: boolean; value?: unknown };
    let answer: (v: Answer) => void = () => {};
    setUsageLevelHistoryLoader(() => new Promise<Answer>((resolve) => (answer = resolve)));
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 61_000 }, { storage });
    clearAccountCaches();
    setUsageLevelViewer("prs_other");
    answer(history([{ month: "2026-09", usageCents: 1_000_000, complete: true }]));
    await flush();
    expect(levelToasts()).toHaveLength(0);
    expect(usageLevelState("cmp_ridge")).toBeNull();
    expect(storage.data.size).toBe(0);
  });
});

describe("a read that answers for a person no longer signed in", () => {
  const coreView = (cents: number): CoreUsageView =>
    ({
      kind: "ready",
      companyName: "Personal",
      usage: { mode: "allowance", periodStart: "2026-10-01", totalCents: cents, counts: {} },
    }) as unknown as CoreUsageView;

  it("is dropped: the new person's level is left as it was, and no card shows", async () => {
    const storage = memory();
    setUsageLevelViewer("prs_first");
    const reader = usageLevelViewer();
    expect(reader).toBe("prs_first");
    setUsageLevelViewer("prs_second");
    expect(observeUsageLevel("personal", "Personal", { periodStart: "2026-10-01", cents: 1_200_000 }, { storage, viewer: reader })).toBeNull();
    expect(observeCoreView("personal", coreView(1_200_000), { viewer: reader })).toBeNull();
    expect(
      observeAccountRow("personal", "Personal", { kind: "ready", usage: { periodStart: "2026-10-01", usageCents: 1_200_000, lines: [] } }, { viewer: reader }),
    ).toBeNull();
    await flush();
    expect(usageLevelState("personal")).toBeNull();
    expect(levelToasts()).toHaveLength(0);
  });

  it("is dropped after a sign-out too", () => {
    setUsageLevelViewer("prs_first");
    const reader = usageLevelViewer();
    setUsageLevelViewer(null);
    expect(observeUsageLevel("personal", "Personal", { periodStart: "2026-10-01", cents: 1_200_000 }, { viewer: reader })).toBeNull();
    expect(usageLevelState("personal")).toBeNull();
  });

  it("still counts when the same person is signed in", () => {
    setUsageLevelViewer("prs_first");
    const reader = usageLevelViewer();
    expect(observeUsageLevel("personal", "Personal", { periodStart: "2026-10-01", cents: 1_200_000 }, { viewer: reader })).toMatchObject({
      level: 7,
      viewer: "prs_first",
    });
  });
});
