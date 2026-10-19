/** Time helpers for the brief's calendar views. */

export const KIND_COLOR = { team: "#4a5260", ext: "#14b8a6", learn: "#ffb580" } as const;

/** "9 AM", "1:15 PM" in local time. */
export function clockLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, "0")} ${ap}` : `${h12} ${ap}`;
}

/** Fractional local hour of an ISO time. */
export function hourOf(iso: string): number {
  const d = new Date(iso);
  return d.getHours() + d.getMinutes() / 60;
}

export type PartOfDay = "Morning" | "Afternoon" | "Evening";

/**
 * The greeting's word for a local time: Morning from 5 AM, Afternoon from
 * noon, Evening from 5 PM until 5 AM. The page greets by the clock the person
 * reads it at, not the time the brief was written.
 */
export function partOfDay(d: Date): PartOfDay {
  const h = d.getHours();
  if (h >= 5 && h < 12) return "Morning";
  if (h >= 12 && h < 17) return "Afternoon";
  return "Evening";
}
