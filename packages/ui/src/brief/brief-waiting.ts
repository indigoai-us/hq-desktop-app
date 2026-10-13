/**
 * Pure helpers for the Waiting on card: which rows it shows, how long each
 * wait has run, and the day a wait started. Display only; the picker never
 * reads this file, so local-time formatting is fine here.
 */
import type { BriefWaiting } from "./brief-types.js";

export type WaitingKind = NonNullable<BriefWaiting["kind"]>;

/** Rows per slot: S (one column) shows 3; W, W3 and M show 5, then "+N more". */
export const WAITING_ROWS_NARROW = 3;
export const WAITING_ROWS_WIDE = 5;

export function waitingLimit(cols: number): number {
  return cols >= 2 ? WAITING_ROWS_WIDE : WAITING_ROWS_NARROW;
}

/**
 * The rows the card carries. `hideKinds` drops rows another card already
 * shows (handoff rows when the Handoffs card is placed); rows with no kind
 * always stay.
 */
export function waitingRows(waiting: readonly BriefWaiting[], hideKinds: readonly WaitingKind[] = []): BriefWaiting[] {
  if (!hideKinds.length) return [...waiting];
  return waiting.filter((w) => !w.kind || !hideKinds.includes(w.kind));
}

/** "<1h", "20h" under a day, "2d" after; `old` past 24 hours. Null when unknown. */
export function waitingAge(ageHours: number | null | undefined): { label: string; old: boolean } | null {
  if (ageHours == null || !Number.isFinite(ageHours) || ageHours < 0) return null;
  const old = ageHours > 24;
  if (ageHours < 1) return { label: "<1h", old };
  if (ageHours < 24) return { label: `${Math.round(ageHours)}h`, old };
  return { label: `${Math.floor(ageHours / 24)}d`, old };
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The local day a wait started, said the way a person would: "today",
 * "yesterday", a weekday inside the week ("Tue"), else "Sep 28". Null when
 * the age or `now` is unknown.
 */
export function sinceDay(ageHours: number | null | undefined, nowIso: string): string | null {
  if (ageHours == null || !Number.isFinite(ageHours) || ageHours < 0) return null;
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) return null;
  const then = new Date(now.getTime() - ageHours * 3_600_000);
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(then)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return DAYS[then.getDay()]!;
  return `${MONTHS[then.getMonth()]} ${then.getDate()}`;
}

/** What kind of wait it is, for the peek's Source line. Null for unknown kinds. */
export function waitingSource(kind: BriefWaiting["kind"]): string | null {
  switch (kind) {
    case "dm":
      return "A DM you sent that has not been answered.";
    case "review":
      return "Your change, waiting on their review.";
    case "handoff":
      return "A handoff you made that has not been acknowledged.";
    default:
      return null;
  }
}
