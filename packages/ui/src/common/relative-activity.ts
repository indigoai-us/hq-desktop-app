/**
 * Compact relative-time formatting for activity timestamps ("now", "5m", "3h").
 *
 * Extracted from the former `sessions/sessions.ts` when the in-app Sessions
 * feature was removed: project rows, story cards and the story panel format
 * activity times and must keep doing so without the sessions module.
 */

function activityMillis(iso: string): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function relativeActivity(
  iso: string,
  now: number = Date.now(),
): string {
  const then = activityMillis(iso);
  if (then <= 0) return "Not recorded";
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
