/**
 * The level-up accomplishment card (usage-only-pricing US-019), through the
 * same notice the badges use when one is earned (badge-announce.ts): the
 * app's one toast layer, the holographic look, a mark in front (here the
 * level's coin in its colours), and it stays until used or dismissed.
 *
 * It names the level, the month that reached it and what the team got done
 * that month, from the statement's meter counts.
 */

import { pushToast } from "../shell/toast-stack.svelte.js";
import UsageLevelMark from "./UsageLevelMark.svelte";
import { levelInfo, levelThresholdText, monthName, teamDoneLine } from "./usage-levels.js";
import { PERSONAL_ACCOUNT_KEY } from "./core-usage-model.js";

export interface UsageLevelCard {
  accountKey: string;
  accountName: string;
  level: number;
  /** "2026-10". */
  month: string;
  counts: Readonly<Record<string, number>> | null;
  /** Opens Settings > Usage on the account; no action when null. */
  onOpen: (() => void) | null;
}

/** The card's words, kept apart so tests and the design harness can read them. */
export function usageLevelCardText(card: Pick<UsageLevelCard, "accountKey" | "accountName" | "level" | "month" | "counts">): {
  title: string;
  detail: string;
} {
  const info = levelInfo(card.level);
  const personal = card.accountKey === PERSONAL_ACCOUNT_KEY;
  const who = personal ? "You" : card.accountName;
  const title = info ? `${who} reached Level ${info.n}: ${info.name}` : `${who} reached a new level`;
  const threshold = info ? levelThresholdText(info.cents) : "";
  // Two meters keep the notice to its two lines.
  const done = teamDoneLine(card.counts, 2);
  const month = monthName(card.month);
  const head = info ? `${month} passed ${threshold}.` : `${month}.`;
  const body = done ? ` ${personal ? "You" : "The team"} did ${done}.` : "";
  return { title, detail: `${head}${body}` };
}

/** Show the card. Returns the toast id. One card per account at a time (keyed). */
export function announceUsageLevel(card: UsageLevelCard): string {
  const { title, detail } = usageLevelCardText(card);
  return pushToast({
    key: `usage-level:${card.accountKey}`,
    kind: "sticky",
    tone: "neutral",
    title,
    detail,
    testId: "usage-level-toast",
    look: "holo",
    lead: { component: UsageLevelMark, props: { level: card.level, size: 30 } },
    actions: card.onOpen
      ? [{ label: "See usage", primary: true, testId: "usage-level-open", onAction: card.onOpen }]
      : [],
  });
}
