import { describe, it, expect } from "vitest";
import { decisionAnswersFromMessages } from "./decision-answers";
import { HQ_BLOCK_FENCE_LANG } from "./richMessageContent";

/** Build a message body carrying one decision block via the hq-block fence. */
function cardBody(
  question: string,
  options: Array<{ label: string; recommended?: boolean }>,
  opts: { questionId?: string; allowOther?: boolean } = {},
): string {
  const block = {
    kind: "decision",
    question,
    options,
    allowOther: opts.allowOther ?? true,
    ...(opts.questionId ? { questionId: opts.questionId } : {}),
  };
  const envelope = { version: 1, blocks: [block] };
  return [
    question,
    "",
    "```" + HQ_BLOCK_FENCE_LANG,
    JSON.stringify(envelope),
    "```",
  ].join("\n");
}

const AGENT = "agt_deacon";
const HUMAN = "usr_jacob";

describe("decisionAnswersFromMessages", () => {
  it("marks a card answered with the clicked option label", () => {
    const messages = [
      {
        fromPersonUid: AGENT,
        createdAt: "2026-09-08T10:00:00Z",
        body: cardBody(
          "Approve this research and build plan?",
          [
            { label: "Approve and build", recommended: true },
            { label: "Revise the plan" },
          ],
          { questionId: "clarify_1" },
        ),
      },
      {
        fromPersonUid: HUMAN,
        createdAt: "2026-09-08T10:01:00Z",
        body: "Approve and build",
      },
    ];
    const answers = decisionAnswersFromMessages(messages);
    expect(answers.get("clarify_1")).toEqual({ label: "Approve and build" });
  });

  it("matches option labels case-insensitively and returns the canonical label", () => {
    const messages = [
      {
        fromPersonUid: AGENT,
        createdAt: "2026-09-08T10:00:00Z",
        body: cardBody(
          "Pick one",
          [{ label: "Revise the plan" }],
          { questionId: "clarify_2" },
        ),
      },
      {
        fromPersonUid: HUMAN,
        createdAt: "2026-09-08T10:01:00Z",
        body: "  revise THE plan  ",
      },
    ];
    const answers = decisionAnswersFromMessages(messages);
    expect(answers.get("clarify_2")).toEqual({ label: "Revise the plan" });
  });

  it("treats a non-matching human reply as a free-text Other answer", () => {
    const messages = [
      {
        fromPersonUid: AGENT,
        createdAt: "2026-09-08T10:00:00Z",
        body: cardBody(
          "Pick one",
          [{ label: "Approve and build" }],
          { questionId: "clarify_3", allowOther: true },
        ),
      },
      {
        fromPersonUid: HUMAN,
        createdAt: "2026-09-08T10:01:00Z",
        body: "Actually, let's ship just phase one first",
      },
    ];
    const answers = decisionAnswersFromMessages(messages);
    expect(answers.get("clarify_3")).toEqual({
      label: "Actually, let's ship just phase one first",
    });
  });

  it("does NOT answer a card that disallows Other from a non-matching reply", () => {
    const messages = [
      {
        fromPersonUid: AGENT,
        createdAt: "2026-09-08T10:00:00Z",
        body: cardBody(
          "Pick one",
          [{ label: "Approve and build" }],
          { questionId: "clarify_4", allowOther: false },
        ),
      },
      {
        fromPersonUid: HUMAN,
        createdAt: "2026-09-08T10:01:00Z",
        body: "something unrelated",
      },
    ];
    const answers = decisionAnswersFromMessages(messages);
    expect(answers.has("clarify_4")).toBe(false);
  });

  it("ignores agent messages as answers (card is never self-answered)", () => {
    const messages = [
      {
        fromPersonUid: AGENT,
        createdAt: "2026-09-08T10:00:00Z",
        body: cardBody(
          "Pick one",
          [{ label: "Approve and build" }],
          { questionId: "clarify_5" },
        ),
      },
      {
        // An agent echoing the label must not count as the human's answer.
        fromPersonUid: AGENT,
        createdAt: "2026-09-08T10:01:00Z",
        body: "Approve and build",
      },
    ];
    const answers = decisionAnswersFromMessages(messages);
    expect(answers.has("clarify_5")).toBe(false);
  });

  it("does not answer a card that has no reply yet", () => {
    const messages = [
      {
        fromPersonUid: AGENT,
        createdAt: "2026-09-08T10:00:00Z",
        body: cardBody(
          "Pick one",
          [{ label: "Approve and build" }],
          { questionId: "clarify_6" },
        ),
      },
    ];
    expect(decisionAnswersFromMessages(messages).size).toBe(0);
  });

  it("ignores cards without a questionId (cannot correlate/persist)", () => {
    const messages = [
      {
        fromPersonUid: AGENT,
        createdAt: "2026-09-08T10:00:00Z",
        body: cardBody("Pick one", [{ label: "Approve and build" }]),
      },
      {
        fromPersonUid: HUMAN,
        createdAt: "2026-09-08T10:01:00Z",
        body: "Approve and build",
      },
    ];
    expect(decisionAnswersFromMessages(messages).size).toBe(0);
  });

  it("routes each answer to its own card when two are open", () => {
    const messages = [
      {
        fromPersonUid: AGENT,
        createdAt: "2026-09-08T10:00:00Z",
        body: cardBody(
          "Q1",
          [{ label: "Alpha" }, { label: "Beta" }],
          { questionId: "q1" },
        ),
      },
      {
        fromPersonUid: AGENT,
        createdAt: "2026-09-08T10:00:30Z",
        body: cardBody(
          "Q2",
          [{ label: "Gamma" }, { label: "Delta" }],
          { questionId: "q2" },
        ),
      },
      {
        fromPersonUid: HUMAN,
        createdAt: "2026-09-08T10:01:00Z",
        body: "Delta",
      },
      {
        fromPersonUid: HUMAN,
        createdAt: "2026-09-08T10:02:00Z",
        body: "Alpha",
      },
    ];
    const answers = decisionAnswersFromMessages(messages);
    expect(answers.get("q1")).toEqual({ label: "Alpha" });
    expect(answers.get("q2")).toEqual({ label: "Delta" });
  });
});
