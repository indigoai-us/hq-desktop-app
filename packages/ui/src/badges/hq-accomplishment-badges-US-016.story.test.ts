// @vitest-environment happy-dom
/**
 * hq-accomplishment-badges US-016: the full-screen launch announcement.
 *
 * Owner, 2026-10-14: "i want to wait until launch day on friday, and i want
 * to show a beautiful full screen notification announcing accomplishments
 * and showing what they have earned." It shows once per person per device,
 * only when the server has badges on for them, and closes three ways.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BadgesPayload } from "@hq/platform";
import BadgeLaunchAnnouncement from "./BadgeLaunchAnnouncement.svelte";
import { resolveEarned, type ResolvedBadge } from "./badge-catalog.js";
import { installBadgeLoader, resetBadgeLoader } from "./badge-loader.svelte.js";
import { badgesEnabledFor, setBadgeProgressSource, setBadgeSource, setBadgesEnabledSource } from "./badge-source.js";
import {
  LAUNCH_HAND_MAX,
  fanSlots,
  hasSeenLaunch,
  launchHand,
  launchLead,
  launchSeenKey,
  markLaunchSeen,
  nextUp,
  progressLine,
  shouldShowLaunch,
  type LaunchStorage,
} from "./badge-launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(join(here, file), "utf8");

function memoryStorage(): LaunchStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const EARNED = resolveEarned([
  { id: "founding", earnedAt: "2026-03-02" },
  { id: "maker", tier: 2, earnedAt: "2026-10-01" },
  { id: "bughunter", tier: 1, earnedAt: "2026-09-28" },
  { id: "og", earnedAt: "2026-01-01" },
  { id: "fleet", tier: 3, earnedAt: "2026-08-01" },
  { id: "liftoff", tier: 1, earnedAt: "2026-07-01" },
  { id: "sharer", tier: 1, earnedAt: "2026-06-01" },
]);

describe("when it shows", () => {
  const base = { uid: "prs_ada", enabled: true, seen: false, busy: false };

  it("shows for a signed-in person the server has badges on for, who has not seen it", () => {
    expect(shouldShowLaunch(base)).toBe(true);
  });

  it("never shows while badges are off for them, or before the server has answered", () => {
    expect(shouldShowLaunch({ ...base, enabled: false })).toBe(false);
    expect(shouldShowLaunch({ ...base, enabled: null })).toBe(false);
  });

  it("never shows twice, without a person uid, or while first-run setup or the tour owns the window", () => {
    expect(shouldShowLaunch({ ...base, seen: true })).toBe(false);
    expect(shouldShowLaunch({ ...base, uid: null })).toBe(false);
    expect(shouldShowLaunch({ ...base, uid: "agt_bot" })).toBe(false);
    expect(shouldShowLaunch({ ...base, busy: true })).toBe(false);
  });

  it("remembers it was seen per person, so a second account on the machine gets its own", () => {
    const storage = memoryStorage();
    expect(hasSeenLaunch("prs_ada", storage)).toBe(false);
    markLaunchSeen("prs_ada", storage, new Date("2026-10-16T09:00:00Z"));
    expect(hasSeenLaunch("prs_ada", storage)).toBe(true);
    expect(hasSeenLaunch("prs_grace", storage)).toBe(false);
    expect(storage.data.get(launchSeenKey("prs_ada"))).toBe("2026-10-16T09:00:00.000Z");
  });

  it("counts as seen when there is no storage, so it cannot come back on every launch", () => {
    expect(hasSeenLaunch("prs_ada", null)).toBe(true);
  });
});

describe("the server's enabled answer reaches the gate", () => {
  const payload = (enabled: boolean): BadgesPayload => ({
    enabled,
    subject: enabled ? { uid: "prs_ada", kind: "person" } : null,
    consent: null,
    badges: [],
    progress: [],
  });
  const ADA = { kind: "person" as const, name: "Ada", uid: "prs_ada" };

  afterEach(() => {
    resetBadgeLoader();
    setBadgeSource(null);
    setBadgeProgressSource(null);
    setBadgesEnabledSource(null);
  });

  async function enabledAfterLoad(enabled: boolean | "fail"): Promise<boolean | null> {
    const getBadges = vi.fn(() =>
      Promise.resolve(enabled === "fail" ? { ok: false as const, reason: "network" } : { ok: true as const, value: payload(enabled) }),
    );
    const uninstall = installBadgeLoader({ getBadges } as never);
    expect(badgesEnabledFor(ADA)).toBeNull();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    const answer = badgesEnabledFor(ADA);
    uninstall();
    return answer;
  }

  it("is true only when hq-pro says enabled, even with no badges earned", async () => {
    expect(await enabledAfterLoad(true)).toBe(true);
  });

  it("is false when the flag is off for the person or the read fails", async () => {
    expect(await enabledAfterLoad(false)).toBe(false);
    expect(await enabledAfterLoad("fail")).toBe(false);
  });
});

describe("the hand", () => {
  it("puts the best card in the middle and counts the rest", () => {
    const { shown, more } = launchHand(EARNED);
    expect(shown).toHaveLength(LAUNCH_HAND_MAX);
    expect(more).toBe(EARNED.length - LAUNCH_HAND_MAX);
    expect(shown[2].def.id).toBe("og");
  });

  it("fans symmetrically with the middle card on top", () => {
    const slots = fanSlots(5);
    expect(slots[0].x).toBeCloseTo(-slots[4].x);
    expect(slots[0].rotate).toBeCloseTo(-slots[4].rotate);
    expect(Math.max(...slots.map((s) => s.z))).toBe(slots[2].z);
  });

  it("offers the nearest badges to someone with none, in plain counts", () => {
    const up = nextUp([
      { id: "maker", current: 2, target: 5, unit: "skills" },
      { id: "poweruser", current: 64, target: 100, unit: "runs" },
      { id: "fleet", current: 0, target: 1, unit: "agents" },
      { id: "closer", current: 10, target: 10, unit: "stories" },
    ]);
    expect(up.map((p) => p.id)).toEqual(["poweruser", "maker", "fleet"]);
    expect(progressLine(up[2])).toBe("0 of 1 agent");
    expect(launchLead(0)).toMatch(/first ones are close/);
    expect(launchLead(1)).toMatch(/already have one/);
    expect(launchLead(7)).toMatch(/already have 7/);
  });
});

describe("the announcement", () => {
  let view: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    Object.defineProperty(navigator, "gpu", { configurable: true, get: () => undefined });
    const shell = document.createElement("div");
    shell.className = "desktop-shell";
    shell.setAttribute("data-shell-focus-fallback", "");
    shell.tabIndex = -1;
    document.body.appendChild(shell);
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (view) unmount(view);
    view = null;
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  function open(badges: readonly ResolvedBadge[], progress = [] as { id: string; current: number; target: number; unit: string }[]) {
    const onclose = vi.fn();
    const onopenbadges = vi.fn();
    view = mount(BadgeLaunchAnnouncement, { target: document.body, props: { badges, progress, onclose, onopenbadges } });
    flushSync();
    return { onclose, onopenbadges, root: document.querySelector<HTMLElement>('[data-testid="badge-launch"]')! };
  }

  it("is a labelled modal dialog that introduces accomplishments and names every badge", () => {
    const { root } = open(EARNED);
    const dialog = root.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Accomplishments");
    expect(root.querySelectorAll('[data-testid="badge-card"]')).toHaveLength(LAUNCH_HAND_MAX);
    expect(root.querySelector('[data-testid="badge-launch-more"]')?.textContent).toBe("+2 more");
    const names = [...root.querySelectorAll('[data-testid="badge-launch-list"] li')].map((li) => li.textContent);
    expect(names).toContain("Maker, Silver");
    expect(names).toContain("Founding Member");
    expect(names).toHaveLength(EARNED.length);
  });

  it("draws straight under <body>, outside the zoomed app shell, on an opaque stage", () => {
    // Owner, 2026-10-15: "cut off at bottom" at the Large interface size. The
    // shell carries the Interface size zoom, so a layer inside it was taller
    // than the window.
    const { root } = open(EARNED);
    expect(root.parentElement).toBe(document.body);
    expect(root.closest(".desktop-shell")).toBeNull();
    const css = read("BadgeLaunchAnnouncement.svelte").match(/\.la-layer \{[^}]+\}/)?.[0] ?? "";
    expect(css).toMatch(/background: oklch\(0\.15 0\.006 285\);/);
  });

  it("starts on See your badges, which opens the Badges page", async () => {
    const { root, onopenbadges, onclose } = open(EARNED);
    await tick();
    const primary = root.querySelector<HTMLButtonElement>('[data-testid="badge-launch-open"]')!;
    expect(document.activeElement).toBe(primary);
    primary.click();
    vi.advanceTimersByTime(300);
    expect(onopenbadges).toHaveBeenCalledOnce();
    expect(onclose).not.toHaveBeenCalled();
  });

  it("closes with Escape, the close button and Not now", () => {
    for (const how of ["escape", "badge-launch-close", "badge-launch-later"]) {
      const { root, onclose } = open(EARNED);
      if (how === "escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      else root.querySelector<HTMLButtonElement>(`[data-testid="${how}"]`)!.click();
      vi.advanceTimersByTime(300);
      expect(onclose, how).toHaveBeenCalledOnce();
      unmount(view!);
      view = null;
    }
  });

  it("deals face-down cards and the nearest badges to someone with none", () => {
    const { root } = open([], [
      { id: "maker", current: 2, target: 5, unit: "skills" },
      { id: "poweruser", current: 64, target: 100, unit: "runs" },
    ]);
    expect(root.dataset.state).toBe("empty");
    expect(root.querySelectorAll('[data-testid="badge-card"]')).toHaveLength(0);
    expect(root.querySelectorAll(".la-back")).toHaveLength(3);
    expect(root.querySelector('[data-testid="badge-launch-next"]')?.textContent).toContain("64 of 100 runs");
    expect(root.querySelector('[data-testid="badge-launch-open"]')?.textContent?.trim()).toBe("See all badges");
  });

  it("keeps the app's rules: reduced motion, no bold, no em dashes in its copy", () => {
    const src = read("BadgeLaunchAnnouncement.svelte");
    expect(src).toContain("prefers-reduced-motion: reduce");
    expect(src).not.toMatch(/font-weight:\s*(6|7|8|9)00|font:\s*(6|7|8|9)00/);
    expect(src).not.toContain("backdrop-filter");
    const copy = [launchLead(0), launchLead(1), launchLead(3), "New in HQ", "Accomplishments", "See your badges", "Not now"].join(" ");
    expect(copy).not.toMatch(/—|--/);
  });
});

describe("wiring", () => {
  it("the shell opens it from the gate and records it as seen on close", () => {
    const shell = read("../shell/DesktopApp.svelte");
    expect(shell).toContain("<BadgeLaunchAnnouncement");
    expect(shell).toMatch(/shouldShowLaunch\(\{ uid, enabled: youBadgesEnabled/);
    expect(shell).toContain("markLaunchSeen(uid)");
    expect(shell).toMatch(/visualFirstRunOpen \|\| Boolean\(tourStep\)/);
  });
});
