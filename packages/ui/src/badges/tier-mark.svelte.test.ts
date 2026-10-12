// @vitest-environment happy-dom
/**
 * The tier mark on profile pictures: the highest level someone has reached
 * at the bottom right, the live dot moved to the top right. Since the owner
 * pick of 2026-10-12 (option B, "icon in a ring") it is the top badge's
 * Phosphor icon in the tier colour inside a ring of the same stroke weight.
 * A short hover opens a one-line card with the same mark, the badge's name
 * and its level. Only pictures as big as a chat message's (32px) carry
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
import { BADGES, resolveEarned } from "./badge-catalog.js";
import { BADGE_GLYPH, BADGE_GLYPH_SCALE, BADGE_GLYPH_STROKE, BADGE_RING_STROKE, badgeGlyphUrl } from "./badge-glyph.js";
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

const OG = resolveEarned([{ id: "og", earnedAt: "2026-10-11" }])[0]!;

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

  it("is about 40% of the picture, between 12 and 20px", () => {
    // 12px is the smallest the icon in its ring reads at (owner pick 2026-10-12).
    expect(tierMarkPx(20)).toBe(12);
    expect(tierMarkPx(26)).toBe(12);
    expect(tierMarkPx(32)).toBe(13);
    expect(tierMarkPx(48)).toBe(19);
    expect(tierMarkPx(64)).toBe(20);
  });
});

describe("TierMark", () => {
  it("shows on pictures from 32px, and not on smaller ones; a spark when there's no badge", () => {
    component = mount(TierMark, { target: host, props: { tier: 2, avatar: 26 } });
    flushSync();
    expect(host.querySelector("[data-testid='tier-mark']")).toBeNull();
    unmount(component);
    component = mount(TierMark, { target: host, props: { tier: "L", avatar: 32 } });
    flushSync();
    expect(host.querySelector("[data-testid='tier-mark']")?.getAttribute("data-tier")).toBe("L");
    expect(host.querySelector("[data-testid='tier-mark-glyph']")?.getAttribute("data-icon")).toBe("spark");
  });

  it("draws the badge's own icon in a ring as thick as the icon's strokes", () => {
    component = mount(TierMark, { target: host, props: { tier: "L", avatar: 32, badge: OG } });
    flushSync();
    const mark = host.querySelector<HTMLElement>("[data-testid='tier-mark']")!;
    expect(mark.querySelector("[data-testid='tier-mark-glyph']")?.getAttribute("data-icon")).toBe("crown");
    expect(mark.style.getPropertyValue("--glyph")).toBe(badgeGlyphUrl("crown"));
    // Ring = icon size x Phosphor Bold's 24/256 stroke (owner review 2026-10-12).
    expect(mark.style.getPropertyValue("--ic")).toBe(String(BADGE_GLYPH_SCALE));
    expect(BADGE_GLYPH_STROKE).toBe(24 / 256);
    expect(BADGE_RING_STROKE).toBeCloseTo(256 * 0.6 * (24 / 256));
    const ring = decodeURIComponent(mark.style.getPropertyValue("--ring"));
    expect(ring).toContain(`stroke-width="${BADGE_RING_STROKE}"`);
    expect(ring).toContain(`r="${128 - BADGE_RING_STROKE / 2}"`);
    const src = readFileSync(join(here, "TierMark.svelte"), "utf8");
    expect(src).toMatch(/\.tm-glyph \{\s*width: calc\(var\(--tm\) \* var\(--ic\)\); height: calc\(var\(--tm\) \* var\(--ic\)\);/);
    // The ring is a vector mask, not a sub-pixel box ring, which rendered
    // lumpy (owner review 2026-10-12).
    expect(src).toMatch(/mask: var\(--ring\) center \/ 100% 100% no-repeat;/);
    expect(src).not.toMatch(/mask-composite/);
  });

  it("has a Phosphor icon for every badge", () => {
    for (const def of BADGES) expect(BADGE_GLYPH[def.icon], def.id).toMatch(/^M/);
  });

  it("shows the badge after a short hover, and hides on leave", () => {
    vi.useFakeTimers();
    component = mount(TierMark, { target: host, props: { tier: "L", avatar: 32, badge: OG } });
    flushSync();
    const mark = host.querySelector<HTMLElement>("[data-testid='tier-mark']")!;
    mark.dispatchEvent(new PointerEvent("pointerenter"));
    vi.advanceTimersByTime(500);
    flushSync();
    expect(document.querySelector("[data-testid='tier-mark-card']")).toBeNull();
    vi.advanceTimersByTime(100);
    flushSync();
    const card = document.querySelector<HTMLElement>("[data-testid='tier-mark-card']");
    // One compact line: the name, then just the level (owner pick 2026-10-12).
    expect(card?.querySelector(".tmc-name")?.textContent).toBe("OG");
    expect(card?.querySelector(".tmc-sub")?.textContent).toBe("Legendary");
    // The same mark as on the picture, at the same size.
    const inCard = card?.querySelector<HTMLElement>(".tmc-mark");
    expect(inCard?.querySelector("[data-testid='tier-mark-card-glyph']")?.getAttribute("data-icon")).toBe("crown");
    expect(inCard?.style.getPropertyValue("--tm")).toBe(mark.style.getPropertyValue("--tm"));
    // On <body>, so no scrolling list or popover clips it.
    expect(card?.parentElement).toBe(document.body);
    mark.dispatchEvent(new PointerEvent("pointerleave"));
    flushSync();
    expect(document.querySelector("[data-testid='tier-mark-card']")).toBeNull();
  });

  // A stray space beside the mark became a second grid row in the side-nav
  // picture and lifted its initials (owner review 2026-10-09).
  it("adds no text beside itself to the picture it sits in", () => {
    component = mount(TierMark, { target: host, props: { tier: "L", avatar: 32, badge: OG } });
    flushSync();
    const text = [...host.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent !== "");
    expect(text).toEqual([]);
  });

  it("shows on a small picture only when asked to (your side-nav picture)", () => {
    component = mount(TierMark, { target: host, props: { tier: 3, avatar: 26, anySize: true } });
    flushSync();
    expect(host.querySelector("[data-testid='tier-mark']")?.getAttribute("data-tier")).toBe("3");
  });

  it("with the card turned off (your side-nav picture) it shows the icon but opens nothing", () => {
    vi.useFakeTimers();
    component = mount(TierMark, { target: host, props: { tier: "L", avatar: 26, anySize: true, badge: OG, card: false } });
    flushSync();
    const mark = host.querySelector<HTMLElement>("[data-testid='tier-mark']")!;
    expect(mark.querySelector("[data-testid='tier-mark-glyph']")?.getAttribute("data-icon")).toBe("crown");
    expect(mark.classList.contains("has-card")).toBe(false);
    mark.dispatchEvent(new PointerEvent("pointerenter"));
    vi.advanceTimersByTime(700);
    flushSync();
    expect(document.querySelector("[data-testid='tier-mark-card']")).toBeNull();
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
