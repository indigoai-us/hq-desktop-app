/**
 * Ready-written prompts for the brief's actions.
 *
 * Owner rule: brief actions do not call APIs. Each actionable item hands a
 * context-rich prompt to a coding session (Claude, Codex or Grok) or to the
 * clipboard, and the person runs it there. Every prompt names the item, its
 * company/repo, why it matters and what to check first, and asks the session
 * to stop before anything irreversible.
 */

import type { BriefActionItem, BriefDecision, BriefInput, BriefRisk, BriefWaiting } from "./brief-types.js";

const GUARD =
  "Read what you need first. Stop and confirm with me before any irreversible step (merge, release, publish, deploy, or sending a message).";

function sentence(text: string | undefined | null): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  return /[.?!]$/.test(t) ? t : `${t}.`;
}

function where(repo: string | null | undefined): string {
  return repo ? ` Repo or source: ${repo}.` : "";
}

export function decisionPrompt(d: BriefDecision): string {
  const why = sentence(d.detail?.why);
  const risk = d.detail?.risk ? ` First check: ${sentence(d.detail.risk)}` : "";
  const unlocks = d.detail?.unlocks.length
    ? ` Clearing it unlocks: ${d.detail.unlocks.map((u) => u.label).join("; ")}.`
    : "";
  const source = d.detail?.source ? ` Source: ${sentence(d.detail.source)}` : "";
  const ctx = `${why ? ` ${why}` : ""}${risk}${unlocks}${where(d.origin.repo)}${source}`;
  switch (d.action) {
    case "decide": {
      const options = d.choices ? ` The options are ${d.choices[0]} or ${d.choices[1]}.` : "";
      return `Help me decide: ${sentence(d.title)}${options}${ctx} Lay out the trade-off in a few lines and recommend one. Then make the change for the option I pick. ${GUARD}`;
    }
    case "reply":
      return `${sentence(d.title)}${ctx} Find the message, then draft a short reply in my voice and show it to me. Do not send it. ${GUARD}`;
    case "prep":
      return `Prepare me for: ${sentence(d.title)}${ctx} Summarize what I should know and what to ask, in under ten bullets. ${GUARD}`;
    default:
      return `${sentence(d.title)}${ctx} Walk the steps, run the checks, and get it ready. ${GUARD}`;
  }
}

export function incidentPrompt(r: BriefRisk): string {
  const m = r.measure;
  const measured = m ? ` ${m.total - m.healthy} of ${m.total} ${m.unit} are affected (${m.cause.toLowerCase()}).` : "";
  const links = r.links.length ? ` Fixes in review: ${r.links.map((l) => l.label).join(", ")}.` : "";
  return `Investigate the live incident: ${sentence(r.title)}${measured} ${sentence(r.summary)}${links}${where(r.origin.repo)} Check where each fix stands, what is still broken, and the fastest safe way to recover. Report back before changing anything in production. ${GUARD}`;
}

export function riskPrompt(r: BriefRisk): string {
  return `Look into this risk: ${sentence(r.title)} ${sentence(r.summary)}${where(r.origin.repo)} Tell me how likely it is to bite, and propose the smallest fix. ${GUARD}`;
}

export function waitingPrompt(w: BriefWaiting): string {
  return `I am waiting on ${w.who} ${w.what.replace(/\.$/, "")}. Check the latest state, then draft a short, friendly nudge to ${w.who} in my voice. Do not send it; show me the draft.`;
}

export function actionItemPrompt(a: BriefActionItem): string {
  return `Action item from yesterday: ${sentence(a.title)}${where(a.origin.repo)} Do it, or tell me what is blocking it. ${GUARD}`;
}

/** Prompt per actionable item id, for every item the brief can act on. */
export function briefPrompts(input: BriefInput): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of input.decisions) out[d.id] = d.prompt || decisionPrompt(d);
  for (const r of input.risks) out[r.id] = r.prompt || (r.severity === "incident" ? incidentPrompt(r) : riskPrompt(r));
  for (const w of input.waitingOn) out[w.id] = w.prompt || waitingPrompt(w);
  for (const a of input.actionItems) out[a.id] = actionItemPrompt(a);
  return out;
}
