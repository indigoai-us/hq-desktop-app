/**
 * The first view's own words, kept apart from the model in
 * brief-first-view.ts: the pills' captions, the connect rows' statuses and
 * the watch list's clean-up of zero counts.
 */
import type { FirstView, FirstViewAiApp } from "./brief-first-view.js";
import type { WelcomeAction } from "./brief-welcome-contract.js";

export const FV_FOUND = "Found on this Mac";
export const FV_NOT_CONNECTED = "Not connected yet";
export const FV_CONNECTED = "Connected";
export const FV_QUIET_LINE = "Your HQ is ready. The sun's up.";

/** "A", "A and B", "A, B, and C". */
function listOf(names: readonly string[]): string {
  if (names.length < 3) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** The sunrise's line under the quiet line: what HQ read, never what is owed. */
export function firstViewSub(fv: FirstView): string {
  const tools = fv.whereYouWork.tools.map((t) => t.name);
  return tools.length ? `HQ read your ${listOf(tools)} sessions.` : "HQ is set up on this Mac.";
}

export interface FirstViewStat {
  key: "sessions" | "days" | "projects" | "tools";
  label: string;
  n: number;
  caption: string;
}

/** The greeting row's pills; a pill with no number (or zero) stays out. */
export function firstViewStats(fv: FirstView): FirstViewStat[] {
  const tools = fv.whereYouWork.tools.map((t) => t.name);
  const p = fv.pills;
  const all: (FirstViewStat | null)[] = [
    p.sessions ? { key: "sessions", label: "Sessions", n: p.sessions, caption: tools.length ? `in ${listOf(tools)}` : "found on this Mac" } : null,
    p.days ? { key: "days", label: "Days", n: p.days, caption: "of work found" } : null,
    p.projects ? { key: "projects", label: "Projects", n: p.projects, caption: fv.topProjects.length ? "most active below" : "found on this Mac" } : null,
    p.tools ? { key: "tools", label: "Tools", n: p.tools, caption: tools.length ? tools.join(", ") : "found on this Mac" } : null,
  ];
  return all.filter((s): s is FirstViewStat => !!s);
}

/** A found harness (it has sessions here) is never offered Connect. */
export const aiAppFound = (a: FirstViewAiApp): boolean => a.sessions > 0;

/** Drops "0 companies"-style clauses from a sentence; empty when nothing is left. */
export function withoutZeroCounts(text: string): string {
  return text
    .replace(/(?:,\s*|\s+(?:and|or|across|in|with)\s+)?\b0\s+[A-Za-z][\w-]*/g, "")
    .replace(/^\s*(?:and|or|,)\s*/i, "")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/,\s*\./g, ".")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^(?:[,.;:]\s*)+$/, "");
}

/** A reason that reads as machine output (an error code, a path, a traceback) is dropped, never shown. */
export function plainReason(text: string): string {
  const t = text.trim();
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+:/i.test(t) || /(?:^|\s)[~.]?\/\S/.test(t) || /\bTraceback\b|\b[A-Z][a-z]+Error\b/.test(t)) return "";
  return t;
}

/** The watch list as shown: no zero counts in a label or reason, and no row left without a label. */
export function firstViewWatch(list: readonly WelcomeAction[]): WelcomeAction[] {
  return list.flatMap((a) => {
    const label = withoutZeroCounts(a.label);
    return label ? [{ ...a, label, reason: withoutZeroCounts(plainReason(a.reason)) }] : [];
  });
}

/** "12 min ago", "3 h ago", "Yesterday", "4 days ago". */
export function firstViewAgo(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const h = Math.max(0, now.getTime() - t) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 24) return `${Math.round(h)} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "Yesterday" : `${d} days ago`;
}
