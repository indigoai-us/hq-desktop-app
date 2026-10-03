import { afterEach, describe, expect, it, vi } from "vitest";
import { formatShortcut } from "../common/keyboard-shortcuts.js";
import {
  TOUR_IDLE,
  TOUR_SEEN_STORAGE_KEY,
  backTourState,
  isTourHomeRow,
  nextTourState,
  placeTourCard,
  readTourSeenLocally,
  resolveTourTarget,
  scrimPath,
  shouldAutoStartTour,
  skipTourState,
  spotlightRect,
  startTourState,
  tourCanGoBack,
  tourPrimaryLabel,
  tourProgressLabel,
  tourSteps,
  unionTourRects,
  writeTourSeenLocally,
  type TourAutoStartInput,
} from "./guided-tour.js";

const originalUserAgent = navigator.userAgent;

afterEach(() => {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: originalUserAgent });
  vi.unstubAllGlobals();
});

function setHost(os: "windows" | "macos", userAgent: string): void {
  vi.stubGlobal("__HQ_HOST_OS__", os);
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: userAgent });
}

describe("tourSteps", () => {
  it("has the eight steps in order", () => {
    expect(tourSteps().map((s) => s.id)).toEqual([
      "setup-bot",
      "company-vault",
      "create-bot",
      "invite",
      "meetings",
      "web-console",
      "launch",
      "command-palette",
    ]);
  });

  it("targets the DM composer first only while the setup bot DM is open", () => {
    const open = tourSteps({ setupBotDmOpen: true, setupBotUid: "agt_1" })[0];
    expect(open.targets[0]).toBe(".dm-reply-composer");
    expect(open.targets).toContain('.chat-row[data-conversation-id="dm:agt_1"]');
    const closed = tourSteps({ setupBotDmOpen: false })[0];
    expect(closed.targets).not.toContain(".dm-reply-composer");
    expect(closed.targets.slice(0, 2)).toEqual([
      '[data-testid="setup-hero"]',
      '[data-testid="setup-channel-intro"]',
    ]);
    expect(closed.targets.at(-1)).toBe('.chat-row[data-conversation-id="ch:setup"]');
  });

  it("words the files step for a person with only Personal", () => {
    const withCompany = tourSteps({ hasCompanyVault: true })[1];
    expect(withCompany.title).toBe("Your company's files");
    expect(withCompany.body).toMatch(/^Click here to open your files\./);
    const personalOnly = tourSteps({ hasCompanyVault: false })[1];
    expect(personalOnly.title).toBe("Your files");
    expect(personalOnly.body).toMatch(/once setup creates it/);
  });

  it("wires the host actions to the right steps", () => {
    expect(tourSteps().map((s) => s.onEnter)).toEqual([
      "none",
      "none",
      "none",
      "none",
      "none",
      "none",
      "open-launch-menu",
      "open-palette",
    ]);
    const launch = tourSteps()[6];
    expect(launch.targets).toEqual([".v4-launch-wrap"]);
    expect(launch.include).toEqual(['[data-testid="titlebar-launch-menu"]']);
  });

  it("points steps 2 and 3 at the buttons that get there, not the surfaces", () => {
    const steps = tourSteps({ hasCompany: true });
    expect(steps[1].targets).toEqual(['[data-testid="rail-library"]']);
    expect(steps[2].title).toBe("Make your own bots");
    expect(steps[2].body).toMatch(/^Click \+ to start a new bot/);
    expect(steps[2].targets).toEqual(['[data-testid="chat-new-message"]']);
  });

  it("points the later steps at companies, meetings and the palette", () => {
    const steps = tourSteps({ hasCompany: true });
    expect(steps[3].title).toBe("Bring in your team");
    expect(steps[3].targets).toEqual([
      '[data-testid="team-invite"]',
      '[data-testid="rail-company"]',
      '[data-testid="chat-companies-section"]',
    ]);
    expect(steps[4].targets).toEqual(['[data-testid="rail-meetings"]']);
    expect(steps[7].title).toBe(`Find anything with ${formatShortcut("Mod+K")}`);
    expect(steps[7].targets).toEqual(['[data-testid="command-palette"]']);
  });

  it("uses computer wording and Ctrl shortcuts on Windows", () => {
    setHost("windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36");
    const steps = tourSteps({ hasCompanyVault: true });
    expect(steps[1].body).toContain("synced to this PC");
    expect(steps[7].title).toBe("Find anything with Ctrl+K");
  });

  it("keeps Mac wording and Command shortcuts on macOS", () => {
    setHost("macos", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15");
    const steps = tourSteps({ hasCompanyVault: true });
    expect(steps[1].body).toContain("synced to this Mac");
    expect(steps[7].title).toBe("Find anything with ⌘K");
  });

  it("centers the invite step with no target until a company exists", () => {
    const invite = tourSteps({ hasCompany: false })[3];
    expect(invite.targets).toEqual([]);
    expect(invite.body).toMatch(/once setup creates your company/);
  });
});

describe("tour state", () => {
  it("walks forward and finishes on the last Next", () => {
    let state = startTourState();
    expect(state).toEqual({ status: "active", index: 0 });
    for (let i = 0; i < 7; i += 1) state = nextTourState(state, 8);
    expect(state).toEqual({ status: "active", index: 7 });
    expect(nextTourState(state, 8)).toEqual({ status: "done" });
  });

  it("goes back but not before the first step", () => {
    expect(backTourState(startTourState())).toEqual({ status: "active", index: 0 });
    expect(backTourState({ status: "active", index: 2 })).toEqual({ status: "active", index: 1 });
  });

  it("skips from any step and ignores transitions when not active", () => {
    expect(skipTourState({ status: "active", index: 2 })).toEqual({ status: "skipped" });
    expect(skipTourState(TOUR_IDLE)).toBe(TOUR_IDLE);
    expect(nextTourState(TOUR_IDLE, 4)).toBe(TOUR_IDLE);
    expect(backTourState({ status: "done" })).toEqual({ status: "done" });
  });

  it("labels the card", () => {
    expect(tourProgressLabel(0, 8)).toBe("1 of 8");
    expect(tourPrimaryLabel(6, 8)).toBe("Next");
    expect(tourPrimaryLabel(7, 8)).toBe("Done");
    expect(tourCanGoBack(0)).toBe(false);
    expect(tourCanGoBack(1)).toBe(true);
  });
});

describe("shouldAutoStartTour", () => {
  const ready: TourAutoStartInput = {
    welcomeSetupOwed: true,
    tourSeen: false,
    shellReady: true,
    welcomeOnScreen: true,
    startedThisSession: false,
  };

  it("starts on a fresh install once the setup conversation is on screen", () => {
    expect(shouldAutoStartTour(ready)).toBe(true);
  });

  it("does not start for an existing user, an unknown answer, or a second time", () => {
    expect(shouldAutoStartTour({ ...ready, welcomeSetupOwed: false })).toBe(false);
    expect(shouldAutoStartTour({ ...ready, welcomeSetupOwed: null })).toBe(false);
    expect(shouldAutoStartTour({ ...ready, tourSeen: true })).toBe(false);
    expect(shouldAutoStartTour({ ...ready, startedThisSession: true })).toBe(false);
  });

  it("waits for the shell and the welcome conversation", () => {
    expect(shouldAutoStartTour({ ...ready, shellReady: false })).toBe(false);
    expect(shouldAutoStartTour({ ...ready, welcomeOnScreen: false })).toBe(false);
  });
});

describe("isTourHomeRow", () => {
  it("recognises #welcome and the setup bot DM", () => {
    expect(isTourHomeRow("ch:setup")).toBe(true);
    expect(isTourHomeRow("dm:agt_1", "agt_1")).toBe(true);
    expect(isTourHomeRow("dm:agt_1", null)).toBe(false);
    expect(isTourHomeRow("ch:general", "agt_1")).toBe(false);
    expect(isTourHomeRow(null)).toBe(false);
  });
});

describe("resolveTourTarget", () => {
  const dom: Record<string, { id: string; visible: boolean }> = {
    ".b": { id: "b", visible: false },
    ".c": { id: "c", visible: true },
  };
  const query = (sel: string) => dom[sel] ?? null;

  it("takes the first usable match in priority order", () => {
    expect(resolveTourTarget([".a", ".b", ".c"], query, (el) => el.visible)).toEqual({
      selector: ".c",
      element: dom[".c"],
    });
    expect(resolveTourTarget([".b"], query)).toEqual({ selector: ".b", element: dom[".b"] });
  });

  it("returns null when nothing matches and survives a bad selector", () => {
    expect(resolveTourTarget([".a"], query)).toBeNull();
    const throwing = (sel: string) => {
      if (sel === "::bad") throw new Error("SyntaxError");
      return query(sel);
    };
    expect(resolveTourTarget(["::bad", ".c"], throwing)?.selector).toBe(".c");
  });
});

describe("geometry", () => {
  const viewport = { width: 1200, height: 800 };

  it("unions rects and ignores empty ones", () => {
    expect(
      unionTourRects([
        { top: 10, left: 900, width: 80, height: 28 },
        { top: 44, left: 880, width: 220, height: 120 },
        { top: 0, left: 0, width: 0, height: 0 },
        null,
      ]),
    ).toEqual({ top: 10, left: 880, width: 220, height: 154 });
    expect(unionTourRects([null])).toBeNull();
  });

  it("pads the spotlight and clips it to the viewport", () => {
    expect(spotlightRect({ top: 100, left: 100, width: 50, height: 20 }, viewport)).toEqual({
      top: 92,
      left: 92,
      width: 66,
      height: 36,
    });
    expect(spotlightRect({ top: 2, left: 1180, width: 40, height: 20 }, viewport)).toEqual({
      top: 0,
      left: 1172,
      width: 28,
      height: 30,
    });
  });

  it("draws a scrim with a hole only when there is a cutout", () => {
    expect(scrimPath(viewport, null)).toBe("M0,0h1200v800h-1200z");
    const withHole = scrimPath(viewport, { top: 10, left: 20, width: 100, height: 40 }, 10);
    expect(withHole.startsWith("M0,0h1200v800h-1200z")).toBe(true);
    expect(withHole).toContain("M30,10");
  });

  it("places the card on the preferred side with an arrow at the target", () => {
    const card = { width: 320, height: 150 };
    const below = placeTourCard({ top: 10, left: 1100, width: 30, height: 28 }, card, viewport, "bottom");
    expect(below.placement).toBe("bottom");
    expect(below.top).toBe(50);
    expect(below.left).toBe(1200 - 320 - 12);
    expect(below.arrow).toBe(1115 - below.left);
  });

  it("flips to the opposite side when the preferred one has no room", () => {
    const card = { width: 320, height: 150 };
    const pos = placeTourCard({ top: 700, left: 400, width: 400, height: 60 }, card, viewport, "bottom");
    expect(pos.placement).toBe("top");
    expect(pos.top).toBe(700 - 12 - 150);
  });

  it("centers the card when no side fits or there is no target", () => {
    const card = { width: 320, height: 150 };
    expect(placeTourCard(null, card, viewport, "top")).toEqual({
      top: 325,
      left: 440,
      placement: "center",
      arrow: null,
    });
    const huge = placeTourCard({ top: 0, left: 0, width: 1200, height: 800 }, card, viewport, "left");
    expect(huge.placement).toBe("center");
  });
});

describe("local seen fallback", () => {
  it("round-trips through storage and tolerates a broken store", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(readTourSeenLocally(storage)).toBe(false);
    writeTourSeenLocally(storage);
    expect(store.get(TOUR_SEEN_STORAGE_KEY)).toBe("1");
    expect(readTourSeenLocally(storage)).toBe(true);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readTourSeenLocally(broken)).toBe(false);
    expect(() => writeTourSeenLocally(broken)).not.toThrow();
    expect(readTourSeenLocally(null)).toBe(false);
  });
});
