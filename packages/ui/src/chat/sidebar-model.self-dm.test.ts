import { describe, expect, it } from "vitest";
import {
  applyPairUnreads,
  normalizeConversations,
  withSelfContact,
  type DmContactInput,
} from "./sidebar-model";

// Notes to self: the signed-in person's own DM row. The server roster never
// lists the caller, so the sidebar adds them; the row always shows, reads
// "<name> (you)", and never carries an unread badge or dot.

const SELF = { uid: "prs_me", email: "me@example.com", displayName: "Jacob Posel" };
const ADA: DmContactInput = {
  personUid: "prs_ada",
  displayName: "Ada",
  lastMessageAt: "2026-09-20T10:00:00.000Z",
};

describe("notes to self", () => {
  it("adds the signed-in person to the contacts once", () => {
    const once = withSelfContact([ADA], SELF);
    expect(once.map((c) => c.personUid)).toEqual(["prs_ada", "prs_me"]);
    expect(withSelfContact(once, SELF)).toHaveLength(2);
    expect(withSelfContact([ADA], null)).toEqual([ADA]);
  });

  it("shows the self row with no history, labelled as you", () => {
    const rows = normalizeConversations([], withSelfContact([ADA], SELF), {
      selfUid: SELF.uid,
    });
    const self = rows.find((r) => r.id === "dm:prs_me");
    expect(self?.title).toBe("Jacob Posel (you)");
    expect(self?.kind).toBe("dm");
  });

  it("never gives the self row an unread badge or dot", () => {
    const contacts = applyPairUnreads(
      withSelfContact([ADA], SELF).map((c) =>
        c.personUid === SELF.uid ? { ...c, activityDot: true } : c,
      ),
      new Map([[SELF.uid, 3]]),
    );
    const self = normalizeConversations([], contacts, {
      selfUid: SELF.uid,
      dmDots: [SELF.uid],
    }).find((r) => r.id === "dm:prs_me");
    expect(self?.unreadCount).toBeUndefined();
    expect(self?.unreadDot).toBe(false);
  });

  it("leaves the self row out when no selfUid is given, as before", () => {
    const rows = normalizeConversations([], withSelfContact([ADA], SELF));
    expect(rows.some((r) => r.id === "dm:prs_me")).toBe(false);
  });
});
