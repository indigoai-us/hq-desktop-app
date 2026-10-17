import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  createNavigationController,
  type NavigationController,
  type NavigationResolveOutcome,
} from "./navigation-controller.js";
import {
  createNavigationHistory,
  type NavigationDestination,
} from "./navigation-history.js";
import { dropStackedThreadEntries } from "./thread-sidebar-close.js";

function channel(
  channelId: string,
  replyRootEventId: string | null,
): NavigationDestination {
  return {
    kind: "channel",
    channelId,
    replyRootEventId,
    tab: "chat",
  };
}

function dm(
  personUid: string,
  replyRootEventId: string | null,
): NavigationDestination {
  return { kind: "dm", personUid, replyRootEventId, agentSurface: "chat" };
}

function shell(): NavigationController {
  return createNavigationController({
    getScope: () => ({ accountId: "acct_ada", companyUid: "cmp_acme" }),
    resolve: (destination): NavigationResolveOutcome => ({
      status: "ready",
      destination,
    }),
    apply: () => {},
  });
}

/** What the thread sidebar X does to history: replace, then drop the stack. */
function pressClose(
  navigation: NavigationController,
  closed: NavigationDestination,
): void {
  const result = navigation.navigate(closed, "replace");
  expect(result).toMatchObject({ status: "ready", committed: true });
  dropStackedThreadEntries(navigation.history, closed);
}

function replyRoots(navigation: NavigationController): (string | null)[] {
  return navigation.history.snapshot().entries.map((entry) => {
    const destination = entry.destination;
    if (destination.kind !== "channel" && destination.kind !== "dm") return null;
    return destination.replyRootEventId ?? null;
  });
}

describe("thread sidebar close", () => {
  it("open thread A, open thread B, press X: sidebar is closed and A is not shown", () => {
    const navigation = shell();
    navigation.navigate(channel("chn_core", null));
    navigation.navigate(channel("chn_core", "evt_a"));
    navigation.navigate(channel("chn_core", "evt_b"));

    pressClose(navigation, channel("chn_core", null));

    expect(navigation.history.current()?.destination).toMatchObject({
      kind: "channel",
      channelId: "chn_core",
      replyRootEventId: null,
    });
    expect(replyRoots(navigation)).not.toContain("evt_a");
    expect(replyRoots(navigation)).not.toContain("evt_b");

    navigation.back();
    const previous = navigation.history.current()?.destination;
    if (previous && (previous.kind === "channel" || previous.kind === "dm")) {
      expect(previous.replyRootEventId ?? null).toBeNull();
    }
  });

  it("closes a single open thread", () => {
    const navigation = shell();
    navigation.navigate(channel("chn_core", null));
    navigation.navigate(channel("chn_core", "evt_a"));

    pressClose(navigation, channel("chn_core", null));

    expect(navigation.history.current()?.destination).toMatchObject({
      replyRootEventId: null,
    });
    expect(replyRoots(navigation)).not.toContain("evt_a");
  });

  it("reopening a thread after X starts from an empty thread stack", () => {
    const navigation = shell();
    navigation.navigate(channel("chn_core", null));
    navigation.navigate(channel("chn_core", "evt_a"));
    navigation.navigate(channel("chn_core", "evt_b"));
    pressClose(navigation, channel("chn_core", null));

    navigation.navigate(channel("chn_core", "evt_c"));
    pressClose(navigation, channel("chn_core", null));

    expect(replyRoots(navigation).filter(Boolean)).toEqual([]);
    expect(navigation.history.current()?.destination).toMatchObject({
      kind: "channel",
      channelId: "chn_core",
      replyRootEventId: null,
    });
  });

  it("closes a DM thread the same way and leaves another conversation's thread alone", () => {
    const navigation = shell();
    navigation.navigate(channel("chn_other", "evt_other"));
    navigation.navigate(dm("prs_ada", null));
    navigation.navigate(dm("prs_ada", "evt_a"));
    navigation.navigate(dm("prs_ada", "evt_b"));

    pressClose(navigation, dm("prs_ada", null));

    expect(navigation.history.current()?.destination).toMatchObject({
      kind: "dm",
      personUid: "prs_ada",
      replyRootEventId: null,
    });
    expect(replyRoots(navigation)).not.toContain("evt_a");
    expect(replyRoots(navigation)).not.toContain("evt_b");
    expect(replyRoots(navigation)).toContain("evt_other");
  });

  it("does not drop entries when the closed destination is still a thread", () => {
    const history = createNavigationHistory();
    history.push({
      destination: channel("chn_core", "evt_a"),
      accountId: "acct_ada",
      companyUid: "cmp_acme",
    });
    dropStackedThreadEntries(history, channel("chn_core", "evt_b"));
    expect(history.snapshot().entries).toHaveLength(1);
  });

  it("DesktopApp close uses replace and drops the stack instead of going back", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "DesktopApp.svelte"),
      "utf8",
    );
    const start = source.indexOf("function closeReply(): void");
    const end = source.indexOf("function queueReplyForRow", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    expect(body).toContain("dropStackedThreadEntries");
    expect(body).toContain('"replace"');
    expect(body).not.toContain("leaveCurrentDestination");
    expect(body).not.toContain("goBack");
  });
});
