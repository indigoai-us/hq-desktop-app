// @vitest-environment happy-dom
/**
 * The rail's You button shows your badges on hover, with "See all" to your
 * profile panel (owner request 2026-10-08). Without badges it keeps its
 * plain tooltip.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import AppRail from "./AppRail.svelte";
import ProfilePaneHost from "./profile-panes/ProfilePaneHost.svelte";
import { railItems } from "./app-rail.js";
import { setBadgeSource } from "../badges/badge-source.js";
import type { EarnedBadge } from "../badges/badge-catalog.js";

const items = railItems([{ uid: "co_a", label: "Indigo", liveCount: 0 }], "Ada Lovelace");

const NINE: EarnedBadge[] = [
  { id: "founding", earnedAt: "2026-03-02" },
  { id: "founder", earnedAt: "2026-03-04" },
  { id: "bughunter", tier: 2, earnedAt: "2026-09-28" },
  { id: "liftoff", tier: 1, earnedAt: "2026-10-06" },
  { id: "poweruser", tier: 3, earnedAt: "2026-09-14" },
  { id: "sharer", tier: 1, earnedAt: "2026-09-01" },
  { id: "connector", tier: 1, earnedAt: "2026-08-20" },
  { id: "teambuilder", tier: 2, earnedAt: "2026-08-02" },
  { id: "toolbox", tier: 1, earnedAt: "2026-07-12" },
];

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  vi.useFakeTimers();
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

function rail(props: Record<string, unknown> = {}) {
  component = mount(AppRail, {
    target: host,
    props: { items, activeId: null, onselect: () => {}, youBadges: NINE, youWork: "Badge share cards", ...props },
  });
  flushSync();
}

const you = () => host.querySelector<HTMLButtonElement>("[data-testid='rail-you']")!;
const card = () => host.querySelector<HTMLElement>("[data-testid='rail-you-card']");

function hover(): void {
  you().closest(".you-wrap")!.dispatchEvent(new PointerEvent("pointerenter"));
  vi.advanceTimersByTime(300);
  flushSync();
}

describe("You hover card", () => {
  it("keeps the plain tooltip when you have no badges", () => {
    rail({ youBadges: [] });
    expect(you().closest(".you-wrap")).toBeNull();
    you().closest(".tooltip-wrap")!.dispatchEvent(new PointerEvent("pointerenter"));
    vi.advanceTimersByTime(300);
    flushSync();
    expect(card()).toBeNull();
    expect(host.querySelector("[data-testid='tooltip-bubble']")?.textContent).toContain("Ada Lovelace");
  });

  it("opens after a short dwell with your name, your work and up to eight badges", () => {
    rail();
    you().closest(".you-wrap")!.dispatchEvent(new PointerEvent("pointerenter"));
    vi.advanceTimersByTime(200);
    flushSync();
    expect(card()).toBeNull();
    vi.advanceTimersByTime(100);
    flushSync();
    expect(card()?.textContent).toContain("Ada Lovelace");
    expect(host.querySelector("[data-testid='rail-you-card-work']")?.textContent).toBe("Badge share cards");
    expect(card()?.textContent).toContain("Badges 9");
    expect(card()!.querySelectorAll("[data-testid='profile-badge']")).toHaveLength(8);
    // The card replaces the tooltip; no system tooltip either.
    expect(host.querySelector("[data-testid='tooltip-bubble']")).toBeNull();
    expect(card()!.querySelector("[title]")).toBeNull();
  });

  it("See all opens your profile panel and closes the card", () => {
    const onyoubadges = vi.fn();
    rail({ onyoubadges });
    hover();
    card()!.querySelector<HTMLButtonElement>("[data-testid='profile-badges-all']")!.click();
    flushSync();
    expect(onyoubadges).toHaveBeenCalledOnce();
    expect(card()).toBeNull();
  });

  it("a badge opens that badge in your profile panel", () => {
    const onyoubadge = vi.fn();
    rail({ onyoubadge });
    hover();
    card()!.querySelector<HTMLButtonElement>("[data-badge-id='liftoff']")!.click();
    expect(onyoubadge).toHaveBeenCalledWith(expect.objectContaining({ def: expect.objectContaining({ id: "liftoff" }), tier: 1 }));
  });

  it("stays open while the pointer crosses into it", () => {
    rail();
    hover();
    const wrap = you().closest(".you-wrap")!;
    wrap.dispatchEvent(new PointerEvent("pointerleave"));
    vi.advanceTimersByTime(100);
    wrap.dispatchEvent(new PointerEvent("pointerenter"));
    vi.advanceTimersByTime(400);
    flushSync();
    expect(card()).not.toBeNull();
    wrap.dispatchEvent(new PointerEvent("pointerleave"));
    vi.advanceTimersByTime(200);
    flushSync();
    expect(card()).toBeNull();
  });

  it("opens at once on keyboard focus and closes on Escape", () => {
    rail();
    you().focus();
    flushSync();
    expect(card()).not.toBeNull();
    you().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();
    expect(card()).toBeNull();
  });

  it("stays hidden while the account menu is open, and a press closes it", async () => {
    rail();
    hover();
    you().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    flushSync();
    expect(card()).toBeNull();
    await unmount(component!);
    component = null;
    rail({ youExpanded: true });
    hover();
    expect(card()).toBeNull();
  });
});

describe("profile panel opened from the You card", () => {
  it("opens straight to the Badges page, or to one badge", async () => {
    vi.useRealTimers();
    setBadgeSource(() => NINE);
    component = mount(ProfilePaneHost, {
      target: host,
      props: { kind: "person", name: "Ada Lovelace", view: "badges", openKey: 1 },
    });
    await tick();
    expect(host.querySelector("[data-testid='badges-pane']")).not.toBeNull();
    await unmount(component);

    component = mount(ProfilePaneHost, {
      target: host,
      props: { kind: "person", name: "Ada Lovelace", view: "profile", badgeId: "liftoff", openKey: 2 },
    });
    await tick();
    expect(host.querySelector("[data-testid='badge-detail-pane']")?.textContent).toContain("Liftoff");
    host.querySelector<HTMLButtonElement>("[data-testid='badge-detail-back']")!.click();
    await tick();
    expect(host.querySelector("[data-testid='user-profile-pane']")).not.toBeNull();
  });
});


describe("rail hover cards clear the rail's edge", () => {
  const read = (file: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), "utf8");

  // At +8px the rail's hover cards touched its border; 18px clears it by
  // about 8px (owner review 2026-10-08).
  it("the rail tooltips and the You card open 18px beside their button", () => {
    const tooltip = read("../common/Tooltip.svelte").match(/\.tooltip-bubble\.side-right \{([^}]*)\}/)?.[1] ?? "";
    expect(tooltip).toMatch(/left: calc\(100% \+ 18px\);/);
    const youCard = read("RailYouCard.svelte").match(/\n  \.card \{([^}]*)\}/)?.[1] ?? "";
    expect(youCard).toMatch(/left: calc\(100% \+ 18px\);/);
    // The bridge spans the whole gap, so moving onto the card keeps it open.
    expect(read("RailYouCard.svelte")).toMatch(/\.card::before \{[^}]*right: 100%; width: 20px;/);
  });

  // The account menu and More companies open the same distance out.
  it("the rail's click popovers open as far out as its hover cards", () => {
    const app = read("DesktopApp.svelte");
    expect(app).toContain("const RAIL_POPOVER_GAP = 16;");
    expect(app).toContain("moreCompaniesAnchor = { top: rect.top, left: rect.right + RAIL_POPOVER_GAP };");
    expect(app).toMatch(/function placeAccountMenu\(\)[\s\S]{0,300}left: rect\.right \+ RAIL_POPOVER_GAP,/);
  });

  // The side menu's width handle (z-index 10) sits under the hover cards'
  // left edge; above it the rail kept losing the pointer to the handle.
  it("the rail stacks above the side menu's width handle", () => {
    const rail = read("AppRail.svelte").match(/\n  \.app-rail \{([^}]*)\}/)?.[1] ?? "";
    const handle = read("SidebarResizeHandle.svelte").match(/\.resize-handle \{([^}]*)\}/)?.[1] ?? "";
    const z = (css: string) => Number(css.match(/z-index:\s*(\d+)/)?.[1] ?? "0");
    expect(z(rail)).toBeGreaterThan(z(handle));
  });
});

describe("your side-nav picture", () => {
  it("carries your tier mark, with the live dot moved up", async () => {
    component = mount(AppRail, {
      target: host,
      props: { items, activeId: null, onselect: () => {}, youBadges: NINE, youLive: true },
    });
    flushSync();
    const you = document.querySelector("[data-testid='rail-you']")!;
    expect(you.querySelector("[data-testid='tier-mark']")?.getAttribute("data-tier")).toBe("L");
    expect(you.querySelector("[data-testid='rail-you-live']")?.classList.contains("with-tier")).toBe(true);
  });

  it("has no mark without badges, and the live dot stays at the bottom", async () => {
    component = mount(AppRail, {
      target: host,
      props: { items, activeId: null, onselect: () => {}, youBadges: [], youLive: true },
    });
    flushSync();
    const you = document.querySelector("[data-testid='rail-you']")!;
    expect(you.querySelector("[data-testid='tier-mark']")).toBeNull();
    expect(you.querySelector("[data-testid='rail-you-live']")?.classList.contains("with-tier")).toBe(false);
  });
});
