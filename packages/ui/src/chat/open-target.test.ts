// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";

import {
  CHANNEL_QUERY_KEY,
  DM_QUERY_KEY,
  OPEN_CHANNEL_EVENT,
  REPLY_QUERY_KEY,
  conversationDeepLinkFromLocation,
  conversationRowForDeepLink,
  parseConversationDeepLink,
  requestChannelOpen,
  shouldOpenReplyDeepLink,
  takePendingChannel,
  takePendingChannelFocus,
  takePendingChannelOpen,
} from "./open-target";

afterEach(() => {
  takePendingChannelOpen();
  takePendingChannelFocus();
});

describe("parseConversationDeepLink", () => {
  it("reads ?channel= and ?reply= and ignores ?thread=", () => {
    expect(
      parseConversationDeepLink(
        `?${CHANNEL_QUERY_KEY}=chn_proj&${REPLY_QUERY_KEY}=evt_root&thread=mesh_thread`,
      ),
    ).toEqual({
      channelId: "chn_proj",
      personUid: null,
      replyRootEventId: "evt_root",
    });
    expect(
      parseConversationDeepLink("/?channel=chn_proj&reply=evt_root"),
    ).toEqual({
      channelId: "chn_proj",
      personUid: null,
      replyRootEventId: "evt_root",
    });
    expect(parseConversationDeepLink("?thread=evt_root")).toEqual({
      channelId: null,
      personUid: null,
      replyRootEventId: null,
    });
    expect(
      parseConversationDeepLink(new URLSearchParams("dm=prs_ada&reply=evt_dm")),
    ).toEqual({
      channelId: null,
      personUid: "prs_ada",
      replyRootEventId: "evt_dm",
    });
    expect(parseConversationDeepLink("")).toEqual({
      channelId: null,
      personUid: null,
      replyRootEventId: null,
    });
    expect(DM_QUERY_KEY).toBe("dm");
    expect(REPLY_QUERY_KEY).toBe("reply");
    expect(REPLY_QUERY_KEY).not.toBe("thread");
  });

  it("reads the same query from a location search string", () => {
    expect(
      conversationDeepLinkFromLocation({
        search: "/?channel=chn_chat&reply=evt_root".replace(/^[^?]+/, ""),
      }),
    ).toEqual({
      channelId: "chn_chat",
      personUid: null,
      replyRootEventId: "evt_root",
    });
    expect(
      conversationDeepLinkFromLocation({ search: "?channel=chn_chat" }),
    ).toEqual({
      channelId: "chn_chat",
      personUid: null,
      replyRootEventId: null,
    });
  });
});

describe("requestChannelOpen replyRootEventId", () => {
  it("stashes and takes an optional reply root with the channel", () => {
    const seen: unknown[] = [];
    const onOpen = (event: Event) => {
      seen.push((event as CustomEvent).detail);
    };
    window.addEventListener(OPEN_CHANNEL_EVENT, onOpen);
    requestChannelOpen("chn_proj", {
      messageId: "evt_root",
      replyRootEventId: "evt_root",
    });
    window.removeEventListener(OPEN_CHANNEL_EVENT, onOpen);
    expect(seen).toEqual([
      {
        channelId: "chn_proj",
        messageId: "evt_root",
        createdAt: null,
        replyRootEventId: "evt_root",
        automatic: false,
        title: null,
        companyUid: null,
        focusCardId: null,
        focusCardKind: null,
      },
    ]);
    expect(takePendingChannelOpen()).toEqual({
      channelId: "chn_proj",
      messageId: "evt_root",
      createdAt: null,
      replyRootEventId: "evt_root",
      automatic: false,
      title: null,
      companyUid: null,
      focusCardId: null,
      focusCardKind: null,
    });
    expect(takePendingChannel()).toBeNull();
  });

  it("preserves the automatic-selection intent for both the event and a later mount", () => {
    const seen: unknown[] = [];
    const onOpen = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener(OPEN_CHANNEL_EVENT, onOpen);
    requestChannelOpen("chn_auto", { automatic: true });
    window.removeEventListener(OPEN_CHANNEL_EVENT, onOpen);

    expect(seen).toEqual([
      {
        channelId: "chn_auto",
        messageId: null,
        createdAt: null,
        replyRootEventId: null,
        automatic: true,
        title: null,
        companyUid: null,
        focusCardId: null,
        focusCardKind: null,
      },
    ]);
    expect(takePendingChannelOpen()?.automatic).toBe(true);
  });

  it("carries a lifecycle card focus target for the shell to scroll to", () => {
    requestChannelOpen("setup", {
      focusCardId: " card_create_company_2 ",
      focusCardKind: "create_company",
    });
    expect(takePendingChannelOpen()).toMatchObject({
      channelId: "setup",
      focusCardId: "card_create_company_2",
      focusCardKind: "create_company",
    });
    expect(takePendingChannelOpen()).toBeNull();
  });
});

describe("conversationRowForDeepLink", () => {
  it("prefers a matching directory row and stubs a missing channel", () => {
    const existing = {
      id: "ch:chn_proj",
      kind: "channel" as const,
      title: "launch",
      companyUid: "cmp_acme",
      unreadDot: false,
      lastActivityAt: 1,
      pinned: false,
      channelId: "chn_proj",
    };
    expect(
      conversationRowForDeepLink(
        { channelId: "chn_proj", personUid: null, replyRootEventId: "evt" },
        [existing],
      ),
    ).toBe(existing);
    expect(
      conversationRowForDeepLink({
        channelId: "chn_missing",
        personUid: null,
        replyRootEventId: null,
      }),
    ).toMatchObject({
      id: "ch:chn_missing",
      kind: "channel",
      channelId: "chn_missing",
    });
  });

  it("stubs a missing channel with the raw id only when no title hint exists", () => {
    // Reported: a just-created channel opened before the directory listed it
    // painted `chn_01M1…` in the header until the user clicked away and back.
    expect(
      conversationRowForDeepLink({
        channelId: "chn_new",
        personUid: null,
        replyRootEventId: null,
      })?.title,
    ).toBe("chn_new");
    expect(
      conversationRowForDeepLink({
        channelId: "chn_new",
        personUid: null,
        replyRootEventId: null,
        title: "  hq-create-channel-test ",
        companyUid: "cmp_indigo",
      }),
    ).toMatchObject({
      id: "ch:chn_new",
      title: "hq-create-channel-test",
      companyUid: "cmp_indigo",
    });
  });

  it("a real directory row still wins over the hint", () => {
    const existing = {
      id: "ch:chn_new",
      kind: "channel" as const,
      title: "from-directory",
      companyUid: "cmp_indigo",
      unreadDot: false,
      lastActivityAt: 1,
      pinned: false,
      channelId: "chn_new",
    };
    expect(
      conversationRowForDeepLink(
        {
          channelId: "chn_new",
          personUid: null,
          replyRootEventId: null,
          title: "hint",
        },
        [existing],
      ),
    ).toBe(existing);
  });
});

describe("requestChannelOpen title hint", () => {
  it("carries title + companyUid through the stash and the window event", () => {
    const seen: unknown[] = [];
    const onEvent = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener(OPEN_CHANNEL_EVENT, onEvent);
    try {
      requestChannelOpen("chn_new", {
        title: "hq-create-channel-test",
        companyUid: "cmp_indigo",
      });
    } finally {
      window.removeEventListener(OPEN_CHANNEL_EVENT, onEvent);
    }
    expect(seen[0]).toMatchObject({
      channelId: "chn_new",
      title: "hq-create-channel-test",
      companyUid: "cmp_indigo",
    });
    const pending = takePendingChannelOpen();
    expect(pending).toMatchObject({
      channelId: "chn_new",
      title: "hq-create-channel-test",
      companyUid: "cmp_indigo",
    });
    // Cleared after take — a later unrelated open must not inherit the hint.
    requestChannelOpen("chn_other");
    expect(takePendingChannelOpen()).toMatchObject({
      channelId: "chn_other",
      title: null,
      companyUid: null,
    });
  });
});

describe("conversationRowForDeepLink DM stub", () => {
  it("never uses the person uid as a DM stub title", () => {
    const uid = "agt_374A1JY3NE63KSYBN97PND4QGC";
    const stub = conversationRowForDeepLink({
      channelId: null,
      personUid: uid,
      replyRootEventId: null,
    });
    expect(stub).toMatchObject({
      id: `dm:${uid}`,
      kind: "dm",
      personUid: uid,
    });
    expect(stub?.title).toBe("Direct message");
    expect(stub?.title).not.toContain("agt_");
    expect(stub?.title).not.toBe(uid);

    const named = conversationRowForDeepLink({
      channelId: null,
      personUid: uid,
      replyRootEventId: null,
      displayName: "  Polar Data Agent  ",
    });
    expect(named?.title).toBe("Polar Data Agent");
  });
});

describe("shouldOpenReplyDeepLink", () => {
  it("opens only when the fetched root matches the requested id", () => {
    expect(
      shouldOpenReplyDeepLink("evt_root", { root: { eventId: "evt_root" } }),
    ).toBe(true);
    expect(shouldOpenReplyDeepLink("evt_root", { root: null })).toBe(false);
    expect(shouldOpenReplyDeepLink("evt_root", null)).toBe(false);
    expect(
      shouldOpenReplyDeepLink("evt_root", { root: { eventId: "evt_other" } }),
    ).toBe(false);
    expect(shouldOpenReplyDeepLink("", { root: { eventId: "evt_root" } })).toBe(
      false,
    );
  });
});
