// @vitest-environment happy-dom

/**
 * Regression: the reply affordance was only complete AFTER opening a thread —
 * unopened rows showed "N replies" with no avatars and no last-reply stamp,
 * because the timeline collectors DISCARDED the reply rows (which carry the
 * author + createdAt) instead of folding them onto the root first.
 *
 * hq-pro stores only `replyCount` on the root, but returns replies as ordinary
 * rows in the SAME page, so the data is available with no extra fetch.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./messaging/ChannelConversation.svelte";
import {
  collectTimelineRoots,
  foldReplyMetadata,
  messagesForDisplay,
  mergeTimelineMessages,
} from "./live-messages";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const rootWire = {
  eventId: "evt_root",
  fromPersonUid: "prs_ada",
  fromDisplayName: "Ada Lovelace",
  body: "root body",
  createdAt: "2026-08-17T01:00:00.000Z",
  replyCount: 2,
};

const replyOne = {
  eventId: "evt_r1",
  rootEventId: "evt_root",
  fromPersonUid: "agt_izzy",
  fromDisplayName: "Izzy",
  body: "first reply",
  createdAt: "2026-08-17T02:00:00.000Z",
};

const replyTwo = {
  eventId: "evt_r2",
  rootEventId: "evt_root",
  fromPersonUid: "prs_bob",
  fromDisplayName: "Bob Fields",
  body: "second reply",
  createdAt: "2026-08-17T03:00:00.000Z",
};

describe("foldReplyMetadata", () => {
  it("folds reply authors + newest reply time onto the root", () => {
    const folded = foldReplyMetadata([rootWire, replyOne, replyTwo] as never);
    const root = folded.find((r) => r.eventId === "evt_root");
    expect(root?.lastReplyAt).toBe("2026-08-17T03:00:00.000Z");
    expect(root?.replyAuthors).toEqual([
      { personUid: "agt_izzy", displayName: "Izzy", agent: true },
      { personUid: "prs_bob", displayName: "Bob Fields" },
    ]);
  });

  it("is order independent (replies mapped before their root)", () => {
    const folded = foldReplyMetadata([replyTwo, replyOne, rootWire] as never);
    const root = folded.find((r) => r.eventId === "evt_root");
    expect(root?.replyAuthors?.map((a) => a.personUid)).toEqual([
      "agt_izzy",
      "prs_bob",
    ]);
    expect(root?.lastReplyAt).toBe("2026-08-17T03:00:00.000Z");
  });

  it("leaves a root with no replies in the page untouched (count-only)", () => {
    const folded = foldReplyMetadata([rootWire] as never);
    expect(folded[0].lastReplyAt).toBeUndefined();
    expect(folded[0].replyAuthors).toBeUndefined();
  });
});

describe("timeline collectors keep reply metadata", () => {
  it("messagesForDisplay folds before dropping the reply rows", () => {
    const rows = messagesForDisplay({
      messages: [replyTwo, replyOne, rootWire],
    });
    expect(rows.map((r) => r.eventId)).toEqual(["evt_root"]);
    expect(rows[0].lastReplyAt).toBe("2026-08-17T03:00:00.000Z");
    expect(rows[0].replyAuthors).toHaveLength(2);
  });

  it("collectTimelineRoots folds replies found on any fetched page", async () => {
    const pages = [
      { messages: [replyTwo, replyOne], nextCursor: "c1" },
      { messages: [rootWire], nextCursor: null },
    ];
    let index = 0;
    const { roots } = await collectTimelineRoots({
      fetchPage: async () => pages[index++] ?? { messages: [] },
      pageSize: 1,
      maxExtraPages: 2,
    });
    expect(roots.map((r) => r.eventId)).toEqual(["evt_root"]);
    expect(roots[0].replyAuthors?.map((a) => a.personUid)).toEqual([
      "agt_izzy",
      "prs_bob",
    ]);
    expect(roots[0].lastReplyAt).toBe("2026-08-17T03:00:00.000Z");
  });

  it("a catch-up page without replies does not wipe folded metadata", () => {
    const existing = messagesForDisplay({
      messages: [replyTwo, replyOne, rootWire],
    });
    const merged = mergeTimelineMessages(
      existing,
      messagesForDisplay({ messages: [rootWire] }),
    );
    const root = merged.find((r) => r.eventId === "evt_root");
    expect(root?.replyAuthors).toHaveLength(2);
    expect(root?.lastReplyAt).toBe("2026-08-17T03:00:00.000Z");
  });
});

describe("first render without opening the thread", () => {
  it("renders avatars + Last reply from the folded row, no panel preview", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        // Exactly what the host now hands down after a plain channel fetch —
        // no replyPreviewByRoot (that only exists once a thread is opened).
        messages: messagesForDisplay({
          messages: [replyTwo, replyOne, rootWire],
        }),
      },
    });
    await tick();
    const affordance = host.querySelector('[data-testid="message-replies"]');
    expect(affordance?.textContent).toContain("2 replies");
    expect(
      affordance?.querySelectorAll(
        '[data-testid="reply-authors"] .dm-replies-avatar',
      ),
    ).toHaveLength(2);
    expect(host.querySelector(".dm-replies-preview")?.textContent).toMatch(
      /Last reply/,
    );
  });

  it("stays count-only when the page carried no reply rows", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: { messages: messagesForDisplay({ messages: [rootWire] }) },
    });
    await tick();
    expect(
      host.querySelector('[data-testid="message-replies"]')?.textContent,
    ).toContain("2 replies");
    expect(host.querySelector('[data-testid="reply-authors"]')).toBeNull();
    expect(host.querySelector(".dm-replies-preview")).toBeNull();
  });
});
