// @vitest-environment happy-dom
/**
 * hq-accomplishment-badges US-005: the desktop loads real badges and shows
 * the adopted criteria.
 *
 * - BadgeSubject carries uid; render sites pass personUid where they have one.
 * - An async per-subject cache fills the badge and progress sources from
 *   GET /v1/badges/{uid}; any failure shows no badges and nothing to the person.
 * - Catalog: Signed Up removed; Founding Member a single plain tier, not
 *   Legendary; the adopted levels and matching card stories.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterResult, BadgesPayload } from "@hq/platform";
import ProfilePaneHost from "../shell/profile-panes/ProfilePaneHost.svelte";
import { BADGES, BADGE_BY_ID } from "./badge-catalog.js";
import { installBadgeLoader, resetBadgeLoader } from "./badge-loader.svelte.js";
import { setBadgeProgressSource, setBadgeSource } from "./badge-source.js";
import { badgeStory } from "./badge-story.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(resolve(here, path), "utf8");

const PAYLOAD: BadgesPayload = {
  enabled: true,
  subject: { uid: "prs_maya", kind: "person" },
  consent: "granted",
  badges: [
    { id: "founding", tier: 1, earnedAt: "2026-03-02T10:00:00.000Z" },
    { id: "bughunter", tier: 2, earnedAt: "2026-09-28T10:00:00.000Z" },
  ],
  progress: [{ id: "maker", current: 2, target: 5, unit: "skills" }],
};

const mounted: Array<ReturnType<typeof mount>> = [];
let uninstall: () => void = () => {};

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
  uninstall();
  uninstall = () => {};
  resetBadgeLoader();
  setBadgeSource(null);
  setBadgeProgressSource(null);
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await tick();
    await Promise.resolve();
  }
  flushSync();
}

function profile(props: Record<string, unknown>): HTMLElement {
  const host = document.createElement("div");
  host.className = "desktop-shell";
  document.body.appendChild(host);
  mounted.push(mount(ProfilePaneHost, { target: host, props: { company: "Indigo", ...props } as never }));
  return host;
}

describe("US-005: the desktop loads real badges", () => {
  it("shows a person's badges from hq-pro on their profile, read by their uid", async () => {
    const getBadges = vi.fn(async (_uid: string): Promise<AdapterResult<BadgesPayload>> => ({ ok: true, value: PAYLOAD }));
    uninstall = installBadgeLoader({ getBadges });
    const host = profile({ kind: "person", name: "Maya Chen", personUid: "prs_maya" });
    await settle();
    expect(getBadges).toHaveBeenCalledWith("prs_maya");
    const shown = [...host.querySelectorAll('[data-testid="profile-badge"]')].map((b) => b.getAttribute("data-badge-id"));
    expect(shown).toEqual(["bughunter", "founding"]);
  });

  it("shows no badges, and nothing else, when the route is missing", async () => {
    const getBadges = vi.fn(async (): Promise<AdapterResult<BadgesPayload>> => ({
      ok: false,
      reason: "error",
      code: "http-404",
      message: "Not Found",
    }));
    vi.spyOn(console, "debug").mockImplementation(() => {});
    uninstall = installBadgeLoader({ getBadges });
    const host = profile({ kind: "person", name: "Maya Chen", personUid: "prs_maya" });
    await settle();
    expect(getBadges).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="profile-badges"]')).toBeNull();
    expect(host.querySelector('[data-testid="profile-badges-all"]')).toBeNull();
    expect(host.textContent).not.toMatch(/404|Not Found/i);
  });

  it("never reads badges for a bot, or a person without a uid", async () => {
    const getBadges = vi.fn(async (): Promise<AdapterResult<BadgesPayload>> => ({ ok: true, value: PAYLOAD }));
    uninstall = installBadgeLoader({ getBadges });
    profile({ kind: "bot", name: "deacon", agentUid: "agt_deacon" });
    profile({ kind: "person", name: "Maya Chen" });
    await settle();
    expect(getBadges).not.toHaveBeenCalled();
  });

  it("passes the person uid at every render site that has one", () => {
    const desktop = read("../shell/DesktopApp.svelte");
    expect(desktop).toContain("installBadgeLoader(untrack(() => adapter.identity))");
    expect(desktop).toContain("uid: self?.uid ?? null");
    expect(desktop).toContain("personUid: openProfileMember.personUid,");
    expect(read("../company/TeamPage.svelte")).toContain('personUid: openMember.kind === "agent" ? null : openMember.id,');
    expect(read("../shell/profile-panes/UserProfilePane.svelte")).toContain("{personUid} size=\"large\"");
    expect(read("../chat/messaging/ChannelConversation.svelte")).toContain("personUid={isAgent(msg) ? null : msg.fromPersonUid}");
    expect(read("../chat/messaging/ReplyPanel.svelte")).toContain("personUid={isAgent(root) ? null : root.fromPersonUid}");
  });
});

describe("US-005: the adopted criteria", () => {
  it("drops Signed Up and makes Founding Member a single plain Gold tier", () => {
    expect(BADGE_BY_ID.signedup).toBeUndefined();
    expect(BADGES.some((b) => b.tier === "L")).toBe(false);
    expect(BADGE_BY_ID.founding.tier).toBe(3);
    expect(BADGE_BY_ID.founding.crit).toBe("Joined HQ before the public launch");
  });

  it("uses the adopted levels", () => {
    const levels = Object.fromEntries(BADGES.map((b) => [b.id, b.levels]));
    expect(levels).toMatchObject({
      bughunter: "3 · 10 · 25 reports",
      maker: "5 · 50 · 250 skills",
      liftoff: "5 · 50 · 250 deploys",
      poweruser: "100 · 500 · 2,500 runs",
      fleet: "1 · 5 · 15 agents",
      teambuilder: "3 · 10 · 25 invites",
      connector: "3 · 6 · 10 apps",
      onfire: "7 · 30 · 100 days",
    });
    expect(BADGE_BY_ID.maker.crit).toBe("Skills you wrote");
    expect(BADGE_BY_ID.fleet.crit).toBe("Agents you created");
  });

  it("tells each level's story with the same numbers", () => {
    const story = (id: string, tier: 1 | 2 | 3) => badgeStory({ def: BADGE_BY_ID[id], tier, earnedAt: "2026-10-06" })!.did;
    expect([1, 2, 3].map((t) => story("bughunter", t as 1 | 2 | 3))).toEqual([
      "You sent 3 reports that helped improve HQ.",
      "You sent 10 reports that helped improve HQ.",
      "You sent 25 reports that helped improve HQ.",
    ]);
    expect([1, 2, 3].map((t) => story("maker", t as 1 | 2 | 3))).toEqual([
      "You wrote 5 skills.",
      "You wrote 50 skills.",
      "You wrote 250 skills.",
    ]);
    expect(story("liftoff", 3)).toBe("You put 250 deploys live.");
    expect(story("poweruser", 3)).toBe("You ran skills 2,500 times.");
    expect(story("fleet", 3)).toBe("You created 15 agents.");
    expect(story("teambuilder", 3)).toBe("25 teammates joined HQ from your invites.");
    expect(story("connector", 3)).toBe("You connected 10 apps to HQ.");
  });
});
