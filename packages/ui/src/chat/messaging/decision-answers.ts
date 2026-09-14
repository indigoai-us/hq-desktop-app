// Pure derivation of "which decision cards in a thread have been answered, and
// with what choice" from the ordered message timeline.
//
// WHY THIS EXISTS. A decision card (see richMessageContent.ts `DecisionBlock`)
// is answered by sending a plain-text reply whose body is the chosen option
// `label` (option click) or a free-text answer (the "Other…" affordance). The
// transport carries NO structured answer and NO echoed `questionId` — the
// answer is just another message in the thread. So the "this card is answered,
// here's the chosen option" state cannot live only in the card component's
// local runes (it would evaporate on reload / thread reopen). It must be
// DERIVED from the timeline, which is what this module does.
//
// CORRELATION. Cards are keyed by their opaque `questionId`. Walking the
// timeline oldest → newest we treat a message from a non-agent sender as a
// possible answer to the still-open cards that were posted before it:
//   1. If the body exactly matches (trimmed, case-insensitive) one of an open
//      card's option labels, that card is answered with that canonical label
//      (covers an option click — the body IS the label — and a typed reply that
//      happens to match a label). The oldest matching open card wins.
//   2. Otherwise the reply answers the most-recently-opened still-open card
//      that offers a free-text "Other…" (allowOther), recording the reply body
//      as the chosen (Other) text.
// At most one card is closed per answer message, and a card is never answered by
// its own message (cards are registered AFTER the answer check for that row).
//
// Pure (no Svelte runes, no DOM) so it is trivially unit-testable.

import { isAgentUid } from "../agent-thinking.js";
import { richContentForMessage } from "./richMessageContent.js";

/** The resolved answer for one decision card. */
export interface DecisionAnswer {
  /**
   * The chosen option's canonical label (exact-match path) or the free-text
   * "Other…" body. Absent only when a card is somehow marked answered without a
   * recoverable choice (not produced by the derivation below, but the consumer
   * must tolerate it and fall back to a generic "Answered" caption).
   */
  label?: string;
}

/** Minimal message shape this derivation needs (a subset of the wire type). */
export interface DecisionAnswerMessage {
  fromPersonUid?: string | null;
  body?: string | null;
  richContent?: unknown;
  createdAt?: string;
}

interface OpenCard {
  questionId: string;
  /** lowercased option label → canonical label. */
  byLabel: Map<string, string>;
  allowOther: boolean;
}

/**
 * Derive the answered-decision map for a thread. Key = `questionId`; presence in
 * the map means the card is answered (and should render locked). The
 * `DecisionAnswer.label` is the chosen option (or Other text) when recoverable.
 *
 * `messages` MUST be in chronological order (oldest → newest), matching the
 * order the timeline / reply list is rendered in.
 */
export function decisionAnswersFromMessages(
  messages: readonly DecisionAnswerMessage[],
): Map<string, DecisionAnswer> {
  const answers = new Map<string, DecisionAnswer>();
  const open: OpenCard[] = [];
  const seenQuestionIds = new Set<string>();

  for (const msg of messages) {
    const uid = (msg.fromPersonUid ?? "").trim();
    const isHuman = !isAgentUid(uid);
    const body = (msg.body ?? "").trim();

    // 1. Attempt to answer an open card with this (human) message.
    if (isHuman && body && open.length > 0) {
      const lowered = body.toLowerCase();
      // Prefer an exact option-label match (oldest open card first).
      const matchedIndex = open.findIndex((card) => card.byLabel.has(lowered));
      if (matchedIndex >= 0) {
        const card = open[matchedIndex];
        answers.set(card.questionId, { label: card.byLabel.get(lowered) });
        open.splice(matchedIndex, 1);
      } else {
        // Fall back to the most-recent open card offering free-text Other.
        for (let i = open.length - 1; i >= 0; i -= 1) {
          if (open[i].allowOther) {
            answers.set(open[i].questionId, { label: body });
            open.splice(i, 1);
            break;
          }
        }
      }
    }

    // 2. Register any decision cards this message introduces (after the answer
    //    check so a card is never self-answered). Keyed by questionId; a repeat
    //    of an already-seen or already-answered questionId is ignored.
    const rich = richContentForMessage(msg).rich;
    if (!rich) continue;
    for (const block of rich.blocks) {
      if (block.kind !== "decision") continue;
      const questionId = block.questionId?.trim();
      if (!questionId) continue;
      if (seenQuestionIds.has(questionId)) continue;
      if (answers.has(questionId)) continue;
      seenQuestionIds.add(questionId);
      const byLabel = new Map<string, string>();
      for (const option of block.options) {
        const label = option.label.trim();
        if (label) byLabel.set(label.toLowerCase(), label);
      }
      open.push({ questionId, byLabel, allowOther: block.allowOther });
    }
  }

  return answers;
}
