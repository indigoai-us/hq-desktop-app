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
