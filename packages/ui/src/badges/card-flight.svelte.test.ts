// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import BadgeCardModal from "./BadgeCardModal.svelte";
import { BADGE_BY_ID, type ResolvedBadge } from "./badge-catalog.js";
import { cardDate } from "./badge-card.js";
import { FLIGHT_CLOSE_MS, FLIGHT_OPEN_MS, flightTransform } from "./card-flight.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(join(here, file), "utf8");

const fleet: ResolvedBadge = { def: BADGE_BY_ID.fleet, tier: 2, earnedAt: "2026-07-30T17:28:59.454Z" };

describe("the card's turn", () => {
  /** Time fraction at which a cubic-bezier easing reaches progress 0.5. */
  function halfway(x1: number, y1: number, x2: number, y2: number): number {
    const at = (t: number, a: number, b: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (at(mid, y1, y2) < 0.5) lo = mid;
      else hi = mid;
    }
    return at(lo, x1, x2);
  }

  it("hides each side as the card passes edge-on, so the face never shows mirrored", () => {
    const src = read("BadgeCardModal.svelte");
    const turn = src.match(/\.bc-flip \{[^}]*transition: transform (\d+)ms cubic-bezier\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)/);
    expect(turn).not.toBeNull();
    const [ms, x1, y1, x2, y2] = turn!.slice(1).map(Number);
    const edgeOn = Math.round(ms * halfway(x1, y1, x2, y2));
    expect(src).toContain(`[data-phase="done"] .bc-face { transition: visibility 0s linear ${edgeOn}ms; }`);
    expect(src).toContain('[data-phase="done"] .bc-flip.flipped .bc-face { visibility: hidden; }');
    expect(src).toContain(`[data-phase="done"] .bc-back { visibility: hidden; transition: visibility 0s linear ${edgeOn}ms; }`);
    expect(src).toContain('[data-phase="done"] .bc-flip.flipped .bc-back { visibility: visible; }');
  });

  it("swaps the sides at once with reduced motion", () => {
    const src = read("BadgeCardModal.svelte");
    const reduced = src.slice(src.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain('[data-phase="done"] .bc-face, [data-phase="done"] .bc-back { transition: none; }');
  });
});

describe("card dates", () => {
  it("shows the calendar date for hq-pro's full timestamps and for a bare date", () => {
    expect(cardDate("2026-07-30T17:28:59.454Z")).toBe("Jul 30, 2026");
    expect(cardDate("2026-07-30")).toBe("Jul 30, 2026");
  });

  it("the badge detail page uses the same date as the card", () => {
    expect(read("BadgeDetailPane.svelte")).toContain("cardDate(badge.earnedAt)");
  });
});

describe("the card's flight from its pocket", () => {
  it("moves the stage card onto the pocket: centre to centre, scaled by width", () => {
    const pocket = { left: 100, top: 300, width: 90, height: 126 };
    const stage = { left: 500, top: 200, width: 300, height: 420 };
    expect(flightTransform(pocket, stage)).toBe("translate(-505px, -47px) scale(0.3)");
  });

  it("does nothing for a box with no size", () => {
    expect(flightTransform({ left: 0, top: 0, width: 0, height: 0 }, { left: 0, top: 0, width: 300, height: 420 })).toBe("none");
  });

  it("opens a little slower than it closes", () => {
    expect(FLIGHT_OPEN_MS).toBeGreaterThan(FLIGHT_CLOSE_MS);
  });
});

describe("BadgeCardModal with an origin pocket", () => {
  let component: ReturnType<typeof mount> | null = null;
  afterEach(() => {
    if (component) unmount(component);
    component = null;
    document.body.innerHTML = "";
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
    vi.restoreAllMocks();
  });

  function setup(animate: boolean) {
    const pocket = document.createElement("button");
    document.body.appendChild(pocket);
    const host = document.createElement("div");
    document.body.appendChild(host);
    let finish: () => void = () => {};
    const calls: Keyframe[][] = [];
    // happy-dom has no Web Animations API: stand one in, or leave it out.
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      writable: true,
      value: animate
        ? function (frames: Keyframe[]) {
            calls.push(frames);
            return { finished: new Promise<void>((resolve) => (finish = resolve)) } as unknown as Animation;
          }
        : undefined,
    });
    const onclose = vi.fn();
    component = mount(BadgeCardModal, { target: host, props: { open: true, badge: fleet, origin: pocket, onclose } });
    flushSync();
    return { pocket, onclose, calls, finish: () => finish() };
  }

  it("flies out of the pocket, leaves it empty, and flies back before closing", async () => {
    const { pocket, onclose, calls, finish } = setup(true);
    expect(pocket.style.visibility).toBe("hidden");
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ transform: "none" });
    document.querySelector<HTMLButtonElement>('[data-testid="badge-card-close"]')!.click();
    flushSync();
    expect(document.querySelector('[data-testid="badge-card-modal"]')?.classList.contains("closing")).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toEqual({ transform: "none" });
    expect(onclose).not.toHaveBeenCalled();
    finish();
    await tick();
    await Promise.resolve();
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("closes at once where it cannot fly", () => {
    const { pocket, onclose } = setup(false);
    expect(pocket.style.visibility).toBe("");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});

describe("badge names", () => {
  it.each(["ProfileBadges.svelte", "BadgesPane.svelte"])("%s: names wrap between words, never mid-word", (file) => {
    const nm = read(file).match(/\n  \.nm \{([^}]*)\}/)?.[1] ?? "";
    expect(nm).not.toContain("anywhere");
    expect(nm).toContain("overflow-wrap: normal");
    expect(nm).toContain("text-wrap: balance");
  });
});
