/**
 * Pure helpers for the Firsts card: which shipped rows count as firsts (the
 * same rule the catalogue's measure() uses), the headline, plain captions
 * with no repo or PR reference, how many firsts a slot shows, the peek
 * contents, and the team-note prompt. No Date, no toLocale*.
 */
import type { PeekContent } from "./brief-context.svelte.js";
import { humanTitle, isNamedShip, withoutPrRefs } from "./brief-distill.js";
import { productName } from "./brief-origin.js";
import type { BriefLine, BriefShipped } from "./brief-types.js";

/** Firsts on the card; the rest sit behind "+N more". */
export const FIRSTS_TILE_MAX = 3;
/** A caption is a person's sentence, not a PR title. */
export const CAPTION_WORDS = 8;
/** Each first glints once after the card has settled (a brief glass lift), then rests until hovered. */
export const GLINT_DELAY_MS = 1200;
export const GLINT_MS = 700;

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/** The shipped rows the writer marked as firsts, in the writer's order. Matches the catalogue entry's gate. */
export function firstsOf(shipped: readonly BriefShipped[]): BriefShipped[] {
  return shipped.filter((s) => !!s.first);
}

/** The count in words: "One first" / "Two firsts" / "12 firsts". */
export function firstsCount(n: number): string {
  return n === 1 ? "One first" : `${WORDS[n] ?? String(n)} firsts`;
}

/** The card's mono caps marker: "One first yesterday" / "Two firsts yesterday" / "12 firsts yesterday". */
export function firstsHeadline(n: number): string {
  return `${firstsCount(n)} yesterday`;
}

/**
 * The caption: the shipped title as a plain sentence. Drops a leading
 * "repo #n:" reference and a conventional prefix (humanTitle), any inline
 * "#123" or "(#123)", a trailing period, and cuts at eight words.
 */
export function firstCaption(title: string): string {
  const text = humanTitle(title)
    .text.replace(/\(?#\d+\)?/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "");
  const words = text.split(" ").filter(Boolean);
  return words.length > CAPTION_WORDS ? `${words.slice(0, CAPTION_WORDS).join(" ")}…` : words.join(" ");
}

/** What a first says when its row only names the product and carries no why. */
export const ROLLUP_FIRST = "Shipped for the first time";

/** A why split at its first sentence, PR references dropped: the lead (no closing period) and the rest. */
function sentences(text: string): { lead: string; rest: string } {
  const t = withoutPrRefs(text.replace(/\s+/g, " ").trim());
  const first = t.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? t;
  return { lead: first.replace(/[.\s]+$/, ""), rest: t.slice(first.length).trim() };
}

/**
 * A rollup row is named after its repo or product ("hq-cloud", "Ledger",
 * "hq-pro: 3 changes shipped"): its title says where, not what. Its first is
 * then the writer's why ("The first invoices went out to real customers"),
 * else "Shipped for the first time".
 */
function lineIsWhy(s: BriefShipped): boolean {
  return !isNamedShip(s) && !!firstSub(s);
}

/**
 * The first, said as a sentence: a named ship's title as a caption; a rollup
 * row's why (first sentence), else "Shipped for the first time". The product
 * says where, beside it.
 */
export function firstLine(s: BriefShipped): string {
  if (isNamedShip(s)) return firstCaption(s.title) || ROLLUP_FIRST;
  return lineIsWhy(s) ? sentences(firstSub(s)).lead : ROLLUP_FIRST;
}

/** The product the first belongs to, by its human name ("HQ Pro", not "indigoai-us/hq-pro"). */
export function firstProduct(s: BriefShipped): string {
  return productName(s.origin.repo, s.origin.product);
}

/** The sweep's open-PR note on a rollup row ("nothing open", "2 open"): a count of open work, not a reason. */
const OPEN_NOTE = /^(?:nothing|\d+)\s+open$/i;

/** Why the first counts: the writer's why, else the row's note (never the sweep's "nothing open"). */
export function firstSub(s: BriefShipped): string {
  const note = s.note?.trim() ?? "";
  return (s.why?.trim() || (OPEN_NOTE.test(note) ? "" : note)).replace(/\s+/g, " ");
}

/** Why it counts, less what the first's line already says (a rollup row's lead sentence). */
function whyBeyondLine(s: BriefShipped): string {
  return lineIsWhy(s) ? sentences(firstSub(s)).rest : firstSub(s);
}

/**
 * The line under the first: why it counts (beyond what the line says), else
 * the writer's first highlight in plain words; "" when neither.
 */
export function firstDetail(s: BriefShipped): string {
  const why = whyBeyondLine(s);
  if (why) return why;
  const h = (s.highlights ?? []).map((x) => withoutPrRefs(humanTitle(x).text)).find(Boolean);
  return h ?? "";
}

/** The mono meta beside the product: "2 merged", "Merged"; "" when the row has no status. */
export function firstMeta(s: BriefShipped): string {
  const st = s.status?.trim().replace(/\s+/g, " ") ?? "";
  return st ? st.charAt(0).toUpperCase() + st.slice(1).toLowerCase() : "";
}

/** Firsts a slot shows: one at S, two at W, three at W3 or any two-row slot; never more than there are firsts. */
export function tileCount(cols: number, rows: number, n: number): number {
  const cap = rows > 1 || cols >= 3 ? FIRSTS_TILE_MAX : cols >= 2 ? 2 : 1;
  return Math.max(0, Math.min(cap, n));
}

/** The built-in action: a team note about the first. It shows the draft and sends nothing. */
export function firstNotePrompt(s: BriefShipped): string {
  const why = whyBeyondLine(s);
  return (
    `Draft a short note to the team about a first for ${firstProduct(s)}: ${firstLine(s)}.` +
    (why ? ` Why it counts: ${why.replace(/[.\s]+$/, "")}.` : "") +
    " Two or three sentences in my voice, plain words, no hype. Show me the draft; do not send or post anything."
  );
}

/** One first's peek: why it counts, the evidence, and the note prompt. */
export function firstPeek(s: BriefShipped, prompt: string): PeekContent {
  const product = firstProduct(s);
  // A rollup row's why is its title here; the full why still shows when it says more.
  const why = whyBeyondLine(s) ? firstSub(s) : "";
  const ref = humanTitle(s.title).ref;
  const evidence: BriefLine[] = [{ label: "Product", state: product, tone: "ok" }];
  if (s.status?.trim()) evidence.push({ label: "Shipped", state: s.status.trim(), tone: "ok" });
  if (ref) evidence.push({ label: "Reference", state: ref });
  for (const h of (s.highlights ?? []).slice(0, 2)) evidence.push({ label: h, state: "" });
  const sections: PeekContent["sections"] = [];
  if (why) sections.push({ label: "Why it counts", text: why });
  sections.push({ label: "Evidence", lines: evidence });
  return {
    sample: s.sample,
    title: firstLine(s),
    status: `${product} · a first`,
    sections,
    prompt: { id: `first:${s.id}`, text: prompt, verb: "Draft" },
  };
}

/** The "+N more" peek: every first that did not get a place on the card, with its product. */
export function firstsMorePeek(rest: readonly BriefShipped[]): PeekContent {
  return {
    title: `${rest.length} more first${rest.length === 1 ? "" : "s"}`,
    status: "Also yesterday",
    sections: [{ label: "Firsts", lines: rest.map((s) => ({ label: firstLine(s), state: firstProduct(s), tone: "ok" as const })) }],
  };
}
