import { describe, expect, it } from "vitest";

import {
  RECIPIENT_RECENT_LIMIT,
  flattenRecipientSections,
  groupRecipients,
  highlightParts,
  inRecipientScope,
  matchScore,
  nextRecipientScope,
  rankRecipients,
  recipientDisplayName,
  recipientPlaceholder,
  recipientPrimaryLabel,
  removeLastRecipient,
  toggleRecipient,
  type RecipientItem,
} from "./recipient-picker-model.js";

const item = (
  id: string,
  kind: RecipientItem["kind"],
  name: string,
  extra: Partial<RecipientItem> = {},
): RecipientItem => ({ id, kind, name, companyUid: "cmp_indigo", lastActivityAt: 0, ...extra });

const DIRECTORY: RecipientItem[] = [
  item("dm:prs_c1", "person", "Caitlin Hutchinson", { subtitle: "caitlin@getindigo.ai", lastActivityAt: 50 }),
  item("dm:prs_c2", "person", "Caitlin Hutchinson", { subtitle: "caitlin.h@vyg.ai" }),
  item("dm:prs_jo", "person", "Jonathan Park", { subtitle: "jon@getindigo.ai", lastActivityAt: 90 }),
  item("dm:prs_mac", "person", "Isaac Mack", { subtitle: "isaac@getindigo.ai" }),
  item("dm:agt_izzy", "bot", "Izzy", { lastActivityAt: 70 }),
  item("ch:ideas", "channel", "ideas", { lastActivityAt: 10 }),
  item("ch:grp", "group", "Ana, Bo"),
  item("dm:prs_other", "person", "Olive Other", { companyUid: "cmp_other" }),
];

describe("section grouping", () => {
  it("leads with Recent (most recent first) and never repeats a row below it", () => {
    const sections = groupRecipients(DIRECTORY, "");
    expect(sections.map((s) => s.key)).toEqual(["recent", "channels", "people"]);
    expect(sections[0].items.map((r) => r.id)).toEqual(["dm:prs_jo", "dm:agt_izzy", "dm:prs_c1", "ch:ideas"]);
    const ids = flattenRecipientSections(sections).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(DIRECTORY.length);
  });

  it("caps Recent at the limit", () => {
    const many = Array.from({ length: 8 }, (_, i) => item(`dm:${i}`, "person", `Person ${i}`, { lastActivityAt: i + 1 }));
    const [recent, people] = groupRecipients(many, "");
    expect(recent.items).toHaveLength(RECIPIENT_RECENT_LIMIT);
    expect(people.items).toHaveLength(8 - RECIPIENT_RECENT_LIMIT);
  });

  it("groups query results Channels, People, Bots (groups sit with channels) and drops Recent", () => {
    const sections = groupRecipients(DIRECTORY, "a");
    expect(sections.map((s) => s.label)).toEqual(["Channels", "People"]);
    expect(groupRecipients(DIRECTORY, "i").map((s) => s.key)).toEqual(["channels", "people", "bots"]);
  });

  it("filters by scope through the companies an item is known in", () => {
    expect(inRecipientScope(DIRECTORY[7], "cmp_other")).toBe(true);
    expect(inRecipientScope(DIRECTORY[0], "cmp_other")).toBe(false);
    expect(inRecipientScope(item("x", "person", "X", { companyUid: null, companyUids: ["cmp_a", "cmp_b"] }), "cmp_b")).toBe(true);
    expect(inRecipientScope(DIRECTORY[0], "")).toBe(true);
  });
});

describe("search ranking", () => {
  it("ranks exact, then prefix, then word prefix, then subtitle, then substring", () => {
    const rows = [
      item("a", "person", "Mackenzie"),
      item("b", "person", "Isaac Mack"),
      item("c", "person", "Mac"),
      item("d", "person", "Tom", { subtitle: "mac@x.io" }),
      item("e", "person", "Tomac"),
    ];
    expect(rankRecipients(rows, "mac").map((r) => r.id)).toEqual(["c", "a", "b", "d", "e"]);
  });

  it("breaks ties by recency, then name", () => {
    const rows = [item("a", "person", "Ann B"), item("b", "person", "Ann A", { lastActivityAt: 5 }), item("c", "person", "Ann C")];
    expect(rankRecipients(rows, "ann").map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("ignores a leading # or @ and finds people by email", () => {
    expect(matchScore(item("x", "channel", "welcome"), "#wel")).toBe(80);
    expect(matchScore(item("y", "person", "Zed", { subtitle: "zz@x.io" }), "@zz")).toBe(50);
    expect(matchScore(item("z", "person", "Zed"), "q")).toBe(0);
  });

  it("keeps same-name people apart by their email", () => {
    expect(rankRecipients(DIRECTORY, "caitlin").map((r) => r.subtitle)).toEqual([
      "caitlin@getindigo.ai",
      "caitlin.h@vyg.ai",
    ]);
  });

  it("splits text around the first case-insensitive match", () => {
    expect(highlightParts("Jonathan", "NAT")).toEqual([
      { text: "Jo", match: false },
      { text: "nat", match: true },
      { text: "han", match: false },
    ]);
    expect(highlightParts("#welcome", "#wel")).toEqual([
      { text: "#", match: false },
      { text: "wel", match: true },
      { text: "come", match: false },
    ]);
    expect(highlightParts("Jonathan", "")).toEqual([{ text: "Jonathan", match: false }]);
  });
});

describe("selection", () => {
  const [, , jo, , izzy, ideas] = DIRECTORY;

  it("toggles in multi-select and replaces in single-select", () => {
    expect(toggleRecipient(["dm:prs_jo"], izzy, { multiple: true })).toEqual(["dm:prs_jo", "dm:agt_izzy"]);
    expect(toggleRecipient(["dm:prs_jo"], jo, { multiple: true })).toEqual([]);
    expect(toggleRecipient(["dm:prs_jo"], izzy, { multiple: false })).toEqual(["dm:agt_izzy"]);
  });

  it("lets Forward mix channels and people, and makes a channel exclusive for New message", () => {
    expect(toggleRecipient(["dm:prs_jo"], ideas, { multiple: true })).toEqual(["dm:prs_jo", "ch:ideas"]);
    const opts = { multiple: true, channelOpens: true, items: DIRECTORY };
    expect(toggleRecipient(["dm:prs_jo", "dm:agt_izzy"], ideas, opts)).toEqual(["ch:ideas"]);
    expect(toggleRecipient(["ch:ideas"], jo, opts)).toEqual(["dm:prs_jo"]);
  });

  it("removes the last chip on Backspace", () => {
    expect(removeLastRecipient(["a", "b"])).toEqual(["a"]);
    expect(removeLastRecipient([])).toEqual([]);
  });
});

describe("labels", () => {
  it("names the primary button by mode, with the count above one", () => {
    expect(recipientPrimaryLabel("message", 1)).toBe("Start conversation");
    expect(recipientPrimaryLabel("message", 3)).toBe("Start conversation with 3");
    expect(recipientPrimaryLabel("forward", 1)).toBe("Forward");
    expect(recipientPrimaryLabel("forward", 2)).toBe("Forward to 2");
    expect(recipientPrimaryLabel("share", 2)).toBe("Share with 2");
  });

  it("prefixes channels with # and changes the placeholder once someone is chosen", () => {
    expect(recipientDisplayName({ kind: "channel", name: "welcome" })).toBe("#welcome");
    expect(recipientDisplayName({ kind: "group", name: "Ana, Bo" })).toBe("Ana, Bo");
    expect(recipientPlaceholder(0)).toBe("Search people, bots, and channels");
    expect(recipientPlaceholder(1)).toBe("Add another");
  });

  it("cycles scope in both directions", () => {
    const scopes = [
      { id: "", label: "Personal" },
      { id: "cmp_a", label: "A" },
      { id: "cmp_b", label: "B" },
    ];
    expect(nextRecipientScope(scopes, "", 1)).toBe("cmp_a");
    expect(nextRecipientScope(scopes, "cmp_b", 1)).toBe("");
    expect(nextRecipientScope(scopes, "", -1)).toBe("cmp_b");
    expect(nextRecipientScope([], "x", 1)).toBe("x");
  });
});
