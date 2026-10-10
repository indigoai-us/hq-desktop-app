/**
 * Peek contents shared by several cards (Needs you, the incident, Yesterday,
 * Today's priorities), and the priorities list itself. Pure.
 */
import type { PeekContent } from "./brief-context.svelte.js";
import type { BriefDecision, BriefInput, BriefMeeting, BriefPriority, BriefRisk } from "./brief-types.js";

/** Lines per peek section for meetings: past three the peek stops being a glance. */
const MEETING_LINES = 3;

/** A decision's peek: why, what clearing it unlocks, and its prompt. */
export function decisionPeek(d: BriefDecision, prompt: string | undefined): PeekContent {
  const sections: PeekContent["sections"] = [];
  if (d.detail?.why) sections.push({ label: "Why it matters", text: d.detail.why });
  if (d.detail?.unlocks.length) sections.push({ label: "Clearing it unlocks", lines: d.detail.unlocks });
  if (d.detail?.risk) sections.push({ label: "Watch", tone: "warn", text: d.detail.risk });
  return {
    sample: d.sample,
    title: d.title,
    status: d.detail?.source ?? d.summary,
    sections,
    prompt: prompt ? { id: d.id, text: prompt } : undefined,
  };
}

/** A risk or incident's peek: summary, fixes in review, and its prompt. */
export function riskPeek(risk: BriefRisk, prompt: string | undefined): PeekContent {
  return {
    sample: risk.sample,
    title: risk.ci?.workflow ?? risk.title,
    status: risk.summary,
    sections: risk.links.length ? [{ label: "Fixes in review", lines: risk.links.map((l) => ({ label: l.label, state: "REVIEW", tone: "warn" as const })) }] : [],
    prompt: prompt ? { id: risk.id, text: prompt } : undefined,
  };
}

/** The prompt that starts one of your own meeting to-dos. */
export function todoPrompt(meeting: string, text: string): string {
  return `Do this action item from ${meeting}: ${text}. Check HQ for context first.`;
}

/**
 * What a meeting left you to act on: up to three decisions, up to three
 * to-dos with yours first (tagged "you", each with Start and Copy prompt),
 * and "+N more in Meetings" only when there is more.
 */
export function meetingPeek(m: BriefMeeting, actions: PeekContent["actions"] = []): PeekContent {
  const sections: PeekContent["sections"] = [];
  const decided = m.decided ?? [];
  const todo = [...(m.todo ?? [])].sort((a, b) => Number(!!b.mine) - Number(!!a.mine));
  if (decided.length) sections.push({ label: "Decided", lines: decided.slice(0, MEETING_LINES).map((d) => ({ label: d, state: "" })) });
  if (todo.length) {
    sections.push({
      label: "To do",
      lines: todo.slice(0, MEETING_LINES).map((t, i) => ({
        label: t.text,
        state: t.mine ? "" : (t.owner ?? ""),
        ...(t.mine ? { tag: "you", prompt: { id: `${m.id}:todo${i}`, text: todoPrompt(m.title, t.text) } } : {}),
      })),
    });
  }
  if (!sections.length && m.summary) sections.push({ label: "Summary", text: m.summary });
  const shown = Math.min(decided.length, MEETING_LINES) + Math.min(todo.length, MEETING_LINES);
  const rest = Math.max(m.decisions, decided.length) + Math.max(m.actions, todo.length) - shown;
  return {
    title: m.title,
    status: rest > 0 ? `+${rest} more in Meetings` : undefined,
    sections,
    actions,
  };
}

/**
 * Today's priorities: the writer's list from brief.json when it has one,
 * else the top three decisions and then the live incident, so the card is
 * never empty while there is something to do. At most five.
 */
export function briefPriorities(input: BriefInput): BriefPriority[] {
  if (input.priorities?.length) return input.priorities.slice(0, 5);
  const out: BriefPriority[] = input.decisions.slice(0, 3).map((d, i) => ({
    n: i + 1,
    text: d.title,
    because: d.detail?.why && d.detail.why !== d.title ? d.detail.why : d.summary !== d.title ? d.summary : null,
    itemId: d.id,
  }));
  const incident = input.risks.find((r) => r.severity === "incident");
  if (incident) {
    out.push({ n: out.length + 1, text: incident.ci?.workflow ? `Fix ${incident.ci.repo}: ${incident.ci.workflow}` : incident.title, because: incident.summary || null, itemId: incident.id });
  }
  return out;
}

/** "Red for 3h", "Red for 2 days" or "Red since Oct 9", from the incident's CI detail; null when unknown. */
export function redAge(ci: NonNullable<BriefRisk["ci"]>, nowIso: string): string | null {
  let hours = ci.ageHours;
  if (hours == null && ci.since) {
    const t = Date.parse(ci.since);
    if (Number.isFinite(t)) hours = (Date.parse(nowIso) - t) / 3_600_000;
  }
  if (hours != null && Number.isFinite(hours) && hours >= 0) {
    if (hours < 1) return "Red for under an hour";
    if (hours < 48) return `Red for ${Math.round(hours)}h`;
    return `Red for ${Math.round(hours / 24)} days`;
  }
  const since = ci.note?.match(/since\s+([A-Z][a-z]{2}\s+\d{1,2})/)?.[1];
  return since ? `Red since ${since}` : null;
}
