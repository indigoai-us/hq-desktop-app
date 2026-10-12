/**
 * Pure helpers for the two hero cards, Sunrise and Welcome back: the "First:"
 * line that names priority 1, the time-to-clear estimate beside the meter,
 * day tags, and the catch-up tiles with their peeks. Display only: the picker
 * never reads this file, so local-time formatting is fine here.
 */
import type { PeekContent } from "./brief-context.svelte.js";
import { humanTitle } from "./brief-distill.js";
import { productName } from "./brief-origin.js";
import { decisionPeek, redAge, riskPeek } from "./brief-peeks.js";
import { clockLabel } from "./brief-time.js";
import type {
  BriefDecision,
  BriefHandoff,
  BriefInput,
  BriefLine,
  BriefOrigin,
  BriefRecovered,
  BriefRisk,
  BriefShipped,
  BriefTone,
} from "./brief-types.js";

/** Priority 1 in the writer's words, as the heroes receive it. */
export interface HeroLead {
  text: string;
  because: string | null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Trims a sentence and drops its closing punctuation. */
const clause = (s: string | null | undefined) => (s ?? "").trim().replace(/[.!?]+$/, "");

/** A because clause as its own sentence: capitalised, ending in a period. */
function becauseSentence(because: string | null | undefined): string {
  const b = (because ?? "").trim();
  if (!b) return "";
  return `${b.charAt(0).toUpperCase()}${b.slice(1)}${/[.!?]$/.test(b) ? "" : "."}`;
}

/** "First: Cut the release. Investors wait on it." Empty when there is no lead. */
export function firstLine(lead: HeroLead | null | undefined): string {
  const text = clause(lead?.text);
  if (!text) return "";
  const because = becauseSentence(lead?.because);
  return `First: ${text}.${because ? ` ${because}` : ""}`;
}

/** The Welcome back greeting: 'Here's what changed, starting with "Approve the Q4 plan".' */
export function catchUpGreet(lead: HeroLead | null | undefined): string {
  const text = clause(lead?.text);
  return text ? `Here's what changed, starting with "${text}".` : "Here's what changed.";
}

/** The lead's because as the line under the Welcome back greeting; empty without one. */
export function catchUpBecause(lead: HeroLead | null | undefined): string {
  return clause(lead?.text) ? becauseSentence(lead?.because) : "";
}

/** Minutes a decision takes by the writer's effort size. */
export const EFFORT_MIN = { quick: 2, medium: 6, large: 15 } as const;

/**
 * Minutes to clear the open decisions from their effort sizes. Unsized
 * decisions count as medium once at least one is sized; null when none is,
 * so the meter shows nothing rather than a guess.
 */
export function effortMinutes(decisions: readonly Pick<BriefDecision, "effort">[]): number | null {
  if (!decisions.some((d) => d.effort && d.effort in EFFORT_MIN)) return null;
  return decisions.reduce((n, d) => n + EFFORT_MIN[d.effort && d.effort in EFFORT_MIN ? d.effort : "medium"], 0);
}

/**
 * "~6 min" for what is still open. The writer's total covers every open
 * decision at brief time; once some are cleared here the estimate scales by
 * what is left. Empty when nothing is left or no estimate exists.
 */
export function etaLabel(totalMin: number | null | undefined, left: number, total: number): string {
  if (totalMin == null || !Number.isFinite(totalMin) || totalMin <= 0 || left <= 0 || total <= 0) return "";
  const min = left >= total ? Math.round(totalMin) : Math.max(1, Math.round((totalMin * left) / total));
  return `~${min} min`;
}

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const localDayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * When something happened, as a short mono tag: "TODAY", a weekday ("THU")
 * inside the last week, else "OCT 2". Empty when the time is unknown.
 */
export function dayTag(iso: string | null | undefined, nowIso: string): string {
  if (!iso) return "";
  const t = new Date(iso);
  const n = new Date(nowIso);
  if (Number.isNaN(t.getTime()) || Number.isNaN(n.getTime())) return "";
  const days = Math.round((localDayStart(n) - localDayStart(t)) / DAY_MS);
  if (days === 0) return "TODAY";
  if (days > 0 && days < 7) return DAYS[t.getDay()]!;
  return `${MONTHS[t.getMonth()]} ${t.getDate()}`;
}

/** One Welcome back tile: what changed, in which tone, with its peek. */
export interface CatchUpTile {
  id: string;
  tone: BriefTone;
  /** Mono tag: "THU · INCIDENT", "WAITING ON YOU", "SHIPPED". */
  tag: string;
  text: string;
  sub: string;
  /** Company logo and product chips (up to three shown). */
  origins: BriefOrigin[];
  peek: PeekContent;
}

/** Tiles on the face of the card; the rest sit behind "+N more". */
export const CATCH_UP_TILES = 5;

const tagOf = (day: string, kind: string) => (day ? `${day} · ${kind}` : kind);

function incidentTile(r: BriefRisk, prompt: string | undefined, nowIso: string): CatchUpTile {
  const title = humanTitle(r.title).text;
  let text = title;
  let sub = r.summary;
  let when = "";
  if (r.measure) {
    const stuck = r.measure.total - r.measure.healthy;
    sub = `${stuck} of ${r.measure.total} ${r.measure.unit} affected. ${r.summary}`.trim();
  } else if (r.ci) {
    when = dayTag(r.ci.since, nowIso);
    const age = redAge(r.ci, nowIso);
    const product = productName(r.ci.repo, r.origin.product);
    text = r.ci.workflow ? `${product}: ${r.ci.workflow} is red` : title;
    sub = age ? `${age}. ${r.summary}`.trim() : r.summary;
  }
  return { id: r.id, tone: "red", tag: tagOf(when || "NOW", "INCIDENT"), text, sub, origins: [r.origin], peek: riskPeek(r, prompt) };
}

function decisionTile(d: BriefDecision, prompt: string | undefined, nowIso: string): CatchUpTile {
  const raised = d.ageHours != null && Number.isFinite(d.ageHours) ? new Date(Date.parse(nowIso) - d.ageHours * HOUR_MS).toISOString() : null;
  const text = humanTitle(d.title).text;
  const sub = d.summary && d.summary !== d.title ? d.summary : "";
  return { id: d.id, tone: "decision", tag: tagOf(dayTag(raised, nowIso), "WAITING ON YOU"), text, sub, origins: [d.origin], peek: decisionPeek(d, prompt) };
}

/** What got fixed: its timeline when the writer kept one, else the post-incident lines. */
export function recoveredPeek(r: BriefRecovered): PeekContent {
  const sections: PeekContent["sections"] = [];
  if (r.timeline?.length) {
    sections.push({ label: "Timeline", lines: r.timeline.map((t) => ({ label: t.text, state: clockLabel(t.at), tone: "ok" as const })) });
  }
  if (r.postIncident) {
    sections.push({ label: "What broke", text: r.postIncident.broke });
    sections.push({ label: "What we did", text: r.postIncident.did });
    sections.push({ label: "What changed", text: r.postIncident.changes });
  }
  return { title: humanTitle(r.title).text, status: r.what, sections };
}

function recoveredTile(r: BriefRecovered, nowIso: string): CatchUpTile {
  return { id: r.id, tone: "ok", tag: tagOf(dayTag(r.at, nowIso), "FIXED"), text: humanTitle(r.title).text, sub: r.what, origins: [r.origin], peek: recoveredPeek(r) };
}

/** A receipt's state: true done, false still waiting, null never shown as done. */
const RECEIPT: Record<string, { state: string; tone: BriefTone }> = {
  true: { state: "DONE", tone: "ok" },
  false: { state: "WAITING", tone: "warn" },
  null: { state: "UNKNOWN", tone: "neutral" },
};

/** A handoff's peek: who to whom, the three receipts, the note, and its prompt. */
export function handoffPeek(h: BriefHandoff, nowIso: string): PeekContent {
  const receipt = (label: string, v: boolean | null): BriefLine => ({ label, ...RECEIPT[String(v)]! });
  const since = dayTag(h.since, nowIso);
  const sections: PeekContent["sections"] = [
    { label: "Receipts", lines: [receipt("Access granted", h.receipts.access), receipt("Acknowledged", h.receipts.ack), receipt("Active", h.receipts.active)] },
  ];
  if (h.note) sections.push({ label: "Note", text: h.note });
  return {
    title: h.object,
    status: `${h.me ? `From ${h.from}` : `${h.from} to ${h.to}`}${h.production ? " · production" : ""}${since ? ` · since ${since}` : ""}`,
    sections,
    prompt: h.prompt ? { id: h.id, text: h.prompt } : undefined,
  };
}

function handoffTile(h: BriefHandoff, nowIso: string): CatchUpTile {
  const kind = h.me ? "NOW YOURS" : "HANDED OFF";
  const sub = h.me ? `From ${h.from}${h.production ? " · production" : ""}` : `${h.from} to ${h.to}`;
  return { id: h.id, tone: h.me ? "decision" : "neutral", tag: tagOf(dayTag(h.since, nowIso), kind), text: h.object, sub, origins: [h.origin], peek: handoffPeek(h, nowIso) };
}

/** What shipped while you were away, by product name (never a repo slug). */
export function shippedPeek(shipped: readonly BriefShipped[], merged: number | null | undefined): PeekContent {
  const byProduct = shipped.map((s) => ({ label: productName(s.origin.repo, s.origin.product), state: s.status, tone: "ok" as const }));
  const worth = shipped
    .map((s) => s.highlights?.[0] ?? s.why ?? "")
    .filter(Boolean)
    .map((t) => ({ label: humanTitle(t).text, state: "" }));
  const sections: PeekContent["sections"] = [];
  if (byProduct.length) sections.push({ label: "By product", lines: byProduct });
  if (worth.length) sections.push({ label: "Worth knowing", lines: worth });
  return { title: merged != null ? `${merged} merged` : `${shipped.length} product${shipped.length === 1 ? "" : "s"} shipped`, status: "Since your last brief", sections };
}

function shippedTile(shipped: readonly BriefShipped[], merged: number | null | undefined): CatchUpTile | null {
  if (!shipped.length && !(merged != null && merged > 0)) return null;
  const names = [...new Set(shipped.map((s) => productName(s.origin.repo, s.origin.product)))];
  const text = merged != null ? `${merged} merged` : `${names.length} product${names.length === 1 ? "" : "s"} shipped`;
  const sub = names.length ? `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3} more` : ""}` : "";
  const seen = new Set<string>();
  const origins = shipped.map((s) => s.origin).filter((o) => {
    const k = productName(o.repo, o.product);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { id: "shipped", tone: "ok", tag: "SHIPPED", text, sub, origins, peek: shippedPeek(shipped, merged) };
}

/**
 * The Welcome back tiles, in the order the catalogue counts them: live
 * incidents, the two decisions it ranked first, what got fixed, what was
 * handed to you, then one tile for everything shipped. The caller shows the
 * first five and puts the rest behind "+N more".
 */
export function catchUpTiles(
  input: BriefInput,
  opts: { decisions: readonly BriefDecision[]; prompts: Record<string, string>; now?: string },
): CatchUpTile[] {
  const now = opts.now ?? input.now;
  const tiles: CatchUpTile[] = [];
  for (const r of input.risks.filter((r) => r.severity === "incident")) tiles.push(incidentTile(r, opts.prompts[r.id], now));
  for (const d of opts.decisions.slice(0, 2)) tiles.push(decisionTile(d, opts.prompts[d.id], now));
  for (const r of input.recovered ?? []) tiles.push(recoveredTile(r, now));
  for (const h of input.handoffs ?? []) tiles.push(handoffTile(h, now));
  const ship = shippedTile(input.shipped, input.merged);
  if (ship) tiles.push(ship);
  return tiles;
}

/** The peek behind "+N more": every tile that did not fit on the face. */
export function moreTilesPeek(rest: readonly CatchUpTile[]): PeekContent {
  return {
    title: `${rest.length} more change${rest.length === 1 ? "" : "s"}`,
    status: "Also since your last brief",
    sections: [{ label: "Changes", lines: rest.map((t) => ({ label: t.text, state: t.tag.split(" · ").pop() ?? t.tag, tone: t.tone })) }],
  };
}
