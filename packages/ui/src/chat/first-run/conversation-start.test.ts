import { describe, expect, it } from "vitest";
import {
  CONVERSATION_START_GRACE_MS,
  CONVERSATION_START_KEY,
  contactsFromConversationStart,
  fromConversationStart,
  readConversationStarts,
  recordConversationStart,
} from "./conversation-start.js";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  };
}

const ADOPTED_AT = Date.parse("2026-10-15T16:30:00Z");
const timeline = [
  { eventId: "e1", createdAt: "2026-10-15T15:06:00Z", body: "hi Nibs" },
  { eventId: "e2", createdAt: "2026-10-15T16:09:00Z", body: "earlier answer" },
  { eventId: "e3", createdAt: "2026-10-15T16:30:05Z", body: "hello again" },
];

describe("conversation start marker", () => {
  it("with a marker, only the messages from adopt time on render", () => {
    const starts = recordConversationStart(memoryStorage(), "agt_nibs", ADOPTED_AT);
    expect(fromConversationStart(timeline, starts, "agt_nibs").map((m) => m.eventId)).toEqual(["e3"]);
  });

  it("with no marker, the timeline is unchanged", () => {
    expect(fromConversationStart(timeline, {}, "agt_nibs")).toBe(timeline);
    const starts = recordConversationStart(memoryStorage(), "agt_other", ADOPTED_AT);
    expect(fromConversationStart(timeline, starts, "agt_nibs")).toBe(timeline);
  });

  it("keeps a first message the server stamped a little before this computer's clock", () => {
    const starts = recordConversationStart(memoryStorage(), "agt_nibs", ADOPTED_AT);
    const early = [{ eventId: "hello", createdAt: new Date(ADOPTED_AT - CONVERSATION_START_GRACE_MS + 1000).toISOString() }];
    expect(fromConversationStart(early, starts, "agt_nibs")).toEqual(early);
  });

  it("keeps a message with no time yet (a send on its way)", () => {
    const starts = recordConversationStart(memoryStorage(), "agt_nibs", ADOPTED_AT);
    const pending = [...timeline, { eventId: "p1", createdAt: "", body: "sending" }];
    expect(fromConversationStart(pending, starts, "agt_nibs").map((m) => m.eventId)).toEqual(["e3", "p1"]);
  });

  it("survives a reload through storage and ignores junk", () => {
    const storage = memoryStorage();
    recordConversationStart(storage, "agt_nibs", ADOPTED_AT);
    expect(readConversationStarts(storage)).toEqual({ agt_nibs: ADOPTED_AT });
    storage.setItem(CONVERSATION_START_KEY, "{not json");
    expect(readConversationStarts(storage)).toEqual({});
    storage.setItem(CONVERSATION_START_KEY, JSON.stringify({ prs_x: 5, agt_y: "soon" }));
    expect(readConversationStarts(storage)).toEqual({});
  });

  it("the sidebar drops earlier unread and time for the assistant, and counts new ones", () => {
    const starts = recordConversationStart(memoryStorage(), "agt_nibs", ADOPTED_AT);
    const [onlyOld] = contactsFromConversationStart(
      [{ personUid: "agt_nibs", lastMessageAt: "2026-10-15T16:09:00Z", unreadCount: 2, activityDot: true }],
      starts,
    );
    expect(onlyOld).toMatchObject({ lastMessageAt: null, unreadCount: 0, activityDot: false });
    const [withNew] = contactsFromConversationStart(
      [{ personUid: "agt_nibs", lastMessageAt: "2026-10-15T16:31:00Z", unreadCount: 1 }],
      starts,
    );
    expect(withNew).toMatchObject({ lastMessageAt: "2026-10-15T16:31:00Z", unreadCount: 1 });
    const people = [{ personUid: "prs_amy", lastMessageAt: "2026-10-15T15:00:00Z", unreadCount: 2 }];
    expect(contactsFromConversationStart(people, starts)).toBe(people);
  });
});
