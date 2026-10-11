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
