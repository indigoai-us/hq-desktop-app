/**
 * Pure helpers for the Resolved card ("Fixed since your last brief"): plain
 * titles, the headline, row order, the mono "when" label, the UTC timeline,
 * the post-incident note prompt, and the peek contents. No toLocale*, no
 * Date.now: `now` is an input, so the picker and the card agree.
 */
import type { PeekContent } from "./brief-context.svelte.js";
import { humanTitle } from "./brief-distill.js";
import { productName } from "./brief-origin.js";
import type { BriefLine, BriefRecovered } from "./brief-types.js";

/** Rows shown before "+N more" in a two-row slot. */
export const RESOLVED_ROWS = 5;
/** Rows shown before "+N more" in a one-row slot. */
export const RESOLVED_ROWS_SHORT = 3;
/** Timeline entries shown before "+N more". */
export const TIMELINE_MAX = 5;

const HOUR_MS = 3_600_000;

export type TimelineEntry = { at: string; text: string };

const sentence = (text: string): string => {
  const t = text.trim();
  if (!t) return "";
  return /[.?!]$/.test(t) ? t : `${t}.`;
};

/** A title as the owner reads it: no "repo #123:" reference, no commit prefix, sentence case. */
export function plainTitle(title: string): string {
  return humanTitle(title).text;
}

/** How many rows a slot shows before "+N more". */
export function resolvedCap(rows: number): number {
  return rows > 1 ? RESOLVED_ROWS : RESOLVED_ROWS_SHORT;
}

/** Newest first; unknown times last; ties by id so the order is stable. */
export function orderRecovered(recovered: readonly BriefRecovered[]): BriefRecovered[] {
  const ms = (r: BriefRecovered): number => {
    const t = r.at ? Date.parse(r.at) : NaN;
    return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
  };
  return [...recovered].sort((a, b) => ms(b) - ms(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The h3: the one title as a sentence, or "N things recovered". */
export function resolvedHeadline(recovered: readonly BriefRecovered[]): string {
  if (recovered.length === 1) return sentence(plainTitle(recovered[0]!.title));
  return `${recovered.length} things recovered`;
}

/** "just now", "5h ago", "2 days ago"; null when the time is unknown. */
export function agoLabel(at: string | null | undefined, now: string): string | null {
  if (!at) return null;
  const t = Date.parse(at);
  const n = Date.parse(now);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return null;
  const hours = (n - t) / HOUR_MS;
  if (hours < 1) return "just now";
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** "01:36 UTC"; null when the time is unknown. Machine-timezone independent. */
export function utcClock(at: string | null | undefined): string | null {
  if (!at) return null;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return null;
  return `${new Date(t).toISOString().slice(11, 16)} UTC`;
}

/** Where the recovery was seen, in plain words. */
export function sourceLabel(source: BriefRecovered["source"]): string {
  switch (source) {
    case "main_health":
      return "main CI";
    case "fleet":
      return "the fleet";
    default:
      return "your sessions";
  }
}

/** The timeline oldest first (unknown times keep their place at the end), split at TIMELINE_MAX. */
export function timelineOf(r: BriefRecovered): { shown: TimelineEntry[]; rest: TimelineEntry[] } {
  const entries = [...(r.timeline ?? [])]
    .map((e, i) => ({ e, i, t: Date.parse(e.at) }))
    .sort((a, b) => {
      const af = Number.isFinite(a.t);
      const bf = Number.isFinite(b.t);
      if (af && bf) return a.t - b.t || a.i - b.i;
      if (af !== bf) return af ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.e);
  return { shown: entries.slice(0, TIMELINE_MAX), rest: entries.slice(TIMELINE_MAX) };
}

/** A stretch of time as a big number with small units: 4h 51m, 38m, 2d 3h. */
export type DurationPart = { n: string; u: string };

/** Minutes under an hour, hours and minutes under two days, then days and hours; zero parts are dropped. */
export function durationParts(ms: number): DurationPart[] {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return [{ n: String(mins), u: "m" }];
  const hours = Math.floor(mins / 60);
  if (hours < 48) {
    const m = mins % 60;
    return m ? [{ n: String(hours), u: "h" }, { n: String(m), u: "m" }] : [{ n: String(hours), u: "h" }];
  }
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? [{ n: String(d), u: "d" }, { n: String(h), u: "h" }] : [{ n: String(d), u: "d" }];
}

/** The duration as one string: "4h 51m". */
export function durationLabel(ms: number): string {
  return durationParts(ms)
    .map((p) => `${p.n}${p.u}`)
    .join(" ");
}

/** The fraction of the track the outage takes: in proportion to the time, but never so thin or so wide that a label cannot sit. */
export const SPLIT_MIN = 0.3;
export const SPLIT_MAX = 0.6;
/** Where the fix sits on the track when the outage start is unknown. */
export const SPLIT_UNKNOWN = 0.42;

/**
 * The recovery as a track: red from the first timeline entry to the fix,
 * green from the fix to `now`. The fix is the last timed timeline entry
 * when there are at least two (the first is when it broke), otherwise the
 * item's own time. Durations are null when a side is unknown; `marks` are
 * the timeline entries between the break and the fix, as track fractions.
 */
export interface RecoverySpan {
  brokeAt: string | null;
  fixedAt: string | null;
  downMs: number | null;
  upMs: number | null;
  /** 0..1: where the fix sits on the track. */
  split: number;
  marks: number[];
}

export function recoverySpan(r: BriefRecovered, now: string): RecoverySpan {
  const timed = timelineOf(r)
    .shown.concat(timelineOf(r).rest)
    .map((e) => ({ e, t: Date.parse(e.at) }))
    .filter((x) => Number.isFinite(x.t));
  const n = Date.parse(now);
  const own = r.at ? Date.parse(r.at) : NaN;
  const known = timed.length >= 2;
  const broke = known ? timed[0]! : null;
  const fixed = known ? timed.at(-1)! : null;
  const fixT = fixed ? fixed.t : own;
  const fixedAt = fixed ? fixed.e.at : Number.isFinite(own) ? r.at! : null;
  const downMs = broke && fixed && fixed.t > broke.t ? fixed.t - broke.t : null;
  const upMs = Number.isFinite(fixT) && Number.isFinite(n) && n >= fixT ? n - fixT : null;
  let split = SPLIT_UNKNOWN;
  if (downMs !== null && upMs !== null) split = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, downMs / (downMs + upMs)));
  else if (downMs !== null) split = SPLIT_MAX;
  const marks =
    broke && fixed && downMs
      ? timed.slice(1, -1).map((x) => Math.round(((x.t - broke.t) / downMs) * split * 1000) / 1000)
      : [];
  return { brokeAt: broke ? broke.e.at : null, fixedAt, downMs, upMs, split, marks };
}

/** "06:27"; the clock without the zone, for track labels under a caption that names UTC. */
export function utcHm(at: string | null | undefined): string | null {
  return utcClock(at)?.slice(0, 5) ?? null;
}

/** One timeline entry as a peek line: the text, the UTC clock on the right; the last entry reads green. */
export function timelineLine(e: TimelineEntry, last: boolean): BriefLine {
  return { label: e.text, state: utcClock(e.at) ?? "", tone: last ? "ok" : "neutral" };
}

/** The prompt that drafts the post-incident note. It shows a draft and sends nothing. */
export function postIncidentNotePrompt(r: BriefRecovered): string {
  const product = productName(r.origin.repo, r.origin.product);
  const all = [...timelineOf(r).shown, ...timelineOf(r).rest];
  const timeline = all.length ? ` Timeline (UTC): ${all.map((e) => `${utcClock(e.at) ?? "unknown time"} ${e.text.replace(/\.$/, "")}`).join("; ")}.` : "";
  const pi = r.postIncident ? ` What broke: ${sentence(r.postIncident.broke)} What we did: ${sentence(r.postIncident.did)} What changes: ${sentence(r.postIncident.changes)}` : "";
  return `Write the post-incident note for: ${sentence(plainTitle(r.title))} ${sentence(r.what)} Product: ${product}.${timeline}${pi} Cover what broke, what we did, and what changes, in plain English under 200 words. Show me the draft; do not post or send it.`;
}

/** A recovered item's peek: timeline, evidence, post-incident lines when written, and the note prompt. */
export function recoveredPeek(r: BriefRecovered, prompt: string | undefined, now: string): PeekContent {
  const sections: PeekContent["sections"] = [];
  const tl = timelineOf(r);
  const all = [...tl.shown, ...tl.rest];
  if (all.length) sections.push({ label: "Timeline", lines: all.map((e, i) => timelineLine(e, i === all.length - 1)) });
  if (r.what.trim()) sections.push({ label: "Evidence", text: r.what });
  if (r.postIncident) {
    sections.push({ label: "What broke", text: r.postIncident.broke });
    sections.push({ label: "What we did", text: r.postIncident.did });
    sections.push({ label: "What changes", text: r.postIncident.changes });
  }
  const ago = agoLabel(r.at, now);
  return {
    title: plainTitle(r.title),
    status: [productName(r.origin.repo, r.origin.product), sourceLabel(r.source), ago ? `fixed ${ago}` : null].filter(Boolean).join(" · "),
    sections,
    prompt: { id: r.id, text: prompt ?? postIncidentNotePrompt(r) },
  };
}

/** The "+N more" row's peek: every row past the cap. */
export function moreRecoveredPeek(rest: readonly BriefRecovered[], now: string): PeekContent {
  return {
    title: `${rest.length} more recovered`,
    status: "Fixed since your last brief",
    sections: [
      {
        label: "Also fixed",
        lines: rest.map((r) => ({ label: plainTitle(r.title), state: agoLabel(r.at, now) ?? productName(r.origin.repo, r.origin.product), tone: "ok" as const })),
      },
    ],
  };
}

/** The timeline's "+N more" peek: the entries past TIMELINE_MAX. */
export function moreTimelinePeek(r: BriefRecovered): PeekContent {
  const { rest } = timelineOf(r);
  return {
    title: `${rest.length} more in the timeline`,
    status: plainTitle(r.title),
    sections: [{ label: "Then", lines: rest.map((e, i) => timelineLine(e, i === rest.length - 1)) }],
  };
}
