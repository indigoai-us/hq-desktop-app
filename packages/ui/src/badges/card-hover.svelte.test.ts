// @vitest-environment happy-dom
/**
 * The hover on the card's back (owner request 2026-10-08): the story side
 * tilts toward the pointer and a holographic light follows it, like the face.
 */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BadgeCardModal from "./BadgeCardModal.svelte";
import { BADGE_BY_ID, type ResolvedBadge } from "./badge-catalog.js";
import { cardHover } from "./card-hover.js";

const liftoff: ResolvedBadge = { def: BADGE_BY_ID.liftoff, tier: 2, earnedAt: "2026-10-06" };
const mounted: Array<ReturnType<typeof mount>> = [];

function setMotion(reduce: boolean): void {
  window.matchMedia = ((query: string) => ({ matches: reduce && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
}

function pointer(x: number, y: number): void {
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, isPrimary: true }));
}

beforeEach(() => {
  setMotion(false);
  Object.defineProperty(navigator, "gpu", { configurable: true, get: () => undefined });
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout"] });
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function card(): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => ({ left: 100, top: 100, width: 280, height: 392, right: 380, bottom: 492, x: 100, y: 100, toJSON() {} }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

describe("card hover action", () => {
  it("tilts toward the pointer and moves the light there, then settles flat when it leaves", () => {
    const el = card();
    const action = cardHover(el, true);
    pointer(380, 100); // the top-right corner
    vi.advanceTimersByTime(1000);
    expect(el.style.transform).toMatch(/perspective\(\d+px\) rotateX\(0\.1\d+rad\) rotateY\(0\.1\d+rad\)/);
    expect(Number(el.style.getPropertyValue("--light"))).toBeGreaterThan(0.95);
    expect(parseFloat(el.style.getPropertyValue("--light-x"))).toBeGreaterThan(95);
    expect(parseFloat(el.style.getPropertyValue("--light-y"))).toBeLessThan(5);
    pointer(1000, 1000); // far away
    vi.advanceTimersByTime(1000);
    expect(Number(el.style.getPropertyValue("--light"))).toBeLessThan(0.01);
    action.destroy();
    expect(el.style.transform).toBe("");
  });

  it("stays flat with reduced motion, and does nothing while off", () => {
    setMotion(true);
    const el = card();
    cardHover(el, true);
    pointer(380, 100);
    vi.advanceTimersByTime(500);
    expect(el.style.transform).toBe("");
    const off = card();
    cardHover(off, false);
    pointer(380, 100);
    vi.advanceTimersByTime(500);
    expect(off.style.getPropertyValue("--light")).toBe("0.000");
  });
});

describe("the flipped card", () => {
  it("has the hover only while its back is showing", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    mounted.push(mount(BadgeCardModal, { target: host, props: { open: true, badge: liftoff, onclose: () => {} } }));
    flushSync();
    const back = () => document.querySelector('[data-testid="badge-card-back"]') as HTMLElement;
    expect(back().classList.contains("interactive")).toBe(false);
    (document.querySelector('[data-testid="badge-card-flipper"]') as HTMLElement).click();
    flushSync();
    expect(back().classList.contains("interactive")).toBe(true);
    expect(back().querySelector(".holo")).not.toBeNull();
  });
});
