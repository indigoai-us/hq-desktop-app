/**
 * Distills the last 24 hours of sessions for the sunrise card: drops
 * background maintenance sessions the user did not start, then buckets the
 * rest by hour so a busy day reads as a shape instead of a pile of dots.
 */

export interface TimelineSession {
  at: string;
  title: string;
}

export interface TimelineBucket {
  /** Start of the hour (ms). */
  start: number;
  count: number;
  /** Up to three titles, newest first, for the hover label. */
  titles: string[];
}

export interface Timeline {
  buckets: TimelineBucket[];
  /** Sessions kept after dropping background ones. */
  work: number;
  /** Background sessions dropped. */
  background: number;
  /** Newest kept session, for the one visible label. */
  latest: TimelineSession | null;
}

const HOUR = 3600_000;

/** Sessions HQ starts on its own: checkpoint siblings, auto-checkpoints, resume relaunches. */
const BACKGROUND = [/checkpoint sibling/i, /background maintenance/i, /^auto[- ]?checkpoint/i, /^\s*auto:/i];

export function isBackgroundSession(title: string): boolean {
  return BACKGROUND.some((re) => re.test(title));
}

export function distillTimeline(sessions: readonly TimelineSession[], nowIso: string, hours = 24): Timeline {
  const end = Date.parse(nowIso);
  const start = end - hours * HOUR;
  const buckets: TimelineBucket[] = Array.from({ length: hours }, (_, i) => ({ start: start + i * HOUR, count: 0, titles: [] }));
  let background = 0;
  let latest: TimelineSession | null = null;
  const kept = [...sessions].sort((a, b) => b.at.localeCompare(a.at));
  for (const s of kept) {
    const t = Date.parse(s.at);
    if (!(t > start && t <= end)) continue;
    if (isBackgroundSession(s.title)) {
      background += 1;
      continue;
    }
    latest ??= s;
    const b = buckets[Math.min(hours - 1, Math.floor((t - start) / HOUR))]!;
    b.count += 1;
    if (b.titles.length < 3) b.titles.push(s.title);
  }
  return { buckets, work: buckets.reduce((n, b) => n + b.count, 0), background, latest };
}
