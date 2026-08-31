// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";

import {
  MESSAGE_PERSON_EVENT,
  requestConversation,
  takePendingConversation,
} from "./pending-conversation";

afterEach(() => {
  takePendingConversation();
});

describe("pending conversation replyRootEventId", () => {
  it("carries an optional reply root so a later host can open ReplyPanel", () => {
    const seen: unknown[] = [];
    const onOpen = (event: Event) => {
      seen.push((event as CustomEvent).detail);
    };
    window.addEventListener(MESSAGE_PERSON_EVENT, onOpen);
    requestConversation({
      personUid: "prs_ada",
      email: "ada@example.com",
      displayName: "Ada",
      replyRootEventId: "evt_dm_root",
    });
    window.removeEventListener(MESSAGE_PERSON_EVENT, onOpen);
    expect(seen).toEqual([
      {
        personUid: "prs_ada",
        email: "ada@example.com",
        displayName: "Ada",
        replyRootEventId: "evt_dm_root",
        automatic: false,
      },
    ]);
    expect(takePendingConversation()).toEqual({
      personUid: "prs_ada",
      email: "ada@example.com",
      displayName: "Ada",
      replyRootEventId: "evt_dm_root",
      automatic: false,
    });
    expect(takePendingConversation()).toBeNull();
  });

  it("normalizes a blank reply root to null", () => {
    requestConversation({
      personUid: "prs_ada",
      email: "ada@example.com",
      displayName: "Ada",
      replyRootEventId: "   ",
    });
    expect(takePendingConversation()?.replyRootEventId).toBeNull();
  });

  it("preserves automatic directory-selection intent for the mounted host", () => {
    requestConversation({
      personUid: "prs_auto",
      email: "auto@example.com",
      displayName: "Auto",
      automatic: true,
    });
    expect(takePendingConversation()?.automatic).toBe(true);
  });
});
