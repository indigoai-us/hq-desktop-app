// @vitest-environment happy-dom
/**
 * The back of the badge card (owner request 2026-10-08): click the card to
 * flip it over and read a personal story of the accomplishment, what you did
 * and why it matters. Written to you on your own card, about the person on
 * someone else's.
 */
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BadgeCardModal from "./BadgeCardModal.svelte";
import BadgeDetailPane from "./BadgeDetailPane.svelte";
import { BADGES, BADGE_BY_ID, type BadgeTier, type ResolvedBadge } from "./badge-catalog.js";
import { REVEAL_FLIP_MS, REVEAL_GLOW_MS } from "./badge-card.js";
import { STORY_IDS, badgeStory, storyVoice } from "./badge-story.js";

const liftoff = (tier: BadgeTier): ResolvedBadge => ({ def: BADGE_BY_ID.liftoff, tier, earnedAt: "2026-10-06" });
const mounted: Array<ReturnType<typeof mount>> = [];
let host: HTMLElement;

function setMotion(reduce: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes("reduce"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  setMotion(false);
  Object.defineProperty(navigator, "gpu", { configurable: true, get: () => undefined });
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("the story", () => {
  it("covers every badge in the catalog", () => {
    expect([...STORY_IDS].sort()).toEqual(BADGES.map((b) => b.id).sort());
  });

  it("tells the honors stories in every voice", () => {
    const honor = (id: string): ResolvedBadge => ({ def: BADGE_BY_ID[id], tier: "L", earnedAt: "2026-10-11" });
    expect(badgeStory(honor("og"))?.did).toBe("You were on the team that built HQ from day one.");
    expect(badgeStory(honor("og"), "Corey Epstein")?.did).toBe("Corey was on the team that built HQ from day one.");
    expect(badgeStory(honor("og"), null, "first")?.did).toBe("I was on the team that built HQ from day one.");
    expect(badgeStory(honor("captain"))?.did).toBe("You lead HQ.");
    expect(badgeStory(honor("captain"), "Corey Epstein")?.did).toBe("Corey leads HQ.");
    expect(badgeStory(honor("captain"), null, "first")?.did).toBe("I lead HQ.");
    expect(badgeStory(honor("patientzero"), "Corey Epstein")?.did).toBe("Corey was the first person ever to run HQ, before it had a name.");
  });

  it("tells Core Builder's four levels with the same numbers", () => {
    const core = (tier: BadgeTier): ResolvedBadge => ({ def: BADGE_BY_ID.corebuilder, tier, earnedAt: "2026-10-11" });
    expect(([1, 2, 3, "L"] as BadgeTier[]).map((t) => badgeStory(core(t))?.did)).toEqual([
      "You got your first pull request merged into HQ core.",
      "You got 10 pull requests merged into HQ core.",
      "You got 100 pull requests merged into HQ core.",
      "You got 200 pull requests merged into HQ core.",
    ]);
    expect(badgeStory(core(1), "Maya Chen")?.did).toBe("Maya got their first pull request merged into HQ core.");
    // A three-level badge at Legendary still reads its Gold line.
    expect(badgeStory(liftoff("L"))?.did).toBe("You put 250 deploys live.");
  });

  it("speaks to you on your own card and about the person on theirs", () => {
    expect(storyVoice(null)).toEqual({ Subject: "You", subject: "you", possessive: "your", their: "your", Possessive: "Your" });
    expect(storyVoice("Maya Chen")).toMatchObject({ Subject: "Maya", possessive: "Maya's", their: "their" });
    // Never "Ada created Ada's first agent."
    const fleet: ResolvedBadge = { def: BADGE_BY_ID.fleet, tier: 1, earnedAt: "2026-10-06" };
    expect(badgeStory(fleet, "Ada Lovelace")?.did).toBe("Ada created their first agent.");
    expect(badgeStory(fleet, null, "first")?.did).toBe("I created my first agent.");
    expect(storyVoice("James")).toMatchObject({ possessive: "James'" });
    expect(badgeStory(liftoff(2))?.did).toBe("You put 50 deploys live.");
    expect(badgeStory(liftoff(2), "Maya Chen")?.did).toBe("Maya put 50 deploys live.");
  });

  it("tells the level reached, why it matters, and when", () => {
    expect(badgeStory(liftoff(1))?.did).toBe("You put 5 deploys live.");
    expect(badgeStory(liftoff(3))?.did).toBe("You put 250 deploys live.");
    const story = badgeStory(liftoff(2))!;
    expect(story.why).toMatch(/\.$/);
    expect(story.earned).toBe("Earned Oct 6, 2026");
    const founding = badgeStory({ def: BADGE_BY_ID.founding, tier: 3, earnedAt: "2026-03-02" }, "Maya Chen")!;
    expect(founding.did).toBe("Maya joined HQ before the public launch, while it was still being built.");
  });

  // Owner review 2026-10-12: OG, Captain and Patient Zero are given, not
  // earned. Core Builder is earned by merging pull requests.
  it("dates the given honors as Awarded, and Core Builder as Earned", () => {
    const at = (id: string): ResolvedBadge => ({ def: BADGE_BY_ID[id], tier: "L", earnedAt: "2026-10-11" });
    for (const id of ["og", "captain", "patientzero"]) expect(badgeStory(at(id))?.earned, id).toBe("Awarded Oct 11, 2026");
    expect(badgeStory(at("corebuilder"))?.earned).toBe("Earned Oct 11, 2026");
  });

  it("writes every line as a full sentence at every level", () => {
    for (const def of BADGES) {
      for (const tier of [1, 2, 3, "L"] as BadgeTier[]) {
        for (const owner of [null, "Maya Chen"]) {
          const story = badgeStory({ def, tier, earnedAt: "2026-10-06" }, owner)!;
          for (const line of [story.did, story.why]) {
            expect(line).toMatch(/^[A-Z0-9][^]*\.$/u);
            expect(line).not.toMatch(/undefined|\{|\}/u);
          }
        }
      }
    }
  });
});

describe("flipping the card", () => {
  const modal = () => document.querySelector('[data-testid="badge-card-modal"]') as HTMLElement;
  const flipper = () => modal().querySelector('[data-testid="badge-card-flipper"]') as HTMLElement;
  const flipState = () => modal().querySelector(".bc-flip")!.getAttribute("data-flipped");

  it("turns over on click to the story, and back again", () => {
    mounted.push(mount(BadgeCardModal, { target: host, props: { open: true, badge: liftoff(2), owner: "Maya Chen", onclose: () => {} } }));
    flushSync();
    const back = modal().querySelector(".bc-back")!;
    expect(flipState()).toBe("false");
    expect(back.getAttribute("aria-hidden")).toBe("true");
    expect(back.querySelector('[data-testid="badge-card-story"]')?.textContent).toBe("Maya put 50 deploys live.");

    flipper().click();
    flushSync();
    expect(flipState()).toBe("true");
    expect(back.hasAttribute("aria-hidden")).toBe(false);
    expect(modal().querySelector(".bc-face")?.getAttribute("aria-hidden")).toBe("true");
    expect(modal().querySelector('[data-testid="badge-card-flip"]')?.getAttribute("aria-pressed")).toBe("true");

    flipper().click();
    flushSync();
    expect(flipState()).toBe("false");
    // Clicking the card does not close the stage.
    expect(modal()).not.toBeNull();
  });

  it("has a Flip card button for the keyboard", () => {
    mounted.push(mount(BadgeCardModal, { target: host, props: { open: true, badge: liftoff(1), onclose: () => {} } }));
    flushSync();
    const button = modal().querySelector('[data-testid="badge-card-flip"]') as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe("Flip card");
    button.click();
    flushSync();
    expect(flipState()).toBe("true");
    expect(modal().querySelector('[data-testid="badge-card-story"]')?.textContent).toBe("You put 5 deploys live.");
  });

  it("waits for the reveal to settle, then shows the story on the back", () => {
    vi.useFakeTimers();
    mounted.push(mount(BadgeCardModal, { target: host, props: { open: true, badge: liftoff(1), reveal: true, onclose: () => {} } }));
    flushSync();
    // During the reveal the back is the plain logo, and the card cannot be turned.
    expect(modal().querySelector(".bc-back-logo")).not.toBeNull();
    expect((modal().querySelector('[data-testid="badge-card-flip"]') as HTMLButtonElement).disabled).toBe(true);
    flipper().click();
    flushSync();
    expect(flipState()).toBe("false");
    vi.advanceTimersByTime(REVEAL_GLOW_MS + REVEAL_FLIP_MS);
    flushSync();
    expect(modal().querySelector(".bc-back-logo")).toBeNull();
    flipper().click();
    flushSync();
    expect(flipState()).toBe("true");
    expect(modal().querySelector('[data-testid="badge-card-story"]')).not.toBeNull();
  });

  it("opens on the front each time", async () => {
    mounted.push(mount(BadgeDetailPane, { target: host, props: { badge: liftoff(2), owner: "Maya Chen" } }));
    flushSync();
    const viewCard = host.querySelector('[data-testid="badge-detail-view-card"]') as HTMLButtonElement;
    viewCard.click();
    flushSync();
    flipper().click();
    flushSync();
    expect(flipState()).toBe("true");
    (modal().querySelector('[data-testid="badge-card-close"]') as HTMLButtonElement).click();
    flushSync();
    await tick();
    viewCard.click();
    flushSync();
    expect(flipState()).toBe("false");
  });
});

// Owner review 2026-10-12: the given honors say "Awarded" on the detail page,
// the card stage and the card's back; Core Builder's Legendary is Tier IV.
describe("the honors on the detail page and the card", () => {
  const modal = () => document.querySelector('[data-testid="badge-card-modal"]') as HTMLElement;
  const open = (badge: ResolvedBadge) => {
    mounted.push(mount(BadgeDetailPane, { target: host, props: { badge, owner: "Corey Epstein" } }));
    flushSync();
    (host.querySelector('[data-testid="badge-detail-view-card"]') as HTMLButtonElement).click();
    flushSync();
  };

  it("says OG was awarded, to whom and when", () => {
    open({ def: BADGE_BY_ID.og, tier: "L", earnedAt: "2026-10-11" });
    expect(host.querySelector('[data-testid="badge-detail-meta"]')?.textContent).toBe("Legendary · Awarded Oct 11, 2026 to Corey Epstein");
    expect(modal().querySelector('[data-testid="badge-card-owner"]')?.textContent).toBe("Awarded to Corey Epstein");
    const back = modal().querySelector('[data-testid="badge-card-back"] .bot')!;
    expect(back.querySelector("b")?.textContent).toBe("Legendary");
    expect(back.querySelector("span")?.textContent).toBe("Awarded Oct 11, 2026");
    expect(modal().querySelector(".bc-face")?.textContent).not.toMatch(/Tier IV/u);
  });

  it("says Core Builder was earned, at Tier IV · Legendary on both sides of the card", () => {
    open({ def: BADGE_BY_ID.corebuilder, tier: "L", earnedAt: "2026-10-11" });
    expect(host.querySelector('[data-testid="badge-detail-meta"]')?.textContent).toBe("Legendary · Earned Oct 11, 2026 by Corey Epstein");
    expect(modal().querySelector('[data-testid="badge-card-owner"]')?.textContent).toBe("Earned by Corey Epstein");
    const back = modal().querySelector('[data-testid="badge-card-back"] .bot')!;
    expect(back.querySelector("b")?.textContent).toBe("Tier IV · Legendary");
    expect(back.querySelector("span")?.textContent).toBe("Earned Oct 11, 2026");
    expect(modal().querySelector(".bc-face")?.textContent).toContain("Tier IV · Legendary");
  });
});
