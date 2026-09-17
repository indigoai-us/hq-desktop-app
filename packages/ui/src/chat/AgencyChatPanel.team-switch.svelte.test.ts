// @vitest-environment happy-dom

/**
 * Regression: switching teams must land at the bottom of the new conversation.
 *
 * `stickToBottom` was a plain `let` read by an untracked scroll effect, and
 * effects flush in declaration order — so on a team switch the scroll effect ran
 * first against the stale `false` and skipped the scroll, and when the new
 * team's message count matched the old one it did not run at all. The operator
 * landed mid-history in a conversation they had never scrolled.
 *
 * The genuine improvement — not yanking a reader who scrolled up WITHIN the
 * same team — must survive.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import AgencyChatPanel from "./AgencyChatPanel.svelte";
import {
  agencyStore,
  configureAgencyApi,
  selectAgencyTeam,
  startAgencyStore,
  stopAgencyStore,
  type AgencyApi,
} from "./agency-store.svelte";
import type { AgencyMessage, AgencyTeam } from "./agency";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const TEAMS: AgencyTeam[] = [
  { company: "acme", team: "alpha" } as AgencyTeam,
  { company: "acme", team: "beta" } as AgencyTeam,
];

/**
 * Both teams currently show the same seeded manager greeting. The store
 * fingerprints `messages` per field and only reassigns when the serialized
 * value changes, so switching teams here does not mint a new `messages` array
 * at all — a scroll effect keyed only on `messages` never re-runs.
 */
let extraForAlpha = 0;

function chatFor(team: string): AgencyMessage[] {
  const count = team === "alpha" ? 3 + extraForAlpha : 3;
  return Array.from({ length: count }, (_, i) => i + 1).map(
    (n) =>
      ({
        ts: `2026-08-28T00:0${n}:00.000Z`,
        inbox: "manager-inbox",
        from: "manager",
        kind: "fyi",
        text: `standing brief ${n}`,
      }) as AgencyMessage,
  );
}

/** Let the store's async refresh settle, then let Svelte flush its effects. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  await tick();
}

const SCROLL_HEIGHT = 1000;
const CLIENT_HEIGHT = 300;

/** happy-dom does no layout: give the scroller real geometry. */
function stubGeometry(el: HTMLElement): void {
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => SCROLL_HEIGHT,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => CLIENT_HEIGHT,
  });
}

beforeEach(() => {
  stopAgencyStore();
  extraForAlpha = 0;
  const api: AgencyApi = {
    listTeams: async () => TEAMS,
    listQuestions: async () => [],
    listChat: async (_company, team) => chatFor(team),
    answerQuestion: async () => "delivered",
    sendMessage: async () => "delivered",
  };
  configureAgencyApi(api);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  stopAgencyStore();
  configureAgencyApi(null);
});

async function mountPanel(): Promise<HTMLDivElement> {
  startAgencyStore();
  await vi.waitFor(() => expect(agencyStore.messages.length).toBe(3));
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(AgencyChatPanel, { target: host, props: {} });
  await tick();
  // The store is a module singleton whose `selected` survives stopAgencyStore();
  // pin every test to alpha so "switch" vs "same team" is unambiguous.
  selectAgencyTeam("acme", "alpha");
  await settle();
  return host;
}

function scroller(root: HTMLElement): HTMLDivElement {
  const el = root.querySelector(".thread") as HTMLDivElement;
  expect(el).toBeTruthy();
  return el;
}

describe("AgencyChatPanel scroll on team switch", () => {
  it("lands at the bottom of the new team even when the count is unchanged", async () => {
    const root = await mountPanel();
    const el = scroller(root);
    stubGeometry(el);

    // Operator scrolls up to read history in the CURRENT team.
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
    await tick();

    selectAgencyTeam("acme", "beta");
    await settle();
    expect(agencyStore.selected?.team).toBe("beta");

    expect(el.scrollTop).toBe(SCROLL_HEIGHT);
  });

  it("does not yank a reader who scrolled up within the same team", async () => {
    const root = await mountPanel();
    const el = scroller(root);
    stubGeometry(el);

    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
    await tick();

    // A poll delivers a new message in the SAME team.
    extraForAlpha = 1;
    selectAgencyTeam("acme", "alpha");
    await vi.waitFor(() => expect(agencyStore.messages.length).toBe(4));
    await settle();

    expect(el.scrollTop).toBe(0);
  });
});
