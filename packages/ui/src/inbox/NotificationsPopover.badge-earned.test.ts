// @vitest-environment happy-dom
/**
 * Owner, 2026-10-16: "can we add a holographic notification for
 * notifications?" A "badge_earned" row from hq-pro shows in the bell list
 * with the "You earned" notice's holographic look and the badge's mark, and
 * "Reveal card" opens the card. An unknown badge falls back to a plain row.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import type { NotificationsApi } from "../chat/chat-api.js";
import NotificationsPopover from "./NotificationsPopover.svelte";
import { clearHiddenNotifications, publishNotificationsCache } from "./notifications-cache.svelte.js";
import { mapNotificationRow, type NotificationItem } from "./notifications-model.js";
import { pinUnrevealedBadges } from "./notifications-panel.js";
import { badgeFromTargetRef } from "../badges/badge-notification.js";

const api: NotificationsApi = {
  fetchNotifications: async () => ({ notifications: [], unreadCount: 0, nextCursor: null }),
  ackNotification: async () => {},
  readAllNotifications: async () => {},
  runNotificationAction: async () => ({}),
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  for (const el of document.querySelectorAll("[data-testid='badge-card-modal'], .bcm-backdrop")) el.remove();
  clearHiddenNotifications();
});

function row(
  targetRef: string,
  id = "n-badge",
  createdAt = "2026-10-16T04:00:00.000Z",
  status: "unread" | "read" = "unread",
) {
  const item = mapNotificationRow({
    id,
    type: "badge_earned",
    status,
    createdAt,
    title: "Badge earned",
    body: "maker tier 2",
    targetRef,
  });
  if (!item) throw new Error("row did not parse");
  return item;
}

function mention(id: string, createdAt: string): NotificationItem {
  const item = mapNotificationRow({
    id,
    type: "mention",
    status: "unread",
    createdAt,
    title: "Mentioned you",
    body: "hello",
    actorName: "Shawon",
  });
  if (!item) throw new Error("mention did not parse");
  return item;
}

async function open(items: NotificationItem[], withApi: NotificationsApi = api): Promise<void> {
  publishNotificationsCache({ items, ready: true, loading: false });
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(NotificationsPopover, { target: host, props: { api: withApi } });
  await tick();
}

describe("badge earned notifications", () => {
  it("parse with no actor", () => {
    const item = row("badge:maker:2");
    expect(item.displayKind).toBe("badge_earned");
    expect(item.actorName).toBe("");
    expect(item.verbText).toBe("Badge earned");
  });

  it("resolve the badge, holding a single-level badge at its own tier", () => {
    expect(badgeFromTargetRef("badge:maker:2")?.tier).toBe(2);
    expect(badgeFromTargetRef("badge:og:1")?.tier).toBe("L");
    expect(badgeFromTargetRef("badge:nope:1")).toBeNull();
    expect(badgeFromTargetRef("maker:2")).toBeNull();
  });

  it("show a holographic row with the badge's mark, words from the app catalog, and Reveal card", async () => {
    await open([row("badge:maker:2")]);
    const el = host.querySelector<HTMLElement>("[data-testid='notification-row'][data-kind='badge_earned']");
    expect(el).toBeTruthy();
    expect(el!.classList.contains("holo")).toBe(true);
    expect(el!.getAttribute("data-badge-id")).toBe("maker");
    expect(el!.querySelector("[data-testid='badge-notice-mark'][data-badge-id='maker']")).toBeTruthy();
    expect(el!.textContent).toContain("You earned Maker");
    expect(el!.textContent).toContain("Silver · Skills you wrote.");

    el!.querySelector<HTMLButtonElement>("[data-testid='notification-reveal-badge']")!.click();
    await tick();
    expect(document.body.querySelector("[role='dialog']")).toBeTruthy();
  });

  it("say 'awarded' for an honor", async () => {
    await open([row("badge:og:1")]);
    expect(host.textContent).toContain("You were awarded OG");
  });

  it("fall back to a plain row for a badge the app does not know", async () => {
    await open([row("badge:unknown:1")]);
    const el = host.querySelector<HTMLElement>("[data-testid='notification-row']");
    expect(el).toBeTruthy();
    expect(el!.classList.contains("holo")).toBe(false);
    expect(el!.textContent).toContain("Badge earned");
  });

  // Owner, 2026-10-16: an unrevealed badge row stays pinned at the top of the
  // bell list; revealing the card marks it read and it falls back into time order.
  const order = () =>
    [...host.querySelectorAll<HTMLElement>("[data-testid='notification-row']")].map((el) =>
      el.getAttribute("data-badge-id") ?? el.textContent?.trim().slice(0, 12),
    );

  it("pin unread badge rows above newer notifications, newest badge first", () => {
    const older = row("badge:maker:2", "b-old", "2026-10-16T01:00:00.000Z");
    const newer = row("badge:og:1", "b-new", "2026-10-16T02:00:00.000Z");
    const read = row("badge:maker:1", "b-read", "2026-10-16T05:00:00.000Z", "read");
    const msg = mention("m-1", "2026-10-16T04:00:00.000Z");
    const ids = pinUnrevealedBadges([read, msg, newer, older]).map((i) => i.id);
    expect(ids).toEqual(["b-new", "b-old", "b-read", "m-1"]);
  });

  it("keep an unrevealed badge row at the top, then drop it into time order once revealed", async () => {
    const ack = vi.fn(async () => {});
    await open(
      [row("badge:maker:2", "b-1", "2026-10-16T01:00:00.000Z"), mention("m-1", "2026-10-16T04:00:00.000Z")],
      { ...api, ackNotification: ack },
    );
    expect(order()[0]).toBe("maker");

    host.querySelector<HTMLButtonElement>("[data-testid='notification-reveal-badge']")!.click();
    await tick();
    await tick();
    expect(ack).toHaveBeenCalledWith("b-1");
    expect(order()[order().length - 1]).toBe("maker");
    expect(
      host.querySelector("[data-kind='badge_earned']")!.classList.contains("unread"),
    ).toBe(false);
  });

  it("put the row back on top when marking it read fails", async () => {
    const ack = vi.fn(async () => {
      throw new Error("offline");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await open(
      [row("badge:maker:2", "b-1", "2026-10-16T01:00:00.000Z"), mention("m-1", "2026-10-16T04:00:00.000Z")],
      { ...api, ackNotification: ack },
    );
    host.querySelector<HTMLButtonElement>("[data-testid='notification-reveal-badge']")!.click();
    await tick();
    await tick();
    await tick();
    expect(order()[0]).toBe("maker");
    err.mockRestore();
  });
});
