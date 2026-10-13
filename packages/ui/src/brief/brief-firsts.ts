/**
 * Pure helpers for the Firsts card: which shipped rows count as firsts (the
 * same rule the catalogue's measure() uses), the headline, plain captions
 * with no repo or PR reference, how many medal tiles a slot holds, the peek
 * contents, and the team-note prompt. No Date, no toLocale*.
 */
import type { PeekContent } from "./brief-context.svelte.js";
import { humanTitle } from "./brief-distill.js";
import { productName } from "./brief-origin.js";
import type { BriefLine, BriefShipped } from "./brief-types.js";

/** Medal tiles on the card; the rest sit behind "+N more". */
export const FIRSTS_TILE_MAX = 3;
/** A caption is a person's sentence, not a PR title. */
export const CAPTION_WORDS = 8;
/** The holographic foil glints once after the card has settled, then rests until hovered. */
export const GLINT_DELAY_MS = 1200;
export const GLINT_MS = 700;

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/** The shipped rows the writer marked as firsts, in the writer's order. Matches the catalogue entry's gate. */
export function firstsOf(shipped: readonly BriefShipped[]): BriefShipped[] {
  return shipped.filter((s) => !!s.first);
}

/** "One first yesterday." / "Two firsts yesterday." / "12 firsts yesterday." */
export function firstsHeadline(n: number): string {
  if (n === 1) return "One first yesterday.";
  return `${WORDS[n] ?? String(n)} firsts yesterday.`;
}

/**
 * The tile caption: the shipped title as a plain sentence. Drops a leading
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

/** The product the first belongs to, by its human name ("HQ Pro", not "indigoai-us/hq-pro"). */
export function firstProduct(s: BriefShipped): string {
  return productName(s.origin.repo, s.origin.product);
}

/** The line under the caption: the writer's why, else the row's note. */
export function firstSub(s: BriefShipped): string {
  return (s.why?.trim() || s.note?.trim() || "").replace(/\s+/g, " ");
}

/** Tiles a slot holds: one at S, two at W, three at W3 or any two-row slot; never more than there are firsts. */
export function tileCount(cols: number, rows: number, n: number): number {
  const cap = rows > 1 || cols >= 3 ? FIRSTS_TILE_MAX : cols >= 2 ? 2 : 1;
  return Math.max(0, Math.min(cap, n));
}

/** The built-in action: a team note about the first. It shows the draft and sends nothing. */
export function firstNotePrompt(s: BriefShipped): string {
  const why = firstSub(s);
  return (
    `Draft a short note to the team about a first for ${firstProduct(s)}: ${firstCaption(s.title)}.` +
    (why ? ` Why it counts: ${why.replace(/[.\s]+$/, "")}.` : "") +
    " Two or three sentences in my voice, plain words, no hype. Show me the draft; do not send or post anything."
  );
}

/** One medal's peek: why it counts, the evidence, and the note prompt. */
export function firstPeek(s: BriefShipped, prompt: string): PeekContent {
  const product = firstProduct(s);
  const why = firstSub(s);
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
    title: firstCaption(s.title),
    status: `${product} · a first`,
    sections,
    prompt: { id: `first:${s.id}`, text: prompt, verb: "Draft" },
  };
}

/** The "+N more" peek: every first that did not get a tile, with its product. */
export function firstsMorePeek(rest: readonly BriefShipped[]): PeekContent {
  return {
    title: `${rest.length} more first${rest.length === 1 ? "" : "s"}`,
    status: "Also yesterday",
    sections: [{ label: "Firsts", lines: rest.map((s) => ({ label: firstCaption(s.title), state: firstProduct(s), tone: "ok" as const })) }],
  };
}
