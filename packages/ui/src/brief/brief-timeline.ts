/**
 * Distills the last 24 hours of sessions for the sunrise card: drops
 * background maintenance sessions the user did not start, then buckets the
 * rest by hour so a busy day reads as a shape instead of a pile of dots.
 */

import type { PeekContent } from "./brief-context.svelte.js";

export interface TimelineSession {
  at: string;
  title: string;
  id?: string;
  /** Company uid or slug the session ran in. */
  company?: string | null;
}

/**
 * A session that belongs on the sunrise strip: one you started ("you"; rows
 * with no kind are older records of yours), with a company or a title.
 * Untitled shells with no company are background noise.
 */
export function isTimelineSession(s: { kind?: string; company?: string | null; title?: string | null }): boolean {
  return (s.kind ?? "you") === "you" && !!(s.company?.trim() || s.title?.trim());
}

/** "Since yesterday" when the window starts the day before `nowIso`, else "Since Oct 4". */
export function sinceLabel(fromDay: string, nowIso: string): string {
  const from = new Date(`${fromDay}T12:00:00`);
  if (Number.isNaN(from.getTime())) return "Yesterday";
  const now = new Date(nowIso);
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime() - from.getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Since yesterday";
  return `Since ${from.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
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
  /** Kept sessions, oldest first: one dot each. */
  items: TimelineSession[];
}

const HOUR = 3600_000;

/**
 * The hover card for a session dot, as in the approved mockup: eyebrow
 * "Session · Oct 8", the company chip, the title, "4:07 PM · session 5 of 8",
 * and two buttons, Resume in <engine> and Copy prompt. The prompt text itself
 * is not shown. An empty title reads "Untitled session".
 */
export function sessionPeek(s: TimelineSession, index: number, total: number): PeekContent {
  const at = new Date(s.at);
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const day = at.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const title = s.title.trim() || "Untitled session";
  const named = s.title.trim() ? `my session "${title}"` : "my untitled session";
  return {
    compact: true,
    eyebrow: `Session · ${day}`,
    origin: { companyUid: s.company ?? null, label: "sessions" },
    title,
    status: `${time} · session ${index + 1} of ${total}`,
    sections: [],
    prompt: {
      id: `session:${s.id ?? s.at}`,
      verb: "Resume",
      text: `Pick up where ${named} (started ${time}${s.id ? `, id ${s.id}` : ""}) left off. Read its last state, tell me in two lines where it stopped, then continue.`,
    },
  };
}

/** Sessions HQ starts on its own: checkpoint siblings, auto-checkpoints, resume relaunches. */
const BACKGROUND = [
  /checkpoint sibling/i,
  /background maintenance/i,
  /^auto[- ]?checkpoint/i,
  /^\s*auto:/i,
  // Probe and health-check sessions ("Reply only OK. Do not use tools.").
  /^reply (only|with) ok\b/i,
  /\bdo not use tools\b/i,
];

export function isBackgroundSession(title: string): boolean {
  return BACKGROUND.some((re) => re.test(title));
}

export function distillTimeline(sessions: readonly TimelineSession[], nowIso: string, hours = 24): Timeline {
  const end = Date.parse(nowIso);
  const start = end - hours * HOUR;
  const buckets: TimelineBucket[] = Array.from({ length: hours }, (_, i) => ({ start: start + i * HOUR, count: 0, titles: [] }));
  let background = 0;
  let latest: TimelineSession | null = null;
  const items: TimelineSession[] = [];
  const kept = [...sessions].sort((a, b) => b.at.localeCompare(a.at));
  for (const s of kept) {
    const t = Date.parse(s.at);
    if (!(t > start && t <= end)) continue;
    if (isBackgroundSession(s.title)) {
      background += 1;
      continue;
    }
    latest ??= s;
    items.push(s);
    const b = buckets[Math.min(hours - 1, Math.floor((t - start) / HOUR))]!;
    b.count += 1;
    if (b.titles.length < 3) b.titles.push(s.title);
  }
  return { buckets, work: buckets.reduce((n, b) => n + b.count, 0), background, latest, items: items.reverse() };
}
