/**
 * What your calls unblock: pure helpers for BriefBlockedByMe. Who and what
 * waits on each of the owner's decisions, the plain headline, and the capped
 * layout the card draws. Mirrors the catalogue's blockedByMe measure(): a
 * decision has an edge when it names blocks or carries unlock lines; people
 * are counted only from blocks of kind "person"; with no named blocks at all
 * the parties are the unlock lines. The card draws the list form (each call,
 * then who it frees) from blockedLayout and the one-row lead form from
 * chainNodes. No Date, no toLocale*.
 */
import type { PeekContent } from "./brief-context.svelte.js";
import { humanTitle } from "./brief-distill.js";
import { productName } from "./brief-origin.js";
import type { BriefDecision, BriefOrigin, BriefTone } from "./brief-types.js";

/** Calls in the list form before "+N more calls". */
export const CALL_CAP = 3;
/** Party lines in the list form, across every call, before each call's "+N more". */
export const LINE_CAP = 5;
/** The same caps on a one-column card. */
export const NARROW_CALL_CAP = 2;
export const NARROW_LINE_CAP = 3;

export interface FreedParty {
  key: string;
  name: string;
  kind: "person" | "work";
  /** What they do once freed; empty when the writer gave none. */
  what: string;
  /** Mono state on a chain node: WAITING for a person, HELD for work, or the writer's unlock state. */
  state: string;
  tone?: BriefTone;
  origin?: BriefOrigin;
  /** Ids of the decisions that free it, most freeing decision first. */
  by: string[];
}

export interface BlockedEdge {
  decisionId: string;
  partyKey: string;
  /** Items behind the edge (several blocks naming the same party add up). */
  weight: number;
}

export interface BlockedSummary {
  /** Decisions with at least one named block or unlock line: most parties freed first, then oldest, then id. */
  decisions: BriefDecision[];
  /** Unique parties in the order the decisions free them. */
  parties: FreedParty[];
  edges: BlockedEdge[];
  people: number;
  work: number;
  /** No decision names a block: every party is an unlock line. */
  unlocksOnly: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Decisions that free someone or something: the same gate as the catalogue entry. */
export function edgedDecisions(decisions: readonly BriefDecision[]): BriefDecision[] {
  return decisions.filter((d) => (d.blocks?.length ?? 0) > 0 || (d.detail?.unlocks.length ?? 0) > 0);
}

/** Parties one decision frees: its named blocks, else its unlock lines as work. */
function partiesOf(d: BriefDecision): { party: FreedParty; weight: number }[] {
  const out = new Map<string, { party: FreedParty; weight: number }>();
  const blocks = d.blocks ?? [];
  if (blocks.length) {
    for (const b of blocks) {
      const raw = b.who.trim();
      if (!raw) continue;
      const name = b.kind === "work" ? humanTitle(raw).text : raw;
      const key = `${b.kind}:${name.toLowerCase()}`;
      const cur = out.get(key);
      if (cur) {
        cur.weight += 1;
        if (!cur.party.what && b.what.trim()) cur.party.what = b.what.trim();
        continue;
      }
      out.set(key, {
        weight: 1,
        party: { key, name, kind: b.kind, what: b.what.trim(), state: b.kind === "person" ? "WAITING" : "HELD", by: [d.id], ...(b.origin ? { origin: b.origin } : {}) },
      });
    }
    return [...out.values()];
  }
  for (const u of d.detail?.unlocks ?? []) {
    const name = humanTitle(u.label).text.trim();
    if (!name) continue;
    const key = `work:${name.toLowerCase()}`;
    const cur = out.get(key);
    if (cur) {
      cur.weight += 1;
      continue;
    }
    out.set(key, {
      weight: 1,
      party: { key, name, kind: "work", what: "", state: u.state.trim() || "NEXT", ...(u.tone ? { tone: u.tone } : {}), origin: d.origin, by: [d.id] },
    });
  }
  return [...out.values()];
}

/** The whole graph: decisions ordered by what they free, parties deduped across decisions, edges between them. */
export function summarizeBlocked(decisions: readonly BriefDecision[]): BlockedSummary {
  const edged = edgedDecisions(decisions).map((d) => ({ d, own: partiesOf(d) })).filter((x) => x.own.length);
  edged.sort((a, b) => b.own.length - a.own.length || (b.d.ageHours ?? -1) - (a.d.ageHours ?? -1) || a.d.id.localeCompare(b.d.id));
  const parties = new Map<string, FreedParty>();
  const edges: BlockedEdge[] = [];
  for (const { d, own } of edged) {
    for (const { party, weight } of own) {
      const cur = parties.get(party.key);
      if (cur) {
        if (!cur.by.includes(d.id)) cur.by.push(d.id);
        if (!cur.what && party.what) cur.what = party.what;
        if (!cur.origin && party.origin) cur.origin = party.origin;
      } else {
        parties.set(party.key, { ...party, by: [d.id] });
      }
      edges.push({ decisionId: d.id, partyKey: party.key, weight });
    }
  }
  const list = [...parties.values()];
  return {
    decisions: edged.map((x) => x.d),
    parties: list,
    edges,
    people: list.filter((p) => p.kind === "person").length,
    work: list.filter((p) => p.kind === "work").length,
    unlocksOnly: !edged.some((x) => x.d.blocks?.length),
  };
}

/**
 * The card's one sentence: "3 calls free 2 people and the docs release.",
 * "1 call frees Jonathan.", "Your 5 calls unlock 5 things." Never "people"
 * without a block of kind person; a lone person or piece of work is named.
 */
export function blockedHeadline(s: BlockedSummary): string {
  const calls = s.decisions.length;
  if (!calls) return "";
  if (s.unlocksOnly) return `Your ${plural(calls, "call")} ${calls === 1 ? "unlocks" : "unlock"} ${plural(s.work, "thing")}.`;
  const people = s.parties.filter((p) => p.kind === "person");
  const work = s.parties.filter((p) => p.kind === "work");
  const parts: string[] = [];
  if (people.length) parts.push(people.length === 1 ? people[0]!.name : `${people.length} people`);
  if (work.length) parts.push(work.length === 1 ? work[0]!.name : plural(work.length, "thing"));
  return `${plural(calls, "call")} ${calls === 1 ? "frees" : "free"} ${parts.join(" and ")}.`;
}

/** Age pill: "17h", "44h", "3d"; empty when unknown. */
export function ageLabel(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours) || hours < 0) return "";
  if (hours < 1) return "<1h";
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export interface BlockedStat {
  key: "calls" | "freed" | "oldest";
  value: string;
  /** Mono caps label under the number. */
  label: string;
  /** The oldest call is past a day. */
  late?: boolean;
}

/**
 * The card's numbers, for the band at the foot of a tall card: how many
 * calls, how many people and things wait on them (never "people" without a
 * block of kind person), and the oldest call's age when one is known.
 */
export function blockedStats(s: BlockedSummary): BlockedStat[] {
  if (!s.decisions.length) return [];
  const n = s.parties.length;
  const freedLabel = s.unlocksOnly
    ? n === 1 ? "Thing unlocked" : "Things unlocked"
    : s.people && s.work
      ? "Waiting on them"
      : s.people
        ? s.people === 1 ? "Person waiting" : "People waiting"
        : n === 1 ? "Thing held" : "Things held";
  const out: BlockedStat[] = [
    { key: "calls", value: String(s.decisions.length), label: s.decisions.length === 1 ? "Call" : "Calls" },
    { key: "freed", value: String(n), label: freedLabel },
  ];
  const ages = s.decisions.map((d) => d.ageHours).filter((h): h is number => h != null && Number.isFinite(h) && h >= 0);
  if (ages.length) {
    const oldest = Math.max(...ages);
    out.push({ key: "oldest", value: ageLabel(oldest), label: "Oldest call", late: oldest > 24 });
  }
  return out;
}

/** Past a day the call is late: its age pill turns warm. */
export const isLate = (d: BriefDecision): boolean => (d.ageHours ?? 0) > 24;

/** One call in the list form and what it frees there. */
export interface LaidCall {
  decision: BriefDecision;
  /** Parties drawn under the call (a party freed by two shown calls is drawn under both). */
  parties: FreedParty[];
  /** Its parties past the line budget: the call's own "+N more" line. */
  folded: FreedParty[];
}

export interface BlockedLayout {
  calls: LaidCall[];
  /** Calls past the cap: the "+N more calls" line. */
  moreCalls: BriefDecision[];
}

/**
 * The list form: at most `callCap` calls, each with what it frees, and at
 * most `lineCap` party lines in all. Every shown call gets its first party
 * before any call gets a second, so no call is drawn freeing nothing; the
 * rest of the budget goes to the calls in order. What does not fit folds
 * into that call's "+N more".
 */
export function blockedLayout(s: BlockedSummary, callCap = CALL_CAP, lineCap = LINE_CAP): BlockedLayout {
  const shown = s.decisions.slice(0, callCap);
  const own = shown.map((d) => s.parties.filter((p) => p.by.includes(d.id)));
  const take = own.map(() => 0);
  let budget = lineCap;
  for (let i = 0; i < own.length && budget > 0; i++) {
    if (own[i]!.length) {
      take[i] = 1;
      budget -= 1;
    }
  }
  for (let i = 0; i < own.length && budget > 0; i++) {
    const extra = Math.min(budget, own[i]!.length - take[i]!);
    take[i] = take[i]! + extra;
    budget -= extra;
  }
  return {
    calls: shown.map((d, i) => ({ decision: d, parties: own[i]!.slice(0, take[i]), folded: own[i]!.slice(take[i]) })),
    moreCalls: s.decisions.slice(callCap),
  };
}

/** A party is freed once every call that holds it is made. */
export const isFreed = (p: FreedParty, cleared: Readonly<Record<string, boolean>>): boolean => p.by.length > 0 && p.by.every((id) => !!cleared[id]);

/** One letter for a person's glass circle: "Jonathan" -> "J". */
export function initialOf(name: string): string {
  const ch = name.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? "?";
  return ch.toUpperCase();
}

export interface ChainNodes {
  /** The call that frees the most, or null with nothing edged. */
  lead: BriefDecision | null;
  /** Its freed parties, at most `cap`. */
  nodes: FreedParty[];
  /** Every other party (the lead's past the cap, then the other calls'). */
  more: FreedParty[];
}

/** The one-row chain: the top call flowing into the nodes it frees, then "+N more" for the rest. */
export function chainNodes(s: BlockedSummary, cap: number): ChainNodes {
  const lead = s.decisions[0] ?? null;
  if (!lead) return { lead: null, nodes: [], more: [] };
  const own = s.parties.filter((p) => p.by.includes(lead.id));
  const nodes = own.slice(0, cap);
  const shown = new Set(nodes.map((p) => p.key));
  return { lead, nodes, more: s.parties.filter((p) => !shown.has(p.key)) };
}

/** Plain titles by decision id: no PR numbers or commit prefixes. */
export function titlesOf(s: BlockedSummary): Record<string, string> {
  return Object.fromEntries(s.decisions.map((d) => [d.id, humanTitle(d.title).text]));
}

/** A freed party's peek: who, that they wait on you, what they do next, and which calls free them. */
export function partyPeek(p: FreedParty, titles: Record<string, string>): PeekContent {
  const sections: PeekContent["sections"] = [];
  if (p.what) sections.push({ label: p.kind === "person" ? "What they do next" : "What happens next", text: p.what });
  sections.push({ label: p.by.length === 1 ? "Freed by your call" : "Freed by your calls", lines: p.by.map((id) => ({ label: titles[id] ?? id, state: "YOURS", tone: "decision" as const })) });
  return {
    title: p.name,
    status: p.kind === "person" ? "Waiting on you" : "Held until you act",
    sections,
    ...(p.origin ? { origin: { companyUid: p.origin.companyUid, label: productName(p.origin.repo, p.origin.product) || "work" } } : {}),
  };
}

/** The "+N more" tile's peek: every party not drawn, with its state. */
export function morePartiesPeek(rest: readonly FreedParty[], titles: Record<string, string>): PeekContent {
  return {
    title: `${rest.length} more waiting on you`,
    status: "Also freed by your calls",
    sections: [
      {
        label: "Waiting",
        lines: rest.map((p) => ({
          label: `${p.name}${p.what ? ` · ${p.what}` : ""} · ${p.by.map((id) => titles[id] ?? id).join(", ")}`,
          state: p.state,
          ...(p.tone ? { tone: p.tone } : {}),
        })),
      },
    ],
  };
}

/** The "+N more calls" pill's peek: the decisions the graph has no room for, with what each frees. */
export function morePillsPeek(rest: readonly BriefDecision[], s: BlockedSummary, titles: Record<string, string>): PeekContent {
  return {
    title: `${plural(rest.length, "more call")}`,
    status: "Also unblock something",
    sections: [
      {
        label: "Calls",
        lines: rest.map((d) => {
          const freed = s.parties.filter((p) => p.by.includes(d.id));
          return { label: titles[d.id] ?? d.title, state: `FREES ${freed.length}`, tone: "decision" as const };
        }),
      },
    ],
  };
}
