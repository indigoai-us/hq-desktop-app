// @vitest-environment happy-dom
//
// The usage bar at a company level (US-019): the level palette, limit states
// winning, and the sheen respecting reduced motion.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import UsageStackBar, { __resetUsageSweepsForTests } from "./UsageStackBar.svelte";
import UsageLevelChip from "./UsageLevelChip.svelte";
import { levelTheme } from "./usage-level-theme";
import { segmentColor } from "./usage-stack";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  __resetUsageSweepsForTests();
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

const SEGMENTS = [
  { id: "agents", label: "Agents and AI", cents: 500 },
  { id: "sync", label: "Sync", cents: 300 },
  { id: "storage", label: "Storage and vaults", cents: 200 },
];

function reducedMotion(on: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: on && query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        onchange: null,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

function render(props: Record<string, unknown>, Comp: typeof UsageStackBar | typeof UsageLevelChip = UsageStackBar) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(Comp as never, { target: host, props: props as never });
  flushSync();
  return host;
}

function segStyle(el: HTMLElement, id: string): string {
  return el.querySelector<HTMLElement>(`[data-segment="${id}"]`)?.getAttribute("style") ?? "";
}

describe("UsageStackBar levels", () => {
  it("draws the plain group colours with no level", () => {
    const el = render({ segments: SEGMENTS, scaleCents: 1000 });
    expect(el.querySelector(".stack")?.getAttribute("data-level")).toBe("0");
    expect(segStyle(el, "agents")).toContain(segmentColor("agents"));
    expect(el.querySelector('[data-testid="usage-bar-sheen"]')).toBeNull();
  });

  it("draws the level palette when calm", () => {
    const el = render({ segments: SEGMENTS, scaleCents: 1000, level: 4 });
    const t = levelTheme(4)!;
    expect(el.querySelector(".stack")?.getAttribute("data-level")).toBe("4");
    expect(segStyle(el, "agents")).toContain(t.agents);
    expect(segStyle(el, "sync")).toContain(t.sync);
    expect(segStyle(el, "storage")).toContain(t.storage);
  });

  it("lets the limit state win: plain colours and no sheen near or at a limit", () => {
    for (const tone of ["near", "at"]) {
      const el = render({ segments: SEGMENTS, scaleCents: 1000, level: 7, tone });
      const stack = el.querySelector(".stack")!;
      expect(stack.getAttribute("data-tone")).toBe(tone);
      expect(stack.getAttribute("data-level")).toBe("0");
      expect(stack.getAttribute("data-sheen")).toBe("none");
      expect(segStyle(el, "agents")).toContain(segmentColor("agents"));
      if (component) void unmount(component);
      component = null;
      host.remove();
    }
  });

  it("plays the sheen once when a top level just unlocked, then settles to hover", () => {
    vi.useFakeTimers();
    try {
      reducedMotion(false);
      const el = render({ segments: SEGMENTS, scaleCents: 1000, level: 6, celebrate: Date.now() });
      expect(el.querySelector(".stack")?.getAttribute("data-sheen")).toBe("play");
      expect(el.querySelector('[data-testid="usage-bar-sheen"]')).not.toBeNull();
      vi.advanceTimersByTime(1700);
      flushSync();
      expect(el.querySelector(".stack")?.getAttribute("data-sheen")).toBe("hover");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not replay the unlock sweep when a bar mounts again for the same unlock", async () => {
    reducedMotion(false);
    const at = Date.now();
    render({ segments: SEGMENTS, scaleCents: 1000, level: 7, celebrate: at });
    if (component) await unmount(component);
    component = null;
    host.remove();
    const el = render({ segments: SEGMENTS, scaleCents: 1000, level: 7, celebrate: at });
    expect(el.querySelector(".stack")?.getAttribute("data-sheen")).toBe("hover");
  });

  it("plays the sweep on a bar already on screen when the level unlocks", () => {
    reducedMotion(false);
    const props = $state({ segments: SEGMENTS, scaleCents: 1000, level: 5, celebrate: null as number | null });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(UsageStackBar, { target: host, props });
    flushSync();
    expect(host.querySelector(".stack")?.getAttribute("data-sheen")).toBe("none");
    props.level = 6;
    props.celebrate = Date.now();
    flushSync();
    expect(host.querySelector(".stack")?.getAttribute("data-sheen")).toBe("play");
  });

  it("does not play an old unlock", () => {
    reducedMotion(false);
    const el = render({ segments: SEGMENTS, scaleCents: 1000, level: 7, celebrate: Date.now() - 120_000 });
    expect(el.querySelector(".stack")?.getAttribute("data-sheen")).toBe("hover");
  });

  it("never plays the unlock sheen under reduced motion (hover only, which CSS also stops)", () => {
    reducedMotion(true);
    const el = render({ segments: SEGMENTS, scaleCents: 1000, level: 7, celebrate: Date.now() });
    expect(el.querySelector(".stack")?.getAttribute("data-sheen")).toBe("hover");
  });

  it("has no sheen below level 6, even on unlock", () => {
    reducedMotion(false);
    const el = render({ segments: SEGMENTS, scaleCents: 1000, level: 5, celebrate: Date.now() });
    expect(el.querySelector(".stack")?.getAttribute("data-sheen")).toBe("none");
  });
});

describe("UsageLevelChip", () => {
  it("shows the level, its progress to the next and the next threshold", () => {
    const el = render({ level: 4, bestCents: 75_000, bestMonth: "2026-10" }, UsageLevelChip);
    expect(el.querySelector('[data-testid="usage-level-name"]')?.textContent).toBe("Level 4 Scale");
    expect(el.querySelector('[data-testid="usage-level-chip"]')?.getAttribute("data-progress")).toBe("50");
    // In a Settings line the chip sits inside the line's button: no nested progressbar role.
    expect(el.querySelector('[role="progressbar"]')).toBeNull();
    expect(el.querySelector('[data-testid="usage-level-next"]')?.textContent).toBe("$1k");
    expect(el.querySelector('[data-testid="usage-level-chip"]')?.getAttribute("title")).toContain("Next: Level 5 Engine at a $1k month");
  });

  it("is a labelled progressbar in the Core menu", () => {
    const el = render({ level: 2, bestCents: 7_500, variant: "menu" }, UsageLevelChip);
    const bar = el.querySelector('[data-testid="usage-level-progress"]');
    expect(bar?.getAttribute("role")).toBe("progressbar");
    expect(bar?.getAttribute("aria-label")).toBe("Progress to Level 3 Launch");
    expect(bar?.getAttribute("aria-valuenow")).toBe("50");
  });

  it("says Top level at level 7 and No level yet below $10", () => {
    let el = render({ level: 7, bestCents: 1_200_000 }, UsageLevelChip);
    expect(el.querySelector('[data-testid="usage-level-next"]')?.textContent).toBe("Top level");
    if (component) void unmount(component);
    component = null;
    host.remove();
    el = render({ level: 0, bestCents: 400 }, UsageLevelChip);
    expect(el.querySelector('[data-testid="usage-level-name"]')?.textContent).toBe("No level yet");
    expect(el.querySelector('[data-testid="usage-level-next"]')?.textContent).toBe("$10");
  });
});
