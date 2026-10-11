// @vitest-environment happy-dom
/**
 * The tier mark on profile pictures (owner pick 2026-10-09, option B): the
 * highest level someone has reached, as a flat dot with a spark at the
 * bottom right, the live dot moved to the top right. A short hover names
 * the badge behind it. Only pictures as big as a chat message's (32px) carry
 * it; replies' small avatars and member lists do not (owner review).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import TierMark from "./TierMark.svelte";
import IdentityMark from "../chat/messaging/IdentityMark.svelte";
import { highestTier, tierMarkPx, topBadge } from "./badge-tier.js";
import { resolveEarned } from "./badge-catalog.js";
import { setBadgeSource } from "./badge-source.js";
import type { EarnedBadge } from "./badge-catalog.js";

const here = dirname(fileURLToPath(import.meta.url));

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(async () => {
  vi.useRealTimers();
  if (component) await unmount(component);
  component = null;
  host.remove();
  setBadgeSource(null);
});

const MIX: EarnedBadge[] = [
  { id: "liftoff", tier: 1, earnedAt: "2026-10-06" },
  { id: "poweruser", tier: 3, earnedAt: "2026-09-14" },
  { id: "founder", earnedAt: "2026-03-04" },
  { id: "bughunter", tier: 2, earnedAt: "2026-09-28" },
];

const FOUNDING = resolveEarned([{ id: "founding", earnedAt: "2026-03-02" }])[0]!;

describe("which tier shows", () => {
  it("is the highest level reached, the newest badge when several share it", () => {
    expect(highestTier([])).toBeNull();
    expect(highestTier([{ id: "liftoff", tier: 1, earnedAt: "2026-10-06" }])).toBe(1);
    // Power User (Gold, Sep 14) is newer than Founder (Gold, Mar 4).
    expect(topBadge(MIX)?.def.id).toBe("poweruser");
    expect(highestTier(MIX)).toBe(3);
  });

  it("counts Founding Member as Gold, a single plain tier", () => {
    expect(topBadge([{ id: "founding", earnedAt: "2026-03-02" }])?.tier).toBe(3);
  });

  it("is about 40% of the picture, between 9 and 20px", () => {
    expect(tierMarkPx(20)).toBe(9);
    expect(tierMarkPx(32)).toBe(13);
    expect(tierMarkPx(48)).toBe(19);
    expect(tierMarkPx(64)).toBe(20);
  });
});

describe("TierMark", () => {
  it("shows on pictures from 32px, with its spark, and not on smaller ones", () => {
    component = mount(TierMark, { target: host, props: { tier: 2, avatar: 26 } });
    flushSync();
    expect(host.querySelector("[data-testid='tier-mark']")).toBeNull();
    unmount(component);
    component = mount(TierMark, { target: host, props: { tier: "L", avatar: 32 } });
    flushSync();
    expect(host.querySelector("[data-testid='tier-mark']")?.getAttribute("data-tier")).toBe("L");
    expect(host.querySelector("[data-testid='tier-mark-spark']")).not.toBeNull();
  });

  it("shows the badge after a short hover, and hides on leave", () => {
    vi.useFakeTimers();
    component = mount(TierMark, { target: host, props: { tier: "L", avatar: 32, badge: FOUNDING } });
    flushSync();
    const mark = host.querySelector<HTMLElement>("[data-testid='tier-mark']")!;
    mark.dispatchEvent(new PointerEvent("pointerenter"));
    vi.advanceTimersByTime(500);
    flushSync();
    expect(document.querySelector("[data-testid='tier-mark-card']")).toBeNull();
    vi.advanceTimersByTime(100);
    flushSync();
    const card = document.querySelector<HTMLElement>("[data-testid='tier-mark-card']");
    expect(card?.textContent).toContain("Founding Member");
    expect(card?.textContent).toContain("Legendary badge · highest earned");
    // The badge's own micro mark, not a plain dot (owner review 2026-10-09).
    expect(card?.querySelector("canvas[data-badge='founding']")).not.toBeNull();
    // Shown at 36px, the height of the two lines beside it.
    expect(readFileSync(join(here, "TierMark.svelte"), "utf8")).toMatch(/\.tmc-mark :global\(canvas\) \{ width: 36px !important; height: 36px !important; \}/);
    // On <body>, so no scrolling list or popover clips it.
    expect(card?.parentElement).toBe(document.body);
    mark.dispatchEvent(new PointerEvent("pointerleave"));
    flushSync();
    expect(document.querySelector("[data-testid='tier-mark-card']")).toBeNull();
  });

  // A stray space beside the mark became a second grid row in the side-nav
  // picture and lifted its initials (owner review 2026-10-09).
  it("adds no text beside itself to the picture it sits in", () => {
    component = mount(TierMark, { target: host, props: { tier: "L", avatar: 32, badge: FOUNDING } });
    flushSync();
    const text = [...host.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent !== "");
    expect(text).toEqual([]);
  });

  it("shows on a small picture only when asked to (your side-nav picture)", () => {
    component = mount(TierMark, { target: host, props: { tier: 3, avatar: 26, anySize: true } });
    flushSync();
    expect(host.querySelector("[data-testid='tier-mark']")?.getAttribute("data-tier")).toBe("3");
  });

  it("without a badge it has no card and lets the pointer through", () => {
    vi.useFakeTimers();
    component = mount(TierMark, { target: host, props: { tier: 1, avatar: 32 } });
    flushSync();
    const mark = host.querySelector<HTMLElement>("[data-testid='tier-mark']")!;
    expect(mark.classList.contains("has-card")).toBe(false);
    mark.dispatchEvent(new PointerEvent("pointerenter"));
    vi.advanceTimersByTime(700);
    flushSync();
    expect(document.querySelector("[data-testid='tier-mark-card']")).toBeNull();
  });
});

describe("profile pictures", () => {
  it("show a person's tier from their badges, and none without badges", () => {
    setBadgeSource(({ name }) => (name === "Maya Chen" ? MIX : []));
    component = mount(IdentityMark, { target: host, props: { kind: "person", label: "Maya Chen", online: true } });
    flushSync();
    expect(host.querySelector("[data-testid='tier-mark']")?.getAttribute("data-tier")).toBe("3");
    unmount(component);
    component = mount(IdentityMark, { target: host, props: { kind: "person", label: "Stefan Johnson" } });
    flushSync();
    expect(host.querySelector("[data-testid='tier-mark']")).toBeNull();
  });

  it("leave it off small pictures, like a reply's avatars", () => {
    setBadgeSource(() => MIX);
    component = mount(IdentityMark, { target: host, props: { kind: "person", label: "Maya Chen", size: "small" } });
    flushSync();
    expect(host.querySelector("[data-testid='tier-mark']")).toBeNull();
    unmount(component);
    component = mount(IdentityMark, { target: host, props: { kind: "person", label: "Maya Chen", size: "large" } });
    flushSync();
    expect(host.querySelector("[data-testid='tier-mark']")).not.toBeNull();
  });

  it("an explicit null tier shows none; agents get none", () => {
    setBadgeSource(() => MIX);
    component = mount(IdentityMark, { target: host, props: { kind: "person", label: "Maya Chen", tier: null } });
    flushSync();
    expect(host.querySelector("[data-testid='tier-mark']")).toBeNull();
    unmount(component);
    component = mount(IdentityMark, { target: host, props: { kind: "agent", label: "Deacon" } });
    flushSync();
    expect(host.querySelector("[data-testid='tier-mark']")).toBeNull();
  });

  it("move the live dot to the top right wherever the mark can show, and only there", () => {
    const top = (file: string, sel: string) => {
      const src = readFileSync(join(here, file), "utf8");
      const body = src.match(new RegExp(`\\n  ${sel.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`))?.[1] ?? "";
      return /\btop:/.test(body) && !/\bbottom:\s*-?\d/.test(body);
    };
    expect(top("../chat/messaging/IdentityMark.svelte", ".presence")).toBe(true);
    expect(top("../chat/messaging/IdentityMark.svelte", ".small .presence")).toBe(false);
    expect(top("../shell/AccountMenu.svelte", ".live")).toBe(true);
    // Member lists' 20px pictures carry no mark: their live dots stay put.
    expect(top("../chat/ChannelStatusPopover.svelte", ".presence-dot")).toBe(false);
    // Your side-nav picture moves its live dot up only when it has a mark.
    expect(top("../shell/AppRail.svelte", ".you-live")).toBe(false);
    expect(top("../shell/AppRail.svelte", ".you-live.with-tier")).toBe(true);
    expect(readFileSync(join(here, "../shell/profile-panes/UserProfilePane.svelte"), "utf8")).toMatch(/\.ld \{[^}]*right: 0; top: 0;/);
  });
});
