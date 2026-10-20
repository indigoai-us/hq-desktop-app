/**
 * Pure helpers for the Ownership moved card: which handoffs landed (access,
 * acknowledgment, first activity), which wait on the owner's acknowledgment,
 * how the rows rank, and the words the card and its peeks use. No Date.now,
 * no Math.random, no toLocale*: `now` is an input.
 */
import type { PeekContent } from "./brief-context.svelte.js";
import { productName } from "./brief-origin.js";
import type { BriefHandoff, BriefLine, BriefTone } from "./brief-types.js";

/** Rows on the card before the "+N more" row. */
export const HANDOFF_ROWS = 5;
/** Rows on a one-row card. */
export const HANDOFF_ROWS_SHORT = 3;
/** Rows on a one-row, one-column card, where each row takes two lines. */
export const HANDOFF_ROWS_NARROW = 1;
/** A missing receipt turns amber past this many hours. */
export const HANDOFF_OVERDUE_HOURS = 24;
const HOUR_MS = 3_600_000;

export type ReceiptKey = keyof BriefHandoff["receipts"];
export type ReceiptState = "done" | "missing" | "unknown";

/** The three receipts, in the order the card shows them. */
export const RECEIPTS: readonly { key: ReceiptKey; label: string }[] = [
  { key: "access", label: "Access" },
  { key: "ack", label: "Ack" },
  { key: "active", label: "Active" },
];

/** true = done, false = missing, null = unknown (never shown as done). */
export const receiptState = (v: boolean | null): ReceiptState => (v === true ? "done" : v === false ? "missing" : "unknown");

/** Every receipt is in. */
export const landed = (h: BriefHandoff): boolean => RECEIPTS.every((r) => h.receipts[r.key] === true);

/** The receiver acknowledged it: the arrow turns solid. */
export const acked = (h: BriefHandoff): boolean => h.receipts.ack === true;

/** The owner receives it and has not acknowledged. */
export const needsMyAck = (h: BriefHandoff): boolean => h.me && !acked(h);

/** Hours from `iso` to `now`, never negative; null when either is unreadable. */
export function hoursSince(iso: string, now: string): number | null {
  const a = Date.parse(iso);
  const b = Date.parse(now);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, (b - a) / HOUR_MS);
}

export const overdue = (h: BriefHandoff, now: string): boolean => (hoursSince(h.since, now) ?? 0) > HANDOFF_OVERDUE_HOURS;

/** Amber ring: a receipt that is not done on a row that is overdue or in production. */
export const receiptHot = (h: BriefHandoff, key: ReceiptKey, now: string): boolean =>
  h.receipts[key] !== true && (h.production || overdue(h, now));

/** "under an hour", "6h", "2 days"; "" when unknown. */
export function ageText(hours: number | null): string {
  if (hours == null || !Number.isFinite(hours)) return "";
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)} days`;
}

/** First letter of a name for its monogram tile. */
export const initial = (name: string): string => (name.trim()[0] ?? "?").toUpperCase();

/**
 * Row order: handoffs the owner must acknowledge first (production before the
 * rest), then other production handoffs, then everything still in the air by
 * age (oldest first), then landed rows. Ties break on id. Pure and stable.
 */
export function rankHandoffs(list: readonly BriefHandoff[], now: string): BriefHandoff[] {
  const tier = (h: BriefHandoff): number =>
    landed(h) ? 4 : needsMyAck(h) && h.production ? 0 : needsMyAck(h) ? 1 : h.production ? 2 : 3;
  const age = (h: BriefHandoff) => hoursSince(h.since, now) ?? 0;
  return [...list].sort((a, b) => tier(a) - tier(b) || age(b) - age(a) || a.id.localeCompare(b.id));
}

export const landedCount = (list: readonly BriefHandoff[]): number => list.filter(landed).length;

/**
 * The card's title: "1 handoff is yours to acknowledge" while any waits on
 * the owner; "All N handoffs landed" when every one is in (only shown because
 * at least one happened in the window); else "N handoffs · M landed".
 */
export function handoffHeadline(list: readonly BriefHandoff[]): string {
  if (!list.length) return "";
  const mine = list.filter(needsMyAck).length;
  if (mine) return `${mine} handoff${mine === 1 ? " is" : "s are"} yours to acknowledge`;
  const done = landedCount(list);
  const n = list.length;
  if (done === n) return n === 1 ? "1 handoff landed" : `All ${n} handoffs landed`;
  return `${n} handoff${n === 1 ? "" : "s"} · ${done} landed`;
}

/** One row's state in words, with its tone. */
export function handoffStatus(h: BriefHandoff, now: string): { text: string; tone: BriefTone } {
  if (landed(h)) return { text: "Landed", tone: "ok" };
  if (needsMyAck(h)) return { text: "Yours to acknowledge", tone: "warn" };
  const age = ageText(hoursSince(h.since, now));
  return { text: `In the air${age ? ` · ${age}` : ""}`, tone: h.production || overdue(h, now) ? "warn" : "neutral" };
}

/** Built-in prompt for acknowledging a handoff the owner received. */
export function ackPrompt(h: BriefHandoff): string {
  const where = h.production ? " It is live in production." : "";
  return `Acknowledge the handoff of ${h.object} from ${h.from}.${where} Confirm I own it now, check that I have access, and list the first three things to do. Do not message anyone.`;
}

/** Built-in prompt for nudging a receiver who has not acknowledged. The draft is shown, never sent. */
export function nudgePrompt(h: BriefHandoff): string {
  const live = h.production ? " (it is live in production)" : "";
  return `Draft a short, friendly DM to ${h.to} in my voice asking them to acknowledge the ${h.object} handoff from ${h.from}${live}. Do not send it; show me the draft.`;
}

/** The row's prompt: the brief run's, then the item's own, then a built-in one. Landed rows have no action. */
export function promptFor(h: BriefHandoff, prompts: Readonly<Record<string, string>>): string | undefined {
  if (landed(h)) return undefined;
  return prompts[h.id] ?? h.prompt ?? (h.me ? ackPrompt(h) : nudgePrompt(h));
}

/** Receipt lines for a peek: DONE in green, MISSING amber when hot, UNKNOWN grey. */
export function receiptLines(h: BriefHandoff, now: string): BriefLine[] {
  return RECEIPTS.map((r) => {
    const s = receiptState(h.receipts[r.key]);
    const tone: BriefTone = s === "done" ? "ok" : receiptHot(h, r.key, now) ? "warn" : "neutral";
    return { label: r.label, state: s.toUpperCase(), tone };
  });
}

/** A handoff's peek: giver and receiver, the receipts, the production flag, the giver's note, and the prompt. */
export function handoffPeek(h: BriefHandoff, prompt: string | undefined, now: string): PeekContent {
  const st = handoffStatus(h, now);
  const age = ageText(hoursSince(h.since, now));
  const sections: PeekContent["sections"] = [{ label: "Receipts", lines: receiptLines(h, now) }];
  if (h.production) sections.push({ label: "Production", tone: "warn", text: `${h.object} is live in production.` });
  if (h.note) sections.push({ label: `From ${h.from}`, text: h.note });
  return {
    eyebrow: `Handoff · ${h.from} → ${h.to}${age ? ` · ${age} ago` : ""}`,
    origin: { companyUid: h.origin.companyUid, label: productName(h.origin.repo, h.origin.product) },
    title: h.object,
    status: st.text,
    sections,
    prompt: prompt ? { id: h.id, text: prompt, verb: h.me ? "Acknowledge" : "Start" } : undefined,
  };
}

/** The "+N more" row's peek: the rest of the list with each row's state. */
export function moreHandoffsPeek(rest: readonly BriefHandoff[], now: string): PeekContent {
  return {
    title: `${rest.length} more handoff${rest.length === 1 ? "" : "s"}`,
    status: "Also moved in the window",
    sections: [
      {
        label: "Handoffs",
        lines: rest.map((h) => {
          const st = handoffStatus(h, now);
          return { label: `${h.object} · ${h.from} → ${h.to}`, state: st.text.toUpperCase(), tone: st.tone };
        }),
      },
    ],
  };
}
