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
import {
  dropStackedThreadEntries,
  settleThreadSidebarClose,
} from "./thread-sidebar-close.js";

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

function shell(
  resolve: (
    destination: NavigationDestination,
  ) => NavigationResolveOutcome | Promise<NavigationResolveOutcome> = (
    destination,
  ) => ({ status: "ready", destination }),
): NavigationController {
  return createNavigationController({
    getScope: () => ({ accountId: "acct_ada", companyUid: "cmp_acme" }),
    resolve,
    apply: () => {},
  });
}

/** What the thread sidebar X does after navigation settles. */
function pressClose(
  navigation: NavigationController,
  closed: NavigationDestination,
  committed = true,
): void {
  const closingThread = navigation.history.current()?.destination ?? null;
  if (committed) {
    const result = navigation.navigate(closed, "replace");
    expect(result).toMatchObject({ status: "ready", committed: true });
  }
  settleThreadSidebarClose(
    navigation.history,
    closed,
    committed,
    closingThread,
  );
}

function replyRoots(navigation: NavigationController): (string | null)[] {
  return navigation.history.snapshot().entries.map((entry) => {
    const destination = entry.destination;
    if (destination.kind !== "channel" && destination.kind !== "dm") return null;
    return destination.replyRootEventId ?? null;
  });
}

function cursor(navigation: NavigationController): {
  index: number;
  replies: (string | null)[];
  canGoBack: boolean;
  canGoForward: boolean;
} {
  return {
    index: navigation.history.snapshot().index,
    replies: replyRoots(navigation),
    canGoBack: navigation.history.canGoBack(),
    canGoForward: navigation.history.canGoForward(),
  };
}

describe("thread sidebar close", () => {
  it("open thread A, open thread B, press X: one closed entry and the cursor is on it", () => {
    const navigation = shell();
    navigation.navigate(channel("chn_core", null));
    navigation.navigate(channel("chn_core", "evt_a"));
    navigation.navigate(channel("chn_core", "evt_b"));

    pressClose(navigation, channel("chn_core", null));

    expect(cursor(navigation)).toEqual({
      index: 0,
      replies: [null],
      canGoBack: false,
      canGoForward: false,
    });
    expect(navigation.history.current()?.destination).toMatchObject({
      kind: "channel",
      channelId: "chn_core",
      replyRootEventId: null,
    });
    navigation.back();
    expect(navigation.history.current()?.destination).toMatchObject({
      kind: "channel",
      channelId: "chn_core",
      replyRootEventId: null,
    });
    expect(cursor(navigation).index).toBe(0);
  });

  it("closes a single open thread", () => {
    const navigation = shell();
    navigation.navigate(channel("chn_core", null));
    navigation.navigate(channel("chn_core", "evt_a"));

    pressClose(navigation, channel("chn_core", null));

    expect(cursor(navigation)).toEqual({
      index: 0,
      replies: [null],
      canGoBack: false,
      canGoForward: false,
    });
  });

  it("reopening a thread after X starts from an empty thread stack", () => {
    const navigation = shell();
    navigation.navigate(channel("chn_core", null));
    navigation.navigate(channel("chn_core", "evt_a"));
    navigation.navigate(channel("chn_core", "evt_b"));
    pressClose(navigation, channel("chn_core", null));

    navigation.navigate(channel("chn_core", "evt_c"));
    pressClose(navigation, channel("chn_core", null));

    expect(cursor(navigation)).toEqual({
      index: 0,
      replies: [null],
      canGoBack: false,
      canGoForward: false,
    });
  });

  it("closes a DM thread the same way and leaves another conversation's thread alone", () => {
    const navigation = shell();
    navigation.navigate(channel("chn_other", "evt_other"));
    navigation.navigate(dm("prs_ada", null));
    navigation.navigate(dm("prs_ada", "evt_a"));
    navigation.navigate(dm("prs_ada", "evt_b"));

    pressClose(navigation, dm("prs_ada", null));

    expect(cursor(navigation)).toEqual({
      index: 1,
      replies: ["evt_other", null],
      canGoBack: true,
      canGoForward: false,
    });
    expect(navigation.history.current()?.destination).toMatchObject({
      kind: "dm",
      personUid: "prs_ada",
      replyRootEventId: null,
    });
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

  it("still closes the stack when replace navigation is not committed", () => {
    const navigation = shell();
    navigation.navigate(channel("chn_core", null));
    navigation.navigate(channel("chn_core", "evt_a"));
    navigation.navigate(channel("chn_core", "evt_b"));

    pressClose(navigation, channel("chn_core", null), false);

    expect(cursor(navigation)).toEqual({
      index: 0,
      replies: [null],
      canGoBack: false,
      canGoForward: false,
    });
    navigation.back();
    expect(replyRoots(navigation)).toEqual([null]);
  });

  it("does not clobber a newer destination when close is superseded", () => {
    const navigation = shell();
    navigation.navigate(channel("chn_core", null));
    navigation.navigate(channel("chn_core", "evt_a"));
    navigation.navigate(channel("chn_core", "evt_b"));
    navigation.navigate({ kind: "messages" });

    settleThreadSidebarClose(
      navigation.history,
      channel("chn_core", null),
      false,
      channel("chn_core", "evt_b"),
    );

    expect(cursor(navigation)).toEqual({
      index: 1,
      replies: [null, null],
      canGoBack: true,
      canGoForward: false,
    });
    expect(navigation.history.current()?.destination).toEqual({
      kind: "messages",
    });
    navigation.back();
    expect(navigation.history.current()?.destination).toMatchObject({
      kind: "channel",
      channelId: "chn_core",
      replyRootEventId: null,
    });
  });

  it("does not overwrite a thread opened in the same conversation while close is in flight", () => {
    const navigation = shell();
    navigation.navigate(channel("chn_core", null));
    navigation.navigate(channel("chn_core", "evt_a"));
    navigation.navigate(channel("chn_core", "evt_b"));
    const closingThread = channel("chn_core", "evt_b");
    navigation.navigate(channel("chn_core", "evt_c"));

    settleThreadSidebarClose(
      navigation.history,
      channel("chn_core", null),
      false,
      closingThread,
    );

    expect(cursor(navigation)).toEqual({
      index: 3,
      replies: [null, "evt_a", "evt_b", "evt_c"],
      canGoBack: true,
      canGoForward: false,
    });
    expect(navigation.history.current()?.destination).toMatchObject({
      kind: "channel",
      channelId: "chn_core",
      replyRootEventId: "evt_c",
    });
  });

  it("an async close that resolves cancelled still drops the open thread", async () => {
    let hold = false;
    let release: (value: NavigationResolveOutcome) => void = () => {};
    const navigation = shell((destination) => {
      if (!hold) return { status: "ready", destination };
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    navigation.navigate(channel("chn_core", null));
    navigation.navigate(channel("chn_core", "evt_a"));
    navigation.navigate(channel("chn_core", "evt_b"));
    hold = true;

    const pending = navigation.navigate(channel("chn_core", null), "replace");
    expect(pending).toBeInstanceOf(Promise);
    release({ status: "cancelled" });
    const result = await pending;
    expect(result.committed).toBe(false);
    settleThreadSidebarClose(
      navigation.history,
      channel("chn_core", null),
      false,
      channel("chn_core", "evt_b"),
    );

    expect(cursor(navigation)).toEqual({
      index: 0,
      replies: [null],
      canGoBack: false,
      canGoForward: false,
    });
  });
});
