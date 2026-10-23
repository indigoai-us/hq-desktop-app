// @vitest-environment happy-dom
//
// Company levels (US-019), rendered end to end in each state the PR shows:
// no usage, mid-level, the level-up card, and the top level. Each state is
// driven through the live store with a mocked owner usage history
// (GET /v1/billing/usage/history, hq-pro #5087), then the level chip, the
// usage bar and the toast layer are mounted from the resulting state.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import UsageStackBar, { __resetUsageSweepsForTests } from "./UsageStackBar.svelte";
import UsageLevelChip from "./UsageLevelChip.svelte";
import ToastStack from "../shell/ToastStack.svelte";
import { clearToasts } from "../shell/toast-stack.svelte.js";
import {
  __resetUsageLevelsForTests,
  observeUsageLevel,
  setUsageLevelHistoryLoader,
  setUsageLevelViewer,
  usageLevelState,
} from "./usage-levels.svelte";
import type { LevelStorage } from "./usage-levels";

const SEGMENTS = [
  { id: "agents", label: "Agents and AI", cents: 500 },
  { id: "sync", label: "Sync", cents: 300 },
  { id: "storage", label: "Storage and vaults", cents: 200 },
];

let host: HTMLDivElement;
let mounted: ReturnType<typeof mount>[] = [];

function memory(): LevelStorage {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  __resetUsageLevelsForTests();
  clearToasts();
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        onchange: null,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
});

afterEach(async () => {
  for (const m of mounted) await unmount(m);
  mounted = [];
  clearToasts();
  __resetUsageLevelsForTests();
  __resetUsageSweepsForTests();
  host.remove();
  vi.restoreAllMocks();
});

/** Read one account through the store with the given history, then render its chip, bar and the toast layer. */
async function renderState(months: { month: string; usageCents: number; complete: boolean }[], thisMonthCents: number) {
  setUsageLevelViewer("prs_owner");
  setUsageLevelHistoryLoader(async () => ({ ok: true, value: { months } }));
  mounted.push(mount(ToastStack, { target: host }));
  observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: thisMonthCents, counts: { "agent-run": 1240, "member-sync": 3100 } }, { storage: memory() });
  await flush();
  const state = usageLevelState("cmp_ridge")!;
  mounted.push(mount(UsageLevelChip, { target: host, props: { level: state.level, bestCents: state.bestCents, bestMonth: state.bestMonth, variant: "menu" } }));
  mounted.push(mount(UsageStackBar, { target: host, props: { segments: SEGMENTS, scaleCents: 1000, level: state.level, celebrate: state.freshAt } as never }));
  flushSync();
  const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);
  return {
    state,
    name: q("usage-level-name")?.textContent,
    next: q("usage-level-next")?.textContent,
    progress: q("usage-level-chip")?.getAttribute("data-progress"),
    barLevel: host.querySelector(".stack")?.getAttribute("data-level"),
    toasts: [...document.querySelectorAll<HTMLElement>(".ts-toast")].map((t) => t.textContent?.replace(/\s+/g, " ").trim() ?? ""),
  };
}

describe("company levels render states (build-and-render evidence)", () => {
  it("no usage: no level yet, plain bar, no card", async () => {
    const r = await renderState([], 0);
    expect(r.state).toMatchObject({ level: 0, bestCents: 0, bestMonth: null });
    expect(r.name).toBe("No level yet");
    expect(r.next).toBe("$10");
    expect(r.progress).toBe("0");
    expect(r.barLevel).toBe("0");
    expect(r.toasts).toEqual([]);
  });

  it("mid-level: Level 4 Scale from a closed month in the history, halfway to $1k, no repeat card", async () => {
    const r = await renderState(
      [
        { month: "2026-09", usageCents: 75_000, complete: true },
        { month: "2026-10", usageCents: 2_000, complete: false },
      ],
      2_000,
    );
    expect(r.state).toMatchObject({ level: 4, bestCents: 75_000, bestMonth: "2026-09" });
    expect(r.name).toBe("Level 4 Scale");
    expect(r.next).toBe("$1k");
    expect(r.progress).toBe("50");
    expect(r.barLevel).toBe("4");
    expect(r.toasts).toEqual([]);
  });

  it("level-up card: this month passes $500, the card shows once the history answers", async () => {
    const r = await renderState([{ month: "2026-10", usageCents: 50_000, complete: false }], 61_000);
    expect(r.state).toMatchObject({ level: 4, bestCents: 61_000, bestMonth: "2026-10" });
    expect(r.state.freshAt).toEqual(expect.any(Number));
    expect(r.name).toBe("Level 4 Scale");
    expect(r.barLevel).toBe("4");
    expect(r.toasts).toHaveLength(1);
    expect(r.toasts[0]).toContain("Ridge reached Level 4: Scale");
    expect(r.toasts[0]).toContain("October 2026 passed $500. The team did 1,240 agent runs and 3,100 syncs.");
  });

  it("top level: Level 7 Landmark, Top level, brand bar, no repeat card", async () => {
    const r = await renderState([{ month: "2026-08", usageCents: 1_200_000, complete: true }], 40_000);
    expect(r.state).toMatchObject({ level: 7, bestCents: 1_200_000, bestMonth: "2026-08" });
    expect(r.name).toBe("Level 7 Landmark");
    expect(r.next).toBe("Top level");
    expect(r.progress).toBe("100");
    expect(r.barLevel).toBe("7");
    expect(r.toasts).toEqual([]);
  });

  it("history read fails: this month's level, no card, nothing thrown", async () => {
    setUsageLevelViewer("prs_owner");
    setUsageLevelHistoryLoader(async () => ({ ok: false }));
    mounted.push(mount(ToastStack, { target: host }));
    observeUsageLevel("cmp_ridge", "Ridge", { periodStart: "2026-10-01", cents: 61_000 }, { storage: memory() });
    await flush();
    const state = usageLevelState("cmp_ridge")!;
    mounted.push(mount(UsageLevelChip, { target: host, props: { level: state.level, bestCents: state.bestCents, bestMonth: state.bestMonth } }));
    flushSync();
    expect(host.querySelector('[data-testid="usage-level-name"]')?.textContent).toBe("Level 4 Scale");
    expect(document.querySelectorAll(".ts-toast")).toHaveLength(0);
  });
});
