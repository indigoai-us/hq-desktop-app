/**
 * `@here` in the composer.
 *
 * It behaves like a person in the picker — typed, filtered, keyboard-selected,
 * chipped — but it is a single TOKEN on the wire
 * (`{ participantUid: "here", participantType: "broadcast" }`) that the server
 * expands against the channel's live member set. These tests pin the client
 * half: which conversations offer it, what gets sent, and the three ways
 * "@here" is NOT a mention (part of a longer word, part of an email-ish token,
 * or inside code).
 */

import { describe, expect, it } from "vitest";
import {
  activeMentionQuery,
  applyMentionMarkup,
  codeRegionsInBody,
  filterMentionCandidates,
  hereMentionTarget,
  isHereMention,
  mentionPayloadTargets,
  mentionRowSubtitle,
  mentionSegments,
  mentionSpansForBody,
  mentionTextForTarget,
  mentionsPresentInBody,
  mergeMentionTargets,
  replaceActiveMention,
  withHereMention,
  type MentionTarget,
} from "./mentions.js";

const ADA: MentionTarget = {
  participantUid: "prs_ada",
  participantType: "human",
  displayName: "Ada",
  email: "ada@example.com",
};
const BOT: MentionTarget = {
  participantUid: "agt_izzy",
  participantType: "agent",
  displayName: "Izzy",
};

describe("which conversations offer @here", () => {
  it("a channel or group DM gets the row, first", () => {
    const rows = withHereMention([ADA, BOT], true);
    expect(isHereMention(rows[0]!)).toBe(true);
    expect(rows.slice(1)).toEqual([ADA, BOT]);
  });

  it("a 1:1 DM does not get the row at all", () => {
    expect(withHereMention([ADA], false)).toEqual([ADA]);
    expect(withHereMention([ADA], false).some(isHereMention)).toBe(false);
  });

  it("never adds a second @here row", () => {
    const once = withHereMention([ADA], true);
    expect(withHereMention(once, true).filter(isHereMention)).toHaveLength(1);
  });

  it("reads as a broadcast, not a teammate", () => {
    expect(mentionRowSubtitle(hereMentionTarget())).toBe(
      "Notify everyone in this conversation",
    );
  });
});

describe("picking @here from the keyboard", () => {
  it("is offered on a bare @ and narrows as you type", () => {
    const candidates = withHereMention([ADA, BOT], true);
    expect(activeMentionQuery("hey @")).toBe("");
    expect(filterMentionCandidates(candidates, "", []).map((r) => r.participantUid)).toEqual([
      "here",
      "prs_ada",
      "agt_izzy",
    ]);
    // "@h" leaves @here as the highlighted first row — Enter picks it.
    expect(
      filterMentionCandidates(candidates, activeMentionQuery("hey @h"), []).map(
        (r) => r.participantUid,
      ),
    ).toEqual(["here"]);
  });

  it("inserts the @here token into the draft and remembers the target", () => {
    const target = hereMentionTarget();
    expect(mentionTextForTarget(target)).toBe("@here");
    expect(replaceActiveMention("standup @h", mentionTextForTarget(target))).toBe(
      "standup @here ",
    );
    expect(mergeMentionTargets([ADA], target).map((r) => r.participantUid)).toEqual([
      "prs_ada",
      "here",
    ]);
  });

  it("renders as a mention chip in the composer overlay", () => {
    const segments = mentionSegments("standup @here now", [hereMentionTarget()]);
    expect(segments).toEqual([
      { text: "standup ", mention: false },
      { text: "@here", mention: true },
      { text: " now", mention: false },
    ]);
  });

  it("renders as a chip in a sent message", () => {
    const html = applyMentionMarkup("<p>standup @here now</p>", [hereMentionTarget()]);
    expect(html).toContain('<span class="inline-mention">@here</span>');
    // A broadcast is not a person: no profile link.
    expect(html).not.toContain("data-person-uid");
  });
});

describe("what goes on the wire", () => {
  it("sends ONE broadcast token, not a list of people", () => {
    expect(mentionPayloadTargets([hereMentionTarget()])).toEqual([
      { participantUid: "here", participantType: "broadcast", displayName: "" },
    ]);
  });

  it("@here alongside an explicit @person sends both, each once", () => {
    const body = "@Ada and @here";
    const selected = mergeMentionTargets([ADA], hereMentionTarget());
    const payload = mentionPayloadTargets(mentionsPresentInBody(body, selected));
    expect(payload).toEqual([
      {
        participantUid: "prs_ada",
        participantType: "human",
        displayName: "Ada",
        email: "ada@example.com",
      },
      { participantUid: "here", participantType: "broadcast", displayName: "" },
    ]);
    // Ada is named once, and the server dedupes her out of the expansion — so
    // she is badged exactly once.
    expect(payload.filter((m) => m.participantUid === "prs_ada")).toHaveLength(1);
  });

  it("a picked @here the user then deleted does not ride along on send", () => {
    const selected = mergeMentionTargets([], hereMentionTarget());
    expect(mentionsPresentInBody("never mind", selected)).toEqual([]);
  });
});

describe("@here that is not a mention", () => {
  const selected = [hereMentionTarget(), ADA];

  it("does nothing inside a longer word (@heretic)", () => {
    expect(mentionSpansForBody("@heretic writes", selected)).toEqual([]);
    expect(mentionsPresentInBody("@heretic writes", selected)).toEqual([]);
  });

  it("does nothing when it trails another token (nowhere@here)", () => {
    expect(mentionSpansForBody("mail nowhere@here please", selected)).toEqual([]);
    expect(mentionsPresentInBody("mail nowhere@here please", selected)).toEqual([]);
  });

  it("does nothing inside an inline code span", () => {
    expect(mentionSpansForBody("type `@here` to broadcast", selected)).toEqual([]);
    expect(mentionsPresentInBody("type `@here` to broadcast", selected)).toEqual([]);
  });

  it("does nothing inside a fenced code block", () => {
    const body = "example:\n```\n@here @Ada\n```\ndone";
    expect(codeRegionsInBody(body)).toHaveLength(1);
    expect(mentionSpansForBody(body, selected)).toEqual([]);
    expect(mentionsPresentInBody(body, selected)).toEqual([]);
  });

  it("does nothing inside rendered <code> markup", () => {
    const html = applyMentionMarkup("<p>type <code>@here</code> ok</p>", [
      hereMentionTarget(),
    ]);
    expect(html).toBe("<p>type <code>@here</code> ok</p>");
  });

  it("still counts on the same line as code (outside the span)", () => {
    const body = "run `@here` then @here";
    expect(mentionSpansForBody(body, selected)).toEqual([
      { start: body.lastIndexOf("@here"), end: body.length },
    ]);
    expect(mentionsPresentInBody(body, selected)).toEqual([hereMentionTarget()]);
  });

  it("the same word-boundary rule protects a person's name", () => {
    // "@Adam" is not a mention of "@Ada".
    expect(mentionSpansForBody("hi @Adam", selected)).toEqual([]);
    expect(mentionSpansForBody("hi @Ada", selected)).toEqual([
      { start: 3, end: 7 },
    ]);
  });
});
