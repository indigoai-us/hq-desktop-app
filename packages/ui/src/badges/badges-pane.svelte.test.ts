// @vitest-environment happy-dom
/**
 * Step 2 of the badge cards (owner decision 2026-10-08): "See all" on a
 * profile opens a Badges page in the profile pane. "Badges" groups every
 * badge by tier, earned ones plus locked ones with what earns them and plain
 * progress; "Cards" is a binder of the person's cards, one per earned badge,
 * each opening the card on its dark stage. Production has no source, so
 * nothing shows there.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ProfilePaneHost from "../shell/profile-panes/ProfilePaneHost.svelte";
import BadgesPane from "./BadgesPane.svelte";
import { BADGES, BADGE_BY_ID, type EarnedBadge } from "./badge-catalog.js";
import { badgeCollection, firstTier, progressText } from "./badge-collection.js";
import { badgeProgressFor, setBadgeProgressSource, setBadgeSource, type BadgeProgress } from "./badge-source.js";

const EARNED: EarnedBadge[] = [
  { id: "founding", earnedAt: "2026-03-02" },
  { id: "poweruser", tier: 3, earnedAt: "2026-09-14" },
  { id: "liftoff", tier: 2, earnedAt: "2026-10-06" },
  { id: "connector", tier: 1, earnedAt: "2026-08-21" },
];
const PROGRESS: BadgeProgress[] = [
  { id: "toolbox", current: 3, target: 5, unit: "skills" },
  { id: "closer", current: 1200, target: 10, unit: "stories" },
  { id: "shipit", current: 0, target: 1, unit: "projects" },
];

const mounted: Array<ReturnType<typeof mount>> = [];
let host: HTMLElement;

beforeEach(() => {
  Object.defineProperty(navigator, "gpu", { configurable: true, get: () => undefined });
  host = document.createElement("div");
  host.className = "desktop-shell";
  document.body.appendChild(host);
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
  setBadgeSource(null);
  setBadgeProgressSource(null);
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

const click = (selector: string) => (host.querySelector(selector) as HTMLElement).click();

describe("badge collection", () => {
  it("puts a locked badge in the tier its first level gives", () => {
    expect(firstTier(BADGE_BY_ID.liftoff)).toBe(1);
    expect(firstTier(BADGE_BY_ID.founder)).toBe(3);
    expect(firstTier(BADGE_BY_ID.founding)).toBe(3);
  });

  it("says progress plainly", () => {
    expect(progressText(BADGE_BY_ID.toolbox, PROGRESS[0])).toBe("3 of 5 skills");
    expect(progressText(BADGE_BY_ID.closer, PROGRESS[1])).toBe("10 of 10 stories");
    expect(progressText(BADGE_BY_ID.liftoff, { id: "liftoff", current: 0.5, target: 1, unit: "deploys" })).toBe("0 of 1 deploy");
    expect(progressText(BADGE_BY_ID.shipit, PROGRESS[2])).toBe("Not started");
    expect(progressText(BADGE_BY_ID.toolbox)).toBe("Not started");
    expect(progressText(BADGE_BY_ID.founding)).toBe("No longer available");
    expect(progressText(BADGE_BY_ID.poweruser, { id: "poweruser", current: 1500, target: 10000, unit: "runs" })).toBe("1,500 of 10,000 runs");
  });

  it("groups every badge by tier, highest first, earned before locked", () => {
    const groups = badgeCollection(EARNED, PROGRESS);
    expect(groups.map((g) => [g.label, g.earned, g.tiles.length])).toEqual([
      ["Gold", 2, 3],
      ["Silver", 1, 1],
      ["Bronze", 1, 11],
    ]);
    expect(groups.flatMap((g) => g.tiles).length).toBe(15);
    const bronze = groups[2].tiles;
    expect(bronze[0]).toMatchObject({ def: { id: "connector" }, earned: { tier: 1 } });
    expect(bronze.slice(1).every((t) => t.earned === null)).toBe(true);
    expect(bronze.find((t) => t.def.id === "toolbox")?.progress).toBe("3 of 5 skills");
  });

  it("has no progress in production", () => {
    expect(badgeProgressFor({ kind: "person", name: "Ada" })).toEqual([]);
  });
});

describe("BadgesPane", () => {
  it("shows earned marks and locked outlines with criteria and progress, grouped by tier", async () => {
    const opened: string[] = [];
    mounted.push(mount(BadgesPane, { target: host, props: { badges: EARNED, progress: PROGRESS, owner: "Maya Chen", onselect: (b) => opened.push(b.def.id) } }));
    await settle();
    expect(host.querySelector('[data-testid="badges-pane-summary"]')?.textContent).toBe("4 of 15 earned");
    expect([...host.querySelectorAll('[data-testid="badges-group"] .k')].map((k) => k.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "Gold 2/3",
      "Silver 1/1",
      "Bronze 1/11",
    ]);
    const toolbox = host.querySelector('[data-testid="badges-tile"][data-badge-id="toolbox"]')!;
    expect(toolbox.getAttribute("data-state")).toBe("locked");
    expect(toolbox.tagName).toBe("DIV");
    // What earns it lives in a hover card the tile points at, not in the grid.
    expect(toolbox.querySelector(".cr")).toBeNull();
    expect(toolbox.getAttribute("tabindex")).toBe("0");
    const card = host.querySelector(`#${toolbox.getAttribute("aria-describedby")}`);
    expect(card?.getAttribute("role")).toBe("tooltip");
    expect(card?.textContent).toBe("Different skills used");
    expect(toolbox.querySelector('[data-testid="badges-progress"]')?.textContent).toBe("3 of 5 skills");
    expect(toolbox.querySelector("canvas")?.getAttribute("aria-label") ?? toolbox.querySelector("[aria-label]")?.getAttribute("aria-label")).toContain("not earned yet");
    const liftoff = host.querySelector('[data-testid="badges-tile"][data-badge-id="liftoff"]') as HTMLButtonElement;
    expect(liftoff.getAttribute("data-state")).toBe("earned");
    expect(liftoff.textContent).toContain("Silver");
    liftoff.click();
    expect(opened).toEqual(["liftoff"]);
  });

  it("shows each badge's criteria in a hover card only on hover or keyboard focus", () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "BadgesPane.svelte"), "utf8");
    expect(src).toMatch(/\.hc \{[^}]*opacity: 0;[^}]*visibility: hidden;/);
    expect(src).toMatch(/\.b:hover \.hc, \.b:focus-visible \.hc \{[^}]*opacity: 1; visibility: visible;/);
    expect(src).not.toMatch(/title="\{tile\.def\.name\}/);
  });

  it("keeps See all a plain text button inside the mono caps label", () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "ProfileBadges.svelte"), "utf8");
    expect(src).toMatch(/\.link \{[^}]*font: 400 12px\/1\.4 var\(--font-ui[^}]*letter-spacing: normal; text-transform: none;/);
  });

  it("lays the cards out like a binder page and opens one on the stage", async () => {
    mounted.push(mount(BadgesPane, { target: host, props: { badges: EARNED, owner: "Maya Chen" } }));
    await settle();
    click('[data-testid="badges-pane-tab-cards"]');
    await settle();
    expect(host.querySelector('[data-testid="badges-pane"]')?.getAttribute("data-tab")).toBe("cards");
    expect(host.querySelector('[data-testid="badges-pane-tab-cards"]')?.getAttribute("aria-selected")).toBe("true");
    const cards = [...host.querySelectorAll('[data-testid="badges-card"]')];
    expect(cards.map((c) => c.getAttribute("data-badge-id"))).toEqual(["liftoff", "poweruser", "connector", "founding"]);
    expect(host.querySelectorAll('[data-testid="badges-empty-pocket"]').length).toBe(5);
    // Thumbnails are the static card: no foil, no tilt.
    expect([...host.querySelectorAll('[data-testid="badges-card"] [data-testid="badge-card"]')].map((c) => c.getAttribute("data-render"))).toEqual(["static", "static", "static", "static"]);
    const founding = host.querySelector('[data-testid="badges-card"][data-badge-id="founding"]') as HTMLButtonElement;
    expect(founding.getAttribute("aria-label")).toBe("Open the Founding Member card, Gold");
    founding.click();
    await settle();
    const modal = document.querySelector('[data-testid="badge-card-modal"]')!;
    expect(modal.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain("Founding Member card, Gold");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle();
    expect(document.querySelector('[data-testid="badge-card-modal"]')).toBeNull();
    expect(document.activeElement).toBe(founding);
  });

  it("moves between the two views with the arrow keys", async () => {
    mounted.push(mount(BadgesPane, { target: host, props: { badges: EARNED } }));
    await settle();
    const tab = host.querySelector('[data-testid="badges-pane-tab-badges"]') as HTMLElement;
    tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await settle();
    expect(host.querySelector('[data-testid="badges-pane"]')?.getAttribute("data-tab")).toBe("cards");
  });

  it("starts a second 9-pocket page at the tenth card", async () => {
    const ten = BADGES.slice(0, 10).map((def, i) => ({ id: def.id, earnedAt: `2026-0${(i % 9) + 1}-01T00:00:00Z` }));
    mounted.push(mount(BadgesPane, { target: host, props: { badges: ten, owner: "Maya Chen" } }));
    await settle();
    click('[data-testid="badges-pane-tab-cards"]');
    await settle();
    const pages = [...host.querySelectorAll('[data-testid="badges-binder-page"]')];
    expect(pages).toHaveLength(2);
    expect(pages.map((p) => p.querySelectorAll('[data-testid="badges-card"]').length)).toEqual([9, 1]);
    expect(pages.map((p) => p.querySelectorAll('[data-testid="badges-empty-pocket"]').length)).toEqual([0, 8]);
    expect(pages[1].getAttribute("aria-label")).toBe("Cards, page 2 of 2");
  });

  it("has an empty binder before any badge is earned", async () => {
    mounted.push(mount(BadgesPane, { target: host, props: { badges: [], tab: "cards" } }));
    await settle();
    expect(host.querySelector('[data-testid="badges-binder"]')).toBeNull();
    expect(host.textContent).toContain("Cards appear here as badges are earned.");
  });
});

describe("See all on a profile", () => {
  it("opens the Badges page in the pane; a badge comes back to it, and Back returns to the profile", async () => {
    setBadgeSource(() => EARNED);
    setBadgeProgressSource(() => PROGRESS);
    mounted.push(mount(ProfilePaneHost, { target: host, props: { kind: "person", name: "Maya Chen", company: "Indigo" } }));
    await settle();
    const all = host.querySelector('[data-testid="profile-badges-all"]') as HTMLButtonElement;
    // "See all" shows even with four or fewer earned: the page also has the locked badges and the cards.
    expect(all.textContent).toBe("See all");
    all.click();
    await settle();
    expect(host.querySelector('[data-testid="user-profile-pane"]')).toBeNull();
    expect(host.querySelector('[data-testid="badges-pane"]')?.getAttribute("aria-label")).toBe("Maya Chen's badges");
    expect(host.querySelector('[data-testid="badges-progress"]')).not.toBeNull();

    click('[data-testid="badges-tile"][data-badge-id="poweruser"]');
    await settle();
    expect(host.querySelector('[data-testid="badge-detail-pane"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="badge-detail-back"]')?.getAttribute("aria-label")).toBe("Back to badges");
    click('[data-testid="badge-detail-back"]');
    await settle();
    expect(host.querySelector('[data-testid="badges-pane"]')).not.toBeNull();

    click('[data-testid="badges-pane-back"]');
    await settle();
    expect(host.querySelector('[data-testid="user-profile-pane"]')).not.toBeNull();
    // A badge opened from the profile itself still goes back to the profile.
    click('[data-testid="profile-badge"][data-badge-id="liftoff"]');
    await settle();
    expect(host.querySelector('[data-testid="badge-detail-back"]')?.getAttribute("aria-label")).toBe("Back to profile");
  });

  it("is on a bot's profile too", async () => {
    setBadgeSource(() => [{ id: "liftoff", tier: 2, earnedAt: "2026-10-05" }]);
    mounted.push(mount(ProfilePaneHost, { target: host, props: { kind: "bot", name: "deacon", company: "Indigo" } }));
    await settle();
    click('[data-testid="profile-badges-all"]');
    await settle();
    expect(host.querySelector('[data-testid="badges-pane-summary"]')?.textContent).toBe("1 of 15 earned");
  });

  it("shows nothing in production, where there is no source", async () => {
    mounted.push(mount(ProfilePaneHost, { target: host, props: { kind: "person", name: "Maya Chen", company: "Indigo" } }));
    await settle();
    expect(host.querySelector('[data-testid="profile-badges"]')).toBeNull();
    expect(host.querySelector('[data-testid="profile-badges-all"]')).toBeNull();
  });
});
