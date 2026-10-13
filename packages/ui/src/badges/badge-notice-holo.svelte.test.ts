// @vitest-environment happy-dom
/**
 * The badge notices' look and the combined notice (owner, 2026-10-12: "the
 * notification should be holographic shimmer like the cards", then
 * "Shimmer + combined notice"). One badge: a holographic notice with its
 * mark. Several since your last visit: one notice, "You earned 4 badges",
 * their marks in a row, and "Reveal cards", which shows the cards in turn.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { announceBadgeEarned, announceBadgesEarned, revealBadgeCards } from "./badge-announce.js";
import { BADGE_BY_ID } from "./badge-catalog.js";
import BadgeNoticeMarks from "./BadgeNoticeMarks.svelte";
import ToastStack from "../shell/ToastStack.svelte";
import { clearToasts, toastItems } from "../shell/toast-stack.svelte.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(join(here, file), "utf8");
const today = "2026-10-12";

let layer: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  Object.defineProperty(navigator, "gpu", { configurable: true, get: () => undefined });
  const shell = document.createElement("div");
  shell.className = "desktop-shell";
  shell.setAttribute("data-shell-focus-fallback", "");
  shell.tabIndex = -1;
  document.body.appendChild(shell);
});

afterEach(() => {
  if (layer) unmount(layer);
  layer = null;
  clearToasts();
  document.body.innerHTML = "";
});

function mountLayer(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  layer = mount(ToastStack, { target: host });
  flushSync();
}

const modal = () => document.querySelector('[data-testid="badge-card-modal"]') as HTMLElement | null;
const modalName = () => modal()?.querySelector('[role="dialog"]')?.getAttribute("aria-label") ?? null;

async function closeCard(): Promise<void> {
  (modal()!.querySelector('[data-testid="badge-card-close"]') as HTMLButtonElement).click();
  flushSync();
  await tick();
  flushSync();
}

describe("one badge", () => {
  it("is a holographic notice led by the badge's mark", () => {
    mountLayer();
    announceBadgeEarned({ id: "poweruser", tier: 3, earnedAt: today });
    flushSync();
    const toast = document.querySelector('[data-testid="badge-earned-toast"]') as HTMLElement;
    expect(toast.dataset.look).toBe("holo");
    expect(toast.classList.contains("holo")).toBe(true);
    expect(toast.querySelector(".ts-holo-edge")?.getAttribute("aria-hidden")).toBe("true");
    const marks = [...toast.querySelectorAll('[data-testid="badge-notice-mark"]')];
    expect(marks.map((m) => m.getAttribute("data-badge-id"))).toEqual(["poweruser"]);
    expect(marks[0].classList.contains("t3")).toBe(true);
    expect(toast.textContent).toContain("You earned Power User");
  });

  it("announceBadgesEarned with one badge raises that same single notice", () => {
    announceBadgesEarned([{ id: "liftoff", tier: 2, earnedAt: today }]);
    expect(toastItems()).toHaveLength(1);
    expect(toastItems()[0].testId).toBe("badge-earned-toast");
    expect(toastItems()[0].title).toBe("You earned Liftoff");
  });
});

describe("several badges since your last visit", () => {
  it("make one notice with every mark, the count and the names", () => {
    mountLayer();
    announceBadgesEarned([
      { id: "og", tier: "L", earnedAt: today },
      { id: "poweruser", tier: 3, earnedAt: today },
      { id: "liftoff", tier: 2, earnedAt: today },
      { id: "bughunter", tier: 1, earnedAt: today },
    ]);
    flushSync();
    expect(toastItems()).toHaveLength(1);
    const toast = document.querySelector('[data-testid="badges-earned-toast"]') as HTMLElement;
    expect(toast.dataset.look).toBe("holo");
    expect(toast.querySelector(".ts-title")?.textContent).toBe("You earned 4 badges");
    expect(toast.querySelector('[data-testid="toast-detail"]')?.textContent).toBe("OG, Power User, Liftoff and Bug Hunter.");
    expect([...toast.querySelectorAll('[data-testid="badge-notice-mark"]')].map((m) => m.getAttribute("data-badge-id"))).toEqual([
      "og",
      "poweruser",
      "liftoff",
      "bughunter",
    ]);
    expect(toast.querySelector('[data-testid="badges-earned-reveal"]')?.textContent).toBe("Reveal cards");
  });

  it("say awarded when every one of them was given", () => {
    announceBadgesEarned([
      { id: "og", tier: "L", earnedAt: today },
      { id: "captain", tier: "L", earnedAt: today },
    ]);
    expect(toastItems()[0].title).toBe("You were awarded 2 badges");
    expect(toastItems()[0].detail).toBe("OG and Captain.");
  });

  it("count each badge once and skip ones the catalog does not know", () => {
    announceBadgesEarned([
      { id: "liftoff", tier: 1, earnedAt: today },
      { id: "liftoff", tier: 2, earnedAt: today },
      { id: "nope", earnedAt: today },
      { id: "closer", tier: 2, earnedAt: today },
    ]);
    expect(toastItems()).toHaveLength(1);
    expect(toastItems()[0].title).toBe("You earned 2 badges");
    expect(announceBadgesEarned([{ id: "nope", earnedAt: today }])).toBeNull();
  });

  it("Reveal cards shows each card in turn, the next one when the last is closed", async () => {
    announceBadgesEarned([
      { id: "poweruser", tier: 3, earnedAt: today },
      { id: "liftoff", tier: 2, earnedAt: today },
    ]);
    toastItems()[0].actions![0].onAction();
    flushSync();
    expect(document.querySelectorAll('[data-testid="badge-card-modal"]')).toHaveLength(1);
    expect(modal()?.dataset.reveal).toBe("true");
    expect(modalName()).toContain("Power User card");
    await closeCard();
    expect(document.querySelectorAll('[data-testid="badge-card-modal"]')).toHaveLength(1);
    expect(modalName()).toContain("Liftoff card");
    await closeCard();
    expect(modal()).toBeNull();
  });

  it("stop when the function revealBadgeCards returns is called", () => {
    const stop = revealBadgeCards([
      { def: BADGE_BY_ID.poweruser, tier: 3, earnedAt: today },
      { def: BADGE_BY_ID.liftoff, tier: 2, earnedAt: today },
    ]);
    flushSync();
    expect(modal()).not.toBeNull();
    stop();
    flushSync();
    expect(modal()).toBeNull();
  });
});

describe("the marks row", () => {
  it("shows up to four marks, then +N", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const ids = ["og", "poweruser", "liftoff", "bughunter", "closer", "shipit"] as const;
    const badges = ids.map((id) => ({ def: BADGE_BY_ID[id], tier: 1 as const, earnedAt: today }));
    const c = mount(BadgeNoticeMarks, { target: host, props: { badges } });
    flushSync();
    expect(host.querySelectorAll('[data-testid="badge-notice-mark"]')).toHaveLength(4);
    expect(host.querySelector('[data-testid="badge-notice-more"]')?.textContent).toBe("+2");
    unmount(c);
  });
});

describe("the holographic look", () => {
  const css = read("../shell/ToastStack.svelte");

  it("draws an iridescent edge and a sweeping sheen without backdrop-filter", () => {
    // The colour is on the edge layer, not the toast: the surface stays the neutral overlay.
    expect(css).toMatch(/\.ts-holo-edge \{[^}]*conic-gradient\(from var\(--ts-holo-a\)/);
    expect(css).not.toMatch(/\.ts-toast\.holo \{[^}]*gradient/);
    expect(css).toMatch(/\.ts-toast\.holo::after \{[^}]*animation: ts-holo-sweep/);
    expect(css.slice(css.indexOf("<style>"))).not.toMatch(/backdrop-filter/);
  });

  it("sweeps twice as it comes in, and keeps going only while hovered", () => {
    expect(css).toMatch(/\.ts-holo-edge \{[^}]*animation: ts-holo-turn 3\.2s linear 2;/);
    expect(css).toContain(".ts-toast.holo:hover .ts-holo-edge { animation: ts-holo-turn 3.2s linear infinite; }");
    expect(css).toMatch(/\.ts-toast\.holo:hover::after \{ animation: ts-holo-sweep 1\.6s ease-in-out infinite; \}/);
  });

  it("holds still with reduced motion", () => {
    expect(css).toContain(".reduced .ts-holo-edge, .reduced .ts-toast.holo:hover .ts-holo-edge { animation: none; }");
    const media = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(media).toContain(".ts-toast.holo::after, .ts-toast.holo:hover::after { animation: none; opacity: 0; }");
  });
});
