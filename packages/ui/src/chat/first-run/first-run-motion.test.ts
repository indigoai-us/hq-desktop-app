// @vitest-environment happy-dom

/**
 * US-010: the takeover's exit is part of one motion. When it leaves, an inert
 * copy of it fades out over the landing view in under 400ms, and under
 * prefers-reduced-motion the view changes at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_RUN_LEAVE_MS,
  FIRST_RUN_LEAVING_ATTR,
  fadeOutOnLeave,
} from "./first-run-motion.js";

type FakeAnimation = {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  finish: () => void;
  finished: Promise<void>;
};

let animations: FakeAnimation[] = [];
let reduceMotion = false;
const originalAnimate = HTMLElement.prototype.animate;
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  animations = [];
  reduceMotion = false;
  HTMLElement.prototype.animate = function (
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions,
  ) {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    animations.push({ keyframes, options, finish, finished });
    return { finished } as unknown as Animation;
  } as typeof HTMLElement.prototype.animate;
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion") && reduceMotion,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  HTMLElement.prototype.animate = originalAnimate;
  window.matchMedia = originalMatchMedia;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function takeover(): HTMLElement {
  const shell = document.createElement("div");
  shell.className = "desktop-shell";
  document.body.appendChild(shell);
  const node = document.createElement("div");
  node.className = "new-bot-takeover";
  node.setAttribute("data-testid", "first-run-takeover");
  node.innerHTML =
    '<button id="go" data-testid="first-run-next">Next</button><p>Copy</p>';
  shell.appendChild(node);
  return node;
}

const leaving = () =>
  document.querySelectorAll<HTMLElement>(`[${FIRST_RUN_LEAVING_ATTR}]`);

describe("fadeOutOnLeave", () => {
  it("fades an inert copy out over the view that replaced the takeover, in under 400ms", async () => {
    const node = takeover();
    const action = fadeOutOnLeave(node);
    node.remove();
    action.destroy();

    const [copy] = leaving();
    expect(copy).toBeTruthy();
    expect(copy.parentElement?.classList.contains("desktop-shell")).toBe(true);
    expect(copy.getAttribute("aria-hidden")).toBe("true");
    expect(copy.inert).toBe(true);
    expect(copy.style.pointerEvents).toBe("none");
    expect(copy.textContent).toContain("Copy");
    // Nothing can find or label the copy.
    expect(copy.querySelector("[data-testid]")).toBeNull();
    expect(copy.hasAttribute("data-testid")).toBe(false);
    expect(copy.querySelector("[id]")).toBeNull();
    expect(document.querySelector('[data-testid="first-run-takeover"]')).toBeNull();

    expect(animations).toHaveLength(1);
    expect(animations[0].keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(animations[0].options.duration).toBe(FIRST_RUN_LEAVE_MS);
    expect(FIRST_RUN_LEAVE_MS).toBeLessThan(400);

    animations[0].finish();
    await animations[0].finished;
    await Promise.resolve();
    expect(leaving()).toHaveLength(0);
  });

  it("removes the copy even when the animation never finishes", () => {
    vi.useFakeTimers();
    const node = takeover();
    const action = fadeOutOnLeave(node);
    node.remove();
    action.destroy();
    expect(leaving()).toHaveLength(1);
    vi.advanceTimersByTime(FIRST_RUN_LEAVE_MS + 250);
    expect(leaving()).toHaveLength(0);
  });

  it("leaves nothing behind under prefers-reduced-motion", () => {
    reduceMotion = true;
    const node = takeover();
    const action = fadeOutOnLeave(node);
    node.remove();
    action.destroy();
    expect(leaving()).toHaveLength(0);
    expect(animations).toHaveLength(0);
  });

  it("leaves nothing behind where the Web Animations API is missing", () => {
    HTMLElement.prototype.animate = undefined as unknown as typeof HTMLElement.prototype.animate;
    const node = takeover();
    const action = fadeOutOnLeave(node);
    node.remove();
    action.destroy();
    expect(leaving()).toHaveLength(0);
  });
});
