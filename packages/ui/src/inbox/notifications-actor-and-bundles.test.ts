import { describe, expect, it } from "vitest";
import {
  buildNotificationsView,
  emptyFeedState,
  formatChannelLabel,
  mapNotificationRow,
  stripChannelIdSuffix,
  type NotificationItem,
} from "./notifications-model";
import {
  bundleFileNotifications,
  commonFolderPrefix,
  splitFileContext,
} from "./file-bundles";

const NOW = Date.parse("2026-09-17T15:00:00.000Z");

function channelWire(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "local:channel:chn_1:evt_1",
    type: "channel_message",
    status: "unread",
    createdAt: "2026-09-17T14:55:00.000Z",
    title: "Sent a message",
    targetRef: "/channels/chn_1",
    ...partial,
  };
}

function fileItem(
  id: string,
  actorName: string,
  createdAt: string,
  context: string,
  status: "unread" | "read" = "read",
): NotificationItem {
  const row = mapNotificationRow(
    {
      id,
      type: "new_file",
      status,
      createdAt,
      actorName,
      context,
      targetRef: "/files",
    },
    NOW,
  );
  if (!row) throw new Error(`fixture row ${id} failed to map`);
  return row;
}

describe("channel message actor", () => {
  it("names the author, not the channel", () => {
    const row = mapNotificationRow(
      channelWire({
        actorName: "Jacob Posel",
        channelName: "#project-fleet-bots-ga-sprint-a61db44b",
      }),
      NOW,
    )!;
    expect(row.verbText).toBe("Jacob Posel sent a message");
    expect(row.actorInitials).toBe("JP");
    expect(row.contextLine).toBe("#project-fleet-bots-ga-sprint");
  });

  it("never renders the channel handle as the actor", () => {
    const row = mapNotificationRow(
      channelWire({
        actorName: "#project-fleet-bots-ga-sprint-a61db44b",
        authorName: "Ada (bot)",
      }),
      NOW,
    )!;
    expect(row.actorName).toBe("Ada (bot)");
    expect(row.verbText).toBe("Ada (bot) sent a message");
    expect(row.contextLine).toBe("#project-fleet-bots-ga-sprint");
  });

  it("falls back to Someone when only the channel is known", () => {
    const row = mapNotificationRow(
      channelWire({ actorName: "#project-fleet-bots-ga-sprint-a61db44b" }),
      NOW,
    )!;
    expect(row.actorName).toBe("");
    expect(row.verbText).toBe("New messages");
    expect(row.contextLine).toBe("#project-fleet-bots-ga-sprint");
  });

  it("reads the author from mesh-style author fields", () => {
    const row = mapNotificationRow(
      channelWire({
        channelName: "#dev",
        fromDisplayName: "Corey Epstein",
      }),
      NOW,
    )!;
    expect(row.verbText).toBe("Corey Epstein sent a message");
  });

  it("leaves DM actors alone", () => {
    const row = mapNotificationRow(
      { id: "dm:1", type: "dm", actorName: "Ada", body: "hi", createdAt: "2026-09-17T14:00:00.000Z" },
      NOW,
    )!;
    expect(row.verbText).toBe("Ada sent a message");
    expect(row.contextLine).toBe("hi");
  });
});

describe("channel name display", () => {
  it("strips the id suffix", () => {
    expect(stripChannelIdSuffix("project-fleet-bots-ga-sprint-a61db44b")).toBe(
      "project-fleet-bots-ga-sprint",
    );
    expect(stripChannelIdSuffix("welcome 1feed8f5")).toBe("welcome");
  });

  it("keeps human names that merely end in short tokens", () => {
    expect(stripChannelIdSuffix("design-2026")).toBe("design-2026");
    expect(stripChannelIdSuffix("team-abc")).toBe("team-abc");
  });

  it("formats a single leading hash", () => {
    expect(formatChannelLabel("#project-x-a61db44b")).toBe("#project-x");
    expect(formatChannelLabel("project-x")).toBe("#project-x");
  });
});

describe("file bundles", () => {
  it("splits company prefix from path", () => {
    expect(splitFileContext("indigo · reports/q3/deck.pdf")).toEqual({
      company: "indigo",
      path: "reports/q3/deck.pdf",
    });
    expect(splitFileContext("notes.md")).toEqual({ company: null, path: "notes.md" });
  });

  it("finds the shared folder, ignoring file names", () => {
    expect(
      commonFolderPrefix(["reports/q3/a.pdf", "reports/q3/b.pdf"]),
    ).toBe("reports/q3");
    expect(commonFolderPrefix(["reports/q3/a.pdf", "decks/b.pdf"])).toBe("");
  });

  it("bundles one actor's files inside the window", () => {
    const items = [
      fileItem("file:3", "cnueno@gmail.com", "2026-09-17T14:59:00.000Z", "indigo · shots/c.png"),
      fileItem("file:2", "cnueno@gmail.com", "2026-09-17T14:56:00.000Z", "indigo · shots/b.png"),
      fileItem("file:1", "cnueno@gmail.com", "2026-09-17T14:52:00.000Z", "indigo · shots/a.png"),
    ];
    const { items: bundled } = bundleFileNotifications(items);
    expect(bundled).toHaveLength(1);
    expect(bundled[0]!.verbText).toBe("cnueno@gmail.com added 3 files");
    expect(bundled[0]!.contextLine).toBe("indigo · shots");
    // Clicking the bundle opens what the newest row opened.
    expect(bundled[0]!.id).toBe("file:3");
    expect(bundled[0]!.targetRef).toBe("/files");
  });

  it("splits across a window boundary", () => {
    const items = [
      fileItem("file:new", "cnueno@gmail.com", "2026-09-17T14:59:00.000Z", "indigo · shots/c.png"),
      fileItem("file:near", "cnueno@gmail.com", "2026-09-17T14:55:00.000Z", "indigo · shots/b.png"),
      fileItem("file:old", "cnueno@gmail.com", "2026-09-17T14:30:00.000Z", "indigo · old/a.png"),
      fileItem("file:older", "cnueno@gmail.com", "2026-09-17T14:28:00.000Z", "indigo · old/b.png"),
    ];
    const { items: bundled } = bundleFileNotifications(items);
    expect(bundled.map((row) => row.verbText)).toEqual([
      "cnueno@gmail.com added 2 files",
      "cnueno@gmail.com added 2 files",
    ]);
    expect(bundled.map((row) => row.contextLine)).toEqual([
      "indigo · shots",
      "indigo · old",
    ]);
  });

  it("never mixes actors", () => {
    const items = [
      fileItem("file:a", "Ada", "2026-09-17T14:59:00.000Z", "indigo · shots/a.png"),
      fileItem("file:b", "Ada", "2026-09-17T14:58:00.000Z", "indigo · shots/b.png"),
      fileItem("file:c", "Kai", "2026-09-17T14:57:00.000Z", "indigo · shots/c.png"),
      fileItem("file:d", "Kai", "2026-09-17T14:56:00.000Z", "indigo · shots/d.png"),
    ];
    const { items: bundled } = bundleFileNotifications(items);
    expect(bundled.map((row) => row.verbText)).toEqual([
      "Ada added 2 files",
      "Kai added 2 files",
    ]);
  });

  it("keeps single-file wording", () => {
    const items = [
      fileItem("file:solo", "Ada", "2026-09-17T14:59:00.000Z", "indigo · shots/a.png"),
    ];
    const { items: bundled, collapsedUnread } = bundleFileNotifications(items);
    expect(bundled[0]!.verbText).toBe("Ada added a file");
    expect(collapsedUnread).toBe(0);
  });

  it("leaves non-file rows untouched and in place", () => {
    const dm = mapNotificationRow(
      { id: "dm:1", type: "dm", actorName: "Ada", body: "hi", createdAt: "2026-09-17T14:58:30.000Z" },
      NOW,
    )!;
    const items = [
      fileItem("file:a", "Kai", "2026-09-17T14:59:00.000Z", "indigo · shots/a.png"),
      dm,
      fileItem("file:b", "Kai", "2026-09-17T14:58:00.000Z", "indigo · shots/b.png"),
    ];
    const { items: bundled } = bundleFileNotifications(items);
    expect(bundled.map((row) => row.id)).toEqual(["file:a", "dm:1"]);
  });

  it("counts a bundle once in the unread total", () => {
    const items = [
      fileItem("file:a", "Kai", "2026-09-17T14:59:00.000Z", "indigo · shots/a.png", "unread"),
      fileItem("file:b", "Kai", "2026-09-17T14:58:00.000Z", "indigo · shots/b.png", "unread"),
      fileItem("file:c", "Kai", "2026-09-17T14:57:00.000Z", "indigo · shots/c.png", "unread"),
    ];
    const { collapsedUnread } = bundleFileNotifications(items);
    expect(collapsedUnread).toBe(2);

    const view = buildNotificationsView(
      { ...emptyFeedState(), items, unreadCount: 3 },
      NOW,
    );
    expect(view.visibleCount).toBe(1);
    expect(view.badgeText).toBe("1");
    expect(view.headerUnread).toBe("1 unread");
  });
});

 it('describes unattributed file additions without inventing an actor', () => {
   const a = fileItem('f1','Someone','2026-09-17T14:00:00Z','indigo · docs/a.md');
   const b = fileItem('f2','Someone','2026-09-17T14:00:01Z','indigo · docs/b.md');
   expect(a.verbText).toBe('File added');
   expect(bundleFileNotifications([a,b]).items[0].verbText).toBe('2 files added');
 });
