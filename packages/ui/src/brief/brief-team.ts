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
