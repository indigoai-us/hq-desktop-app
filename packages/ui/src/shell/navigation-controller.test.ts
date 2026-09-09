import { describe, expect, it } from "vitest";

import {
  destinationFromEmbeddedTarget,
  type NavigationDestination,
  type NavigationEntry,
  type NavigationScrollState,
} from "./navigation-history.js";
import {
  createNavigationController,
  type AppliedNavigation,
  type NavigationController,
  type NavigationResolveOutcome,
} from "./navigation-controller.js";

function scope(accountId = "acct_ada") {
  return { accountId, companyUid: "cmp_acme" };
}

function dest(
  kind: "channel" | "settings" | "extra" | "messages",
  id = "a",
): NavigationDestination {
  if (kind === "channel") return { kind: "channel", channelId: `chn_${id}` };
  if (kind === "settings") return { kind: "settings", section: "profile" };
  if (kind === "extra") return { kind: "extra", page: "sessions", param: id };
  return { kind: "messages" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function controllerWith(
  resolve: (
    destination: NavigationDestination,
  ) => NavigationResolveOutcome | Promise<NavigationResolveOutcome>,
  options?: {
    accountId?: () => string;
    capture?: () => NavigationEntry | null;
    captureScroll?: () => NavigationScrollState | null;
  },
): {
  controller: NavigationController;
  applied: AppliedNavigation[];
  rejected: string[];
} {
  const applied: AppliedNavigation[] = [];
  const rejected: string[] = [];
  let accountId = options?.accountId ?? (() => "acct_ada");
  const controller = createNavigationController({
    getScope: () => scope(accountId()),
    captureCurrent: options?.capture,
    captureScroll: options?.captureScroll,
    resolve: (destination) => resolve(destination),
    apply: (next) => {
      applied.push(next);
    },
    onRejected: (reason) => {
      rejected.push(reason);
    },
  });
  return { controller, applied, rejected };
}

describe("navigation controller commit boundary", () => {
  it("navigates through resolve then commit and seeds the prior screen", () => {
    const { controller, applied } = controllerWith(() => ({
      status: "ready",
      destination: dest("settings"),
    }), {
      capture: () => ({
        destination: dest("messages"),
        accountId: "acct_ada",
        companyUid: "cmp_acme",
      }),
    });
    const result = controller.navigate(dest("settings"));
    expect("then" in result).toBe(false);
    expect(result).toMatchObject({ status: "ready", committed: true });
    expect(
      controller.history.snapshot().entries.map((entry) => entry.destination.kind),
    ).toEqual(["messages", "settings"]);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.availability).toBe("available");
    expect(controller.lastCommitted()?.destination.kind).toBe("settings");
  });

  it("lets latest successful commit win when A→B→C races", async () => {
    const a = deferred<NavigationResolveOutcome>();
    const b = deferred<NavigationResolveOutcome>();
    const resolvers = new Map<string, Promise<NavigationResolveOutcome>>([
      ["chn_a", a.promise],
      ["chn_b", b.promise],
    ]);
    const { controller, applied } = controllerWith((destination) => {
      if (destination.kind === "channel") {
        const pending = resolvers.get(destination.channelId);
        if (pending) return pending;
      }
      return { status: "ready", destination };
    });

    const aNav = controller.navigate(dest("channel", "a"));
    const bNav = controller.navigate(dest("channel", "b"));
    const cNav = controller.navigate(dest("channel", "c"));
    expect(await cNav).toMatchObject({
      status: "ready",
      committed: true,
    });
    expect(controller.lastCommitted()?.destination).toEqual(
      expect.objectContaining({ channelId: "chn_c" }),
    );

    a.resolve({ status: "ready", destination: dest("channel", "a") });
    b.resolve({ status: "ready", destination: dest("channel", "b") });
    expect(await aNav).toMatchObject({ status: "cancelled", committed: false });
    expect(await bNav).toMatchObject({ status: "cancelled", committed: false });
    expect(applied).toHaveLength(1);
    expect(applied[0]?.entry.destination).toEqual(
      expect.objectContaining({ channelId: "chn_c" }),
    );
  });

  it("ignores a cancelled in-flight resolve and leaves the cursor intact", async () => {
    const delayed = deferred<NavigationResolveOutcome>();
    const { controller, applied } = controllerWith((destination) => {
      if (destination.kind === "channel" && destination.channelId === "chn_slow") {
        return delayed.promise;
      }
      return { status: "ready", destination };
    });
    controller.navigate(dest("messages"));
    const slow = controller.navigate(dest("channel", "slow"));
    controller.navigate(dest("settings"));
    delayed.resolve({ status: "ready", destination: dest("channel", "slow") });
    expect(await slow).toMatchObject({ status: "cancelled", committed: false });
    expect(controller.lastCommitted()?.destination.kind).toBe("settings");
    expect(applied.at(-1)?.entry.destination.kind).toBe("settings");
  });

  it("does not move the cursor on a transient miss, then commits unavailable when confirmed gone", async () => {
    let lookup: NavigationResolveOutcome = {
      status: "transient-failure",
      error: "timeout",
    };
    const { controller, applied } = controllerWith((destination) => {
      if (destination.kind === "extra") return lookup;
      return { status: "ready", destination };
    });
    controller.navigate(dest("channel", "home"));
    const before = controller.lastCommitted();
    const transient = controller.navigate(dest("extra", "ses_missing"));
    expect(transient).toMatchObject({
      status: "transient-failure",
      committed: false,
    });
    expect(controller.lastCommitted()).toEqual(before);
    expect(applied).toHaveLength(1);
    expect(controller.history.canGoBack()).toBe(false);

    lookup = {
      status: "unavailable",
      destination: dest("extra", "ses_missing"),
      reason: "Session was deleted",
    };
    const gone = controller.navigate(dest("extra", "ses_missing"));
    expect(gone).toMatchObject({ status: "unavailable", committed: true });
    expect(applied.at(-1)?.availability).toBe("unavailable");
    expect(applied.at(-1)?.reason).toBe("Session was deleted");
    expect(controller.history.canGoBack()).toBe(true);
    expect(controller.lastCommitted()?.destination).toEqual(
      expect.objectContaining({ page: "sessions", param: "ses_missing" }),
    );

    const back = controller.back();
    expect(back).toMatchObject({ status: "ready", committed: true });
    expect(controller.lastCommitted()?.destination).toEqual(
      expect.objectContaining({ channelId: "chn_home" }),
    );
    expect(controller.lastAvailability()).toBe("available");
  });

  it("does not apply a stale resolve after the account changes", async () => {
    let accountId = "acct_ada";
    const delayed = deferred<NavigationResolveOutcome>();
    const { controller, applied } = controllerWith(
      (destination) => {
        if (destination.kind === "channel") return delayed.promise;
        return { status: "ready", destination };
      },
      { accountId: () => accountId },
    );
    const inflight = controller.navigate(dest("channel", "old"));
    accountId = "acct_bea";
    controller.noteAccount("acct_bea");
    delayed.resolve({ status: "ready", destination: dest("channel", "old") });
    expect(await inflight).toMatchObject({
      status: "cancelled",
      committed: false,
    });
    expect(applied).toHaveLength(0);
    expect(controller.history.current()).toBeNull();
    expect(controller.lastCommitted()).toBeNull();
  });

  it("truncates the forward branch when navigating after Back", () => {
    const { controller } = controllerWith((destination) => ({
      status: "ready",
      destination,
    }));
    controller.navigate(dest("channel", "a"));
    controller.navigate(dest("channel", "b"));
    controller.back();
    expect(controller.history.canGoForward()).toBe(true);
    controller.navigate(dest("channel", "c"));
    expect(controller.history.canGoForward()).toBe(false);
    expect(
      controller.history.snapshot().entries.map((entry) =>
        entry.destination.kind === "channel"
          ? entry.destination.channelId
          : entry.destination.kind,
      ),
    ).toEqual(["chn_a", "chn_c"]);
  });

  it("rejects an unknown extra page without consuming history", () => {
    const { controller, applied, rejected } = controllerWith((destination) => {
      if (destination.kind === "extra" && destination.page === "nope") {
        return { status: "rejected", reason: "Unknown destination: nope" };
      }
      return { status: "ready", destination };
    });
    controller.navigate(dest("channel", "home"));
    const result = controller.navigate({ kind: "extra", page: "nope" });
    expect(result).toMatchObject({ status: "rejected", committed: false });
    expect(rejected).toEqual(["Unknown destination: nope"]);
    expect(applied).toHaveLength(1);
    expect(controller.lastCommitted()?.destination).toEqual(
      expect.objectContaining({ channelId: "chn_home" }),
    );
  });

  it("records scroll on leave and does not let later captures rewrite a parked entry", () => {
    let liveOffset = 420;
    const { controller } = controllerWith(
      (destination) => ({ status: "ready", destination }),
      {
        captureScroll: () => ({
          kind: "message",
          id: "evt_mid",
          offset: liveOffset,
        }),
      },
    );
    controller.navigate(dest("channel", "long"));
    controller.navigate(dest("extra", "ses_live"));
    expect(controller.history.snapshot().entries[0]?.scroll).toEqual({
      kind: "message",
      id: "evt_mid",
      offset: 420,
    });
    liveOffset = 9999;
    expect(controller.history.snapshot().entries[0]?.scroll?.offset).toBe(420);
    controller.back();
    expect(controller.lastCommitted()?.scroll).toEqual({
      kind: "message",
      id: "evt_mid",
      offset: 420,
    });
  });

  it("clears the stack on account change so prior destinations are not restorable", () => {
    let accountId = "acct_ada";
    const { controller } = controllerWith(
      (destination) => ({ status: "ready", destination }),
      { accountId: () => accountId },
    );
    controller.noteAccount("acct_ada");
    controller.navigate(dest("channel", "secret"));
    controller.navigate(dest("extra", "ses_secret"));
    accountId = "acct_bea";
    controller.noteAccount("acct_bea");
    expect(controller.history.snapshot().entries).toEqual([]);
    expect(controller.lastCommitted()).toBeNull();
    expect(controller.history.canGoBack()).toBe(false);
    controller.navigate(dest("messages"));
    expect(controller.history.snapshot().entries).toHaveLength(1);
    expect(controller.lastCommitted()?.accountId).toBe("acct_bea");
    expect(controller.lastCommitted()?.destination).toEqual({ kind: "messages" });
  });

  it("drops extra destinations whose company left the membership", () => {
    const { controller } = controllerWith((destination) => ({
      status: "ready",
      destination,
    }));
    controller.navigate(dest("messages"));
    controller.navigate({
      kind: "extra",
      page: "sessions",
      param: "new?company=cmp_gone&draft=1",
    });
    controller.navigate(dest("channel", "home"));
    expect(controller.history.snapshot().entries).toHaveLength(3);
    controller.filterAccessible(new Set(["cmp_acme"]));
    expect(
      controller.history.snapshot().entries.map((entry) => entry.destination.kind),
    ).toEqual(["messages", "channel"]);
  });
});

describe("native/host destination conversion", () => {
  it("maps host targets onto the shared destination union", () => {
    expect(destinationFromEmbeddedTarget({ kind: "home" })).toEqual({
      kind: "messages",
    });
    expect(destinationFromEmbeddedTarget({ kind: "inbox" })).toEqual({
      kind: "notifications",
    });
    expect(
      destinationFromEmbeddedTarget({
        kind: "extra",
        page: "sessions",
        param: "ses_1",
      }),
    ).toEqual({ kind: "extra", page: "sessions", param: "ses_1" });
    expect(
      destinationFromEmbeddedTarget({
        kind: "extra",
        page: "sessions",
        param: "new?company=indigo&draft=1",
      }),
    ).toEqual({
      kind: "extra",
      page: "sessions",
      param: "new?company=indigo&draft=1",
      companyUid: "indigo",
    });
    expect(
      destinationFromEmbeddedTarget({
        kind: "extra",
        page: "sessions",
        param: "ses_1",
        companyUid: "cmp_acme",
      }),
    ).toEqual({
      kind: "extra",
      page: "sessions",
      param: "ses_1",
      companyUid: "cmp_acme",
    });
    expect(
      destinationFromEmbeddedTarget({
        kind: "unsupported",
        route: "company:indigo:activity",
        reason: "Unsupported embedded destination",
      }),
    ).toBeNull();
  });

});
