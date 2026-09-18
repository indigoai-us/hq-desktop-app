import { describe, expect, it } from "vitest";
import {
  AGENT_JOIN_BUNDLE_WINDOW_MS,
  bundleAgentJoinNotifications,
  companyFromJoinNotice,
  isAgentJoinNotification,
} from "./agent-join-bundles";
import {
  buildNotificationsView,
  emptyFeedState,
  type NotificationItem,
} from "./notifications-model";

const BASE_MS = Date.parse("2026-09-18T15:00:00.000Z");

function joinRow(
  index: number,
  overrides: Partial<NotificationItem> = {},
): NotificationItem {
  const name = `v3e2e-${index}`;
  return {
    id: `n${index}`,
    serverType: "dm",
    displayKind: "dm_received",
    typeIcon: "dm",
    actorName: name,
    actorInitials: "V3",
    verbText: `${name} sent you a message`,
    contextLine: `🤖 ${name} (an agent) just joined Indigo.`,
    status: "unread",
    createdAt: new Date(BASE_MS - index * 1000).toISOString(),
    createdAtMs: BASE_MS - index * 1000,
    timestampLabel: "3:00 PM",
    actionKind: null,
    actionRef: null,
    actionButtons: [],
    targetRef: null,
    actorPersonUid: `agt_${index}`,
    sourceEventId: null,
    actionUsed: false,
    ...overrides,
  };
}

function humanDm(): NotificationItem {
  return joinRow(99, {
    id: "human",
    actorName: "Corey",
    actorPersonUid: "usr_corey",
    contextLine: "can you look at the rail?",
  });
}

describe("agent join notice detection", () => {
  it("recognises the server announcement", () => {
    expect(isAgentJoinNotification(joinRow(1))).toBe(true);
  });

  it("leaves a human message alone", () => {
    expect(isAgentJoinNotification(humanDm())).toBe(false);
  });

  it("refuses a human quoting the copy", () => {
    expect(
      isAgentJoinNotification(
        joinRow(1, { actorPersonUid: "usr_corey", actorName: "Corey" }),
      ),
    ).toBe(false);
  });

  it("reads the company out of the notice", () => {
    expect(companyFromJoinNotice("🤖 Izzy (an agent) just joined Indigo.")).toBe(
      "Indigo",
    );
  });
});

describe("bundleAgentJoinNotifications", () => {
  it("gives a non-owner none of them, and keeps the human DM", () => {
    const items = [joinRow(1), joinRow(2), joinRow(3), humanDm()];
    const result = bundleAgentJoinNotifications(items);
    expect(result.items.map((item) => item.id)).toEqual(["human"]);
    expect(result.collapsedUnread).toBe(3);
  });

  it("bundles per company per 10 minutes for the fleet owner", () => {
    const items = [joinRow(1), joinRow(2), joinRow(3), humanDm()];
    const result = bundleAgentJoinNotifications(items, {
      viewerOwnsAgents: true,
    });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.verbText).toBe("3 agents joined Indigo");
    expect(result.items[1]?.id).toBe("human");
    expect(result.collapsedUnread).toBe(2);
  });

  it("does not bundle across the window boundary", () => {
    const far = joinRow(4, {
      id: "far",
      createdAtMs: BASE_MS - AGENT_JOIN_BUNDLE_WINDOW_MS - 60_000,
    });
    const result = bundleAgentJoinNotifications([joinRow(1), joinRow(2), far], {
      viewerOwnsAgents: true,
    });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.verbText).toBe("2 agents joined Indigo");
    expect(result.items[1]?.id).toBe("far");
  });

  it("never reads '1 agents joined'", () => {
    const result = bundleAgentJoinNotifications([joinRow(1)], {
      viewerOwnsAgents: true,
    });
    expect(result.items[0]?.verbText).toBe("v3e2e-1 sent you a message");
  });

  it("keeps separate companies apart", () => {
    const other = joinRow(5, {
      id: "other",
      contextLine: "🤖 v3e2e-5 (an agent) just joined Amass.",
    });
    const result = bundleAgentJoinNotifications(
      [joinRow(1), joinRow(2), other, joinRow(6, { id: "other2", contextLine: "🤖 v3e2e-6 (an agent) just joined Amass." })],
      { viewerOwnsAgents: true },
    );
    const verbs = result.items.map((item) => item.verbText);
    expect(verbs).toContain("2 agents joined Indigo");
    expect(verbs).toContain("2 agents joined Amass");
  });
});

describe("buildNotificationsView", () => {
  it("drops join rows and their unread for a non-owner", () => {
    const state = {
      ...emptyFeedState(),
      items: [joinRow(1), joinRow(2), humanDm()],
      unreadCount: 3,
    };
    const view = buildNotificationsView(state, BASE_MS);
    expect(view.visibleCount).toBe(1);
    expect(view.badgeText).toBe("1");
  });

  it("bundles them for the fleet owner", () => {
    const state = {
      ...emptyFeedState(),
      items: [joinRow(1), joinRow(2), humanDm()],
      unreadCount: 3,
    };
    const view = buildNotificationsView(state, BASE_MS, undefined, true);
    expect(view.visibleCount).toBe(2);
    expect(view.badgeText).toBe("2");
  });
});
