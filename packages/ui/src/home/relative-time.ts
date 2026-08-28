/**
 * Relative-time label for Home surfaces. Faithful copy of desktop-alt
 * `route.ts`'s `formatRelativeTime` — the route module itself is desktop
 * shell chrome and intentionally not ported, so the one pure helper Home
 * needs lives here.
 */
export function formatRelativeTime(
  iso: string | null | undefined,
): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
