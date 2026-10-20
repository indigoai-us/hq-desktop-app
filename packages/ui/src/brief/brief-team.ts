/**
 * Pure helpers for the Team card: how many rows a slot shows, the work-level
 * status line (the writer's words first, then the latest DM, never a PR
 * number), the footer, and the thank-you prompt.
 */
import { humanTitle } from "./brief-distill.js";
import { previewLine } from "./brief-dms.js";
import type { BriefTeammate } from "./brief-types.js";

/** Rows per slot: M (two rows) and W3 (three columns) show 5; W shows 3; then "+N more". */
export function teamLimit(rows: number, cols: number): number {
  return rows > 1 || cols >= 3 ? 5 : 3;
}

/**
 * Lines the adapter writes when it knows nothing about the work: the DM
 * preview beats these. Anything else is the writer's work-level status.
 */
const GENERIC = new Set(["agent", "messaged you", "talked with you yesterday", "you are waiting on a reply"]);

export function isGenericStatus(text: string): boolean {
  return GENERIC.has(text.trim().toLowerCase().replace(/[.!]+$/, ""));
}

/** "hq-core #1217: ..." or "#1217 - ...": a leading reference humanTitle knows how to drop. */
const LEADING_REF = /^(?:[\w.-]+\/)?[\w.-]*\s*#\d+\s*[:\-–—]\s+/;
const CONVENTIONAL = /^(feat|fix|docs?|chore|ci|build|refactor|test|perf|style|revert|promote)(\([^)]*\))?!?:\s*/i;
/** Several PRs named together: "PRs 12 and 13", "#88, #89". */
const MANY_PRS = /\b(?:PRs|MRs|pull requests)\s*#?\d+(?:\s*(?:,|and|&|\/)\s*#?\d+)+|#\d+(?:\s*(?:,|and|&|\/)\s*#\d+)+/gi;
/** One PR: "PR 1201", "pull request #7", "#88". */
const ONE_PR = /\b(?:PR|MR|pull request)\s*#?\d+\b|#\d+\b/gi;

/**
 * A status a person reads: no PR or issue numbers, no conventional-commit
 * prefix, sentence case. "PR 1201 in review" -> "A change in review".
 */
export function plainStatus(text: string): string {
  let t = text.trim().replace(/\s+/g, " ");
  // humanTitle drops a leading "<repo> #<n>:" and a commit prefix; it is only
  // safe when the text starts that way (it would read "Landed #88" as a repo).
  if (LEADING_REF.test(t) || CONVENTIONAL.test(t)) t = humanTitle(t).text;
  t = t
    .replace(MANY_PRS, "changes")
    .replace(ONE_PR, "a change")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/**
 * The row's line: the writer's `doing` (brief.json people status) when it says
 * something, else the latest DM to you, else the adapter's generic line.
 */
export function teamStatus(t: BriefTeammate, latestDm: string | null, max = 56): { text: string; fromDm: boolean } {
  const writer = t.doing.trim();
  if (writer && !isGenericStatus(writer)) return { text: plainStatus(writer), fromDm: false };
  if (latestDm?.trim()) return { text: previewLine(latestDm, max), fromDm: true };
  return { text: plainStatus(writer), fromDm: false };
}

/** Short mono tag for the tone, for the "+N more" peek. */
export function toneTag(tone: BriefTeammate["tone"]): string {
  return tone === "decision" ? "NEEDS YOU" : tone === "warn" ? "YOU WAIT" : "";
}

/** "5 people · 1 agent · 2 need you"; the agents segment only when there are any. */
export function teamFooter(team: readonly BriefTeammate[]): string {
  const agents = team.filter((t) => t.isAgent).length;
  const people = team.length - agents;
  const need = team.filter((t) => t.tone === "decision").length;
  const parts = [`${people} ${people === 1 ? "person" : "people"}`];
  if (agents) parts.push(`${agents} agent${agents === 1 ? "" : "s"}`);
  parts.push(`${need} need${need === 1 ? "s" : ""} you`);
  return parts.join(" · ");
}

/** The prompt behind "Say thanks": draft the note, show it, send only on confirmation. */
export function thanksPrompt(t: BriefTeammate): string {
  const who = t.isAgent ? `${t.name} (an AI agent)` : t.name;
  const why = (t.thanks ?? "").trim().replace(/[.!]+$/, "");
  const forWhat = why ? ` for this: ${why}.` : ".";
  return (
    `Draft a short thank-you DM to ${who} in my voice${forWhat} ` +
    `Two or three sentences, specific about what they did. Show me the draft and wait for my confirmation; ` +
    `send it with hq dm only after I say yes. Do not send anything before that.`
  );
}

/** What a teammate's row is about, by what it asks of you: they need you, you wait on them, or they are on it. */
export type TeamGroupKey = "need" | "wait" | "on";

export const TEAM_GROUP_LABEL: Record<TeamGroupKey, string> = { need: "Needs you", wait: "You're waiting", on: "On it" };

export function teamGroup(tone: BriefTeammate["tone"]): TeamGroupKey {
  return tone === "decision" ? "need" : tone === "warn" ? "wait" : "on";
}

/**
 * The card's order: who needs you, then who you wait on, then everyone else
 * with a thank-you due first. Stable, so the writer's order holds within a group.
 */
export function teamOrder<T extends BriefTeammate>(team: readonly T[]): T[] {
  const rank = (t: BriefTeammate) => {
    const g = teamGroup(t.tone);
    return g === "need" ? 0 : g === "wait" ? 1 : t.thanks ? 2 : 3;
  };
  return team.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map((x) => x.t);
}

/** Consecutive rows of one group under one label (rows come in teamOrder). */
export function teamGroups<T extends BriefTeammate>(rows: readonly T[]): { key: TeamGroupKey; label: string; rows: T[] }[] {
  const out: { key: TeamGroupKey; label: string; rows: T[] }[] = [];
  for (const t of rows) {
    const key = teamGroup(t.tone);
    const last = out[out.length - 1];
    if (last?.key === key) last.rows.push(t);
    else out.push({ key, label: TEAM_GROUP_LABEL[key], rows: [t] });
  }
  return out;
}

/**
 * The card's lead: one count and a two-line caption. Who needs you when
 * anyone does; else who you are waiting on; else how many are active. The
 * second line puts the count against the team (the rows and circles name them).
 */
export function teamHero(team: readonly BriefTeammate[]): { n: number; key: TeamGroupKey | "all"; line: string; sub: string } {
  const of = `of ${team.length} on the team`;
  const need = team.filter((t) => teamGroup(t.tone) === "need").length;
  if (need) return { n: need, key: "need", line: need === 1 ? "needs you" : "need you", sub: of };
  const wait = team.filter((t) => teamGroup(t.tone) === "wait").length;
  if (wait) return { n: wait, key: "wait", line: "you're waiting on", sub: of };
  return { n: team.length, key: "all", line: "on the team", sub: "Nobody waiting on you" };
}

/**
 * The row's second line, with the adapter's filler replaced by something
 * real: the writer's status, else the latest DM, else what they owe you or
 * the win worth a thank-you; empty when there is nothing to say (the row
 * then shows the name alone, never "Agent" or "Messaged you").
 */
export function teamLine(t: BriefTeammate, latestDm: string | null, max = 56): { text: string; fromDm: boolean } {
  const s = teamStatus(t, latestDm, max);
  if (s.fromDm || (s.text && !isGenericStatus(s.text))) return s;
  const owes = t.owes?.find((o) => o.trim());
  if (owes) return { text: `Owes you: ${owes.trim()}`, fromDm: false };
  const thanks = t.thanks?.trim().replace(/[.!]+$/, "");
  if (thanks) return { text: plainStatus(thanks), fromDm: false };
  return { text: "", fromDm: false };
}

