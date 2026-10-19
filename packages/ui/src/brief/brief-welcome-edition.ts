/**
 * The welcome edition after the rise (round 11b final frame): the greeting,
 * three cards (your decision, your day, the work to pick up) and one short
 * section per company. Built from the brief input only, so nothing on the
 * page is sample copy.
 */

import type { BriefCalendarEvent, BriefDecision, BriefInput } from "./brief-types.js";
import { plainLine } from "./brief-runs.js";
import { WELCOME_HARNESS_NAME, primaryAction, type WelcomeAction, type WelcomeBriefFields, type WelcomeHarnessId } from "./brief-welcome-contract.js";

export const WELCOME_EDITION_EYEBROW = "Your welcome edition · Ready";
export const WELCOME_EDITION_SUB = "Your decisions, your day, and the work worth picking up.";
/** The sub on the edition drawn from brief.json `welcome`: it shows what HQ knows, not decisions. */
export const WELCOME_FIELDS_SUB = "What HQ knows about your work so far, and one place to start.";
export const WELCOME_EDITION_ZERO_HEADLINE = "A place to begin.";
export const WELCOME_EDITION_ZERO_SUB = "Your personal brief is ready. No company needed.";
export const WELCOME_EDITION_HEAD = "Your day, ready to read.";
/** The day card's label when the calendar could not be read (the brief's own priorities heading). */
export const WELCOME_EDITION_PRIORITIES = "Today's priorities";

/** What a card's link does: hand the item's prompt to a session, or open the Meetings page. */
export type WelcomeEditionAction =
  | { kind: "launch"; itemId: string; prompt: string }
  | { kind: "meetings" }
  /** A brief.json welcome action; the edition runs it through its own flow (connect, company, harness, launch). */
  | { kind: "welcome"; action: WelcomeAction };

/** One line in a list card (the watch list, the timeline). */
export interface WelcomeEditionRow {
  id: string;
  title: string;
  detail: string | null;
  action: WelcomeEditionAction | null;
}

export interface WelcomeEditionCard {
  id: "decision" | "day" | "work" | "task" | "context" | "one-thing" | "watch" | "timeline";
  /** The small pill before the kicker ("Your decision"), when the card has one. */
  pill: string | null;
  kicker: string;
  /** Empty on a list card that has only its rows. */
  title: string;
  lines: string[];
  label: string | null;
  action: WelcomeEditionAction | null;
  rows?: WelcomeEditionRow[];
}

export interface WelcomeEditionSection {
  name: string;
  lines: string[];
}

export interface WelcomeEdition {
  zero: boolean;
  headline: string;
  sub: string;
  cards: WelcomeEditionCard[];
  sections: WelcomeEditionSection[];
  /** One quiet line under the greeting: the run stats and any source that could not be read. Null when empty. */
  note: string | null;
  /** Drawn from brief.json `welcome` (the contract components), not from the brief's decisions. */
  welcome?: boolean;
}

/** The pill on the welcome lead card, the same words as the brief's lead slot. */
export const WELCOME_ONE_THING = "If you do one thing";
export const WELCOME_RECENT_WORK = "Recent work";
/** The welcome block's failure sentence, reused when part of the welcome could not be read. */
export const WELCOME_NOTE_FAILED = "Some of your welcome details could not be loaded this time.";

const FILE = /\b[\w.-]+\.(?:svelte|tsx?|jsx?|mjs|cjs|vue|astro|json|mdx?|txt|csv|sql|lock|rs|py|java|php|cpp|css|scss|html|ya?ml|toml|sh|go|rb|swift|kt)\b/i;
/** Library names that read like a filename ("Node.js", "Next.js") and are not one. */
const LIBRARY = /\b(?:node|next|nuxt|vue|react|express|three|d3|chart|alpine|ember|angular|deno|nest|solid|p5)\.js\b/gi;
/** A path segment has a lowercase letter, so dates, "24/7", and "Q3/Q4" are not paths. */
const SEG = "[\\w.@-]*[a-z][\\w.@-]*";
const BARE_PATH = new RegExp(`^\\s*~?${SEG}(?:/${SEG})+/?\\s*$`);
const DEEP_PATH = new RegExp(`${SEG}/${SEG}/${SEG}`);
/** A one-slash path inside a sentence, named by a code folder ("Fix the bug in src/brief"). */
const CODE_DIR = /(?:^|[\s(])(?:src|apps?|packages|libs?|components|scripts|tests?|docs|crates|repos|companies|workspace)\/[\w.@-]+/;
/** Slashed words that are prose, not a path. */
const PROSE = new Set(["and/or", "either/or", "he/she", "his/her", "him/her", "s/he", "w/o", "n/a"]);

/** True when text shows a filename or a repo path ("WelcomeReport.svelte", "northstar/desktop"). */
export function looksLikePath(text: string, repo?: string | null): boolean {
  const t = text.trim();
  if (!t) return false;
  const named = t.replace(LIBRARY, "");
  if (FILE.test(named) || DEEP_PATH.test(t) || CODE_DIR.test(t)) return true;
  if (BARE_PATH.test(t) && !PROSE.has(t.toLowerCase())) return true;
  const r = repo?.trim();
  return !!r && r.includes("/") && t.toLowerCase().includes(r.toLowerCase());
}

/** Operator text that is never shown: stack traces, error codes, CLI commands, markup, links. */
const RAW = /traceback|exception|stack trace|\berror:|\bgh\s+(?:auth|api|pr)\b|\b[a-z]+_[a-z_]+\b|https?:\/\/|[{}<>`$\\]|^\s*[~/]/i;
/** Case matters here: "KeyError", "ENOENT", never "terror" or "Every". */
const RAW_CODE = /\b[A-Z]\w*Error\b|\bE(?:NOENT|ACCES|PERM|CONNREFUSED|CONNRESET|TIMEDOUT|ADDRINUSE|PIPE|NOTFOUND)\b/;

/**
 * Text from brief.json `welcome` when it reads as plain words; null for a path, a filename or raw operator text.
 * The brief's own plainLine check runs first, so the edition never shows a line the activity rows would hide.
 */
export function plainWelcomeText(text: string | null | undefined, max = 140): string | null {
  const t = plainLine(text?.replace(/\s+/g, " "), max);
  if (!t || looksLikePath(t) || RAW.test(t) || RAW_CODE.test(t)) return null;
  return t;
}

/** "Good morning, Alex." by the brief's local hour; no name, no comma. */
export function welcomeGreeting(now: Date, userName?: string | null): string {
  const h = now.getHours();
  const part = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  const name = userName?.trim();
  return name ? `Good ${part}, ${name}.` : `Good ${part}.`;
}

/** A company slug as a name ("northstar" to "Northstar"); a label from the host wins. */
export function companyName(slug: string, labels: ReadonlyMap<string, string> = new Map()): string {
  const label = labels.get(slug.toLowerCase());
  if (label?.trim()) return label.trim();
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

function launch(d: BriefDecision, prompts: Record<string, string>): WelcomeEditionAction {
  const prompt = (prompts[d.id] ?? d.prompt ?? "").trim() || d.title;
  return { kind: "launch", itemId: d.id, prompt };
}

/** A card or section title in plain words: never a filename or path. Falls back to the product, then the company. */
function plainTitle(d: BriefDecision, company: string): string {
  const repo = d.origin?.repo;
  const text = d.title.trim();
  if (text && !looksLikePath(text, repo)) return text;
  const product = d.origin?.product?.trim();
  if (product && !looksLikePath(product, repo)) return product;
  return company;
}

/** The lines under a title, with any filename or path line, or a repeat of the title, left out. */
function plainLines(d: BriefDecision, title: string): string[] {
  return [d.summary].filter((l) => l?.trim() && l.trim() !== title && !looksLikePath(l, d.origin?.repo));
}

/** The next event still ahead today, else the first of the day. */
function nextEvent(events: readonly BriefCalendarEvent[], now: Date): BriefCalendarEvent | null {
  const real = events.filter((e) => !e.busy && e.title.trim());
  const ahead = real.filter((e) => Date.parse(e.start) >= now.getTime());
  return ahead[0] ?? real[0] ?? null;
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function calendarFailed(input: BriefInput): boolean {
  return (input.sourceNotes ?? []).some((n) => /calendar/i.test(n));
}

/**
 * The agenda card. A calendar that could not be read is never its headline (that is
 * the quiet note under the greeting); the card then counts what the page shows today,
 * under the priorities label, with no agenda link because there is no agenda to open.
 * With nothing booked and nothing to count there is no card: an empty-state line
 * says nothing the page does not already show.
 */
function dayCard(input: BriefInput, now: Date, shown: number, names: readonly string[]): WelcomeEditionCard | null {
  const event = nextEvent(input.calendarToday, now);
  if (event) {
    const who = (event.attendees ?? []).slice(0, 2);
    return {
      id: "day",
      pill: null,
      kicker: "Today · Personal",
      title: `${timeOf(event.start)} · ${event.title}`,
      lines: who.length ? [who.join(" and ")] : [],
      label: "Open the agenda",
      action: { kind: "meetings" },
    };
  }
  if (calendarFailed(input) && shown) {
    return {
      id: "day",
      pill: null,
      kicker: WELCOME_EDITION_PRIORITIES,
      title: `${shown} ${shown === 1 ? "thing" : "things"} for you today.`,
      lines: names.length ? [`Across ${listOf(names)}.`] : [],
      label: null,
      action: null,
    };
  }
  return null;
}

/** "Northstar", "Northstar and Studio", "Northstar, Fieldwork, and Studio". */
function listOf(names: readonly string[]): string {
  if (names.length < 3) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** The run stats the reveal ended on, then each source that could not be read. Shown once. */
function editionNote(input: BriefInput): string | null {
  const n = input.sessions.length;
  const stats = input.runStats?.trim() || (n ? `${n} ${n === 1 ? "session" : "sessions"} read` : "");
  const parts = [stats, ...(input.sourceNotes ?? []).map((l) => l.trim().replace(/\.$/, ""))].filter(Boolean);
  return parts.length ? `${parts.join(" · ")}.` : null;
}

/** The kicker over IF YOU DO ONE THING, by what the action does. */
function actionKicker(a: WelcomeAction, fields: WelcomeBriefFields): string {
  switch (a.kind) {
    case "connect_ai_apps":
      return "Your AI apps";
    case "connect_integration":
      return plainWelcomeText(a.integration?.name) ?? "Your apps";
    case "open_harness":
      return WELCOME_HARNESS_NAME[a.harness ?? fields.harness?.action.harness ?? fields.harness?.primary ?? "claude-code"];
    case "connect_company":
      return "A space for your team";
    case "import_history":
      return "Your past work";
    case "open_tree":
      return "Your HQ";
  }
}

const sessions = (n: number) => `${n} ${n === 1 ? "session" : "sessions"}`;
const dayOf = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const welcomeAction = (a: WelcomeAction): WelcomeEditionAction => ({ kind: "welcome", action: a });

/** True when brief.json `welcome` carries anything the edition draws a component from. A tree of all zeros draws nothing. */
function hasComponents(f: WelcomeBriefFields): boolean {
  const tree = !!f.tree && f.tree.companies + f.tree.projects + f.tree.knowledge_files > 0;
  return !!(f.actions || f.harness || f.recent_work || f.top_projects || f.top_repos || tree || (f.sessions?.total ?? 0) > 0);
}

/** The welcome actions with plain labels; an action whose label is raw text is dropped, so no button shows it. */
function plainActions(actions: readonly WelcomeAction[]): WelcomeAction[] {
  return actions.flatMap((a) => {
    const label = plainWelcomeText(a.label);
    return label ? [{ ...a, label }] : [];
  });
}

/** Projects, repos, the harness and the tree: one section each, when the field is present. */
function welcomeSections(f: WelcomeBriefFields): WelcomeEditionSection[] {
  const out: WelcomeEditionSection[] = [];
  const projects = (f.top_projects ?? []).flatMap((p) => {
    const name = plainWelcomeText(p.name);
    return name ? [p.sessions ? `${name} · ${sessions(p.sessions)}` : name] : [];
  }).slice(0, 3);
  const total = f.tree?.projects ?? 0;
  if (projects.length) out.push({ name: "Your projects", lines: total > projects.length ? [...projects, `${total} projects in all.`] : projects });
  const repos = (f.top_repos ?? []).flatMap((r) => plainWelcomeText(r.name) ?? []).slice(0, 3);
  if (repos.length) out.push({ name: "Your repos", lines: repos });
  if (f.harness) {
    const keys: Record<WelcomeHarnessId, keyof NonNullable<WelcomeBriefFields["harness"]>["counts"]> = { "claude-code": "claude_code", codex: "codex", cursor: "cursor" };
    // Each harness on its own line, the primary first, so no count sits under another harness's name.
    const primary = f.harness.primary;
    const lines = [primary, ...(Object.keys(keys) as WelcomeHarnessId[]).filter((h) => h !== primary)]
      .filter((h) => f.harness!.counts[keys[h]] > 0)
      .map((h) => `${WELCOME_HARNESS_NAME[h]} · ${sessions(f.harness!.counts[keys[h]])}`);
    if (lines.length) out.push({ name: "Where you work", lines });
  }
  if (f.tree) {
    const t = f.tree;
    const lines = [
      ...(t.companies ? [`${t.companies} ${t.companies === 1 ? "company" : "companies"}`] : []),
      ...(t.projects ? [`${t.projects} ${t.projects === 1 ? "project" : "projects"}`] : []),
      ...(t.knowledge_files ? [`${t.knowledge_files} knowledge ${t.knowledge_files === 1 ? "file" : "files"}`] : []),
    ];
    if (lines.length) out.push({ name: "Your HQ", lines });
  }
  return out;
}

/**
 * The welcome edition drawn from brief.json `welcome` (US-019). The primary
 * action is IF YOU DO ONE THING, the other actions are the watch list, recent
 * work is the timeline, and projects, repos, the harness and the tree are the
 * sections. Each component shows only when its field is present, and no raw
 * text (a path, a stack trace, a prompt) reaches the page.
 */
function welcomeFieldsEdition(
  input: BriefInput,
  f: WelcomeBriefFields,
  error: boolean,
  company: WelcomeEditionSection[],
): WelcomeEdition {
  const now = new Date(input.now);
  // Every open action names its harness, so the button opens that one and nothing else.
  const target = f.harness?.action.harness ?? f.harness?.primary ?? "claude-code";
  const listed = plainActions(f.actions ?? []).map((a) => (a.kind === "open_harness" ? { ...a, harness: a.harness ?? target } : a));
  const actions = [...listed];
  if (f.harness && !actions.some((a) => a.kind === "open_harness")) actions.push(...plainActions([f.harness.action]));
  const lead = primaryAction(listed) ?? primaryAction(actions);
  const cards: WelcomeEditionCard[] = [];
  if (lead) {
    cards.push({
      id: "one-thing",
      pill: WELCOME_ONE_THING,
      kicker: actionKicker(lead, f),
      // The reason, or no title at all: the button already carries the label.
      title: plainWelcomeText(lead.reason) ?? "",
      lines: [],
      label: lead.label,
      action: welcomeAction(lead),
    });
  }
  const watch = actions.filter((a) => a !== lead);
  if (watch.length) {
    cards.push({
      id: "watch",
      pill: null,
      kicker: `Watch · ${watch.length}`,
      title: "",
      lines: [],
      label: null,
      action: null,
      rows: watch.map((a) => ({ id: a.id, title: a.label, detail: plainWelcomeText(a.reason), action: welcomeAction(a) })),
    });
  }
  const work = (f.recent_work ?? []).flatMap((w, i): WelcomeEditionRow[] => {
    const title = plainWelcomeText(w.title);
    if (!title) return [];
    const detail = [plainWelcomeText(w.project), w.harness ? WELCOME_HARNESS_NAME[w.harness] : null, dayOf(w.at)].filter(Boolean).join(" · ");
    return [{ id: `work-${i}`, title, detail: detail || null, action: null }];
  });
  const total = f.sessions?.total ?? 0;
  if (work.length) {
    cards.push({ id: "timeline", pill: null, kicker: WELCOME_RECENT_WORK, title: "", lines: [], label: null, action: null, rows: work });
  } else if (total > 0) {
    const days = f.sessions?.days_seen ?? 0;
    cards.push({
      id: "timeline",
      pill: null,
      kicker: WELCOME_RECENT_WORK,
      title: days ? `${sessions(total)} over ${days} ${days === 1 ? "day" : "days"}` : sessions(total),
      lines: [],
      label: null,
      action: null,
    });
  }
  const note = f.note ? (plainWelcomeText(f.note) ?? WELCOME_NOTE_FAILED) : error ? WELCOME_NOTE_FAILED : editionNote(input);
  return {
    zero: false,
    headline: plainWelcomeText(f.headline) ?? welcomeGreeting(now, input.userName),
    sub: WELCOME_FIELDS_SUB,
    cards,
    sections: [...company, ...welcomeSections(f)],
    note,
    welcome: true,
  };
}

/** What the edition needs from brief.json `welcome`. */
export interface WelcomeEditionSource {
  fields: WelcomeBriefFields;
  /** The welcome enrichment failed in part (brief.json `welcome.error`). */
  error?: boolean;
}

/**
 * The edition for this brief. The first open decision leads, the calendar
 * fills the day card and the last other decision is the work to pick up.
 * With no company the page is the getting-started edition (zero variant).
 */
export function welcomeEdition(
  input: BriefInput,
  prompts: Record<string, string> = {},
  labels: ReadonlyMap<string, string> = new Map(),
  welcome?: WelcomeEditionSource | null,
): WelcomeEdition {
  const now = new Date(input.now);
  const companies = input.companies.filter((c) => c.trim());
  if (welcome && hasComponents(welcome.fields)) {
    // A company shows only when it has a decision to read; the welcome components carry the rest.
    const owner = (d: BriefDecision) => companyName(d.origin?.companyUid?.trim() || companies[0] || "", labels);
    const names = [...new Set(companies.map((slug) => companyName(slug, labels)))].slice(0, 3);
    const company = names.flatMap((name): WelcomeEditionSection[] => {
      const d = input.decisions.find((x) => owner(x) === name);
      if (!d) return [];
      const title = plainTitle(d, name);
      return [{ name, lines: [title, ...plainLines(d, title)] }];
    });
    return welcomeFieldsEdition(input, welcome.fields, !!welcome.error, company);
  }
  if (!companies.length) {
    return {
      zero: true,
      headline: WELCOME_EDITION_ZERO_HEADLINE,
      sub: WELCOME_EDITION_ZERO_SUB,
      cards: [
        {
          id: "task",
          pill: null,
          kicker: "Personal · A useful first step",
          title: "Give your agent one small task.",
          lines: ["Ask it to organize your notes, review a file, or plan the next hour."],
          label: null,
          action: null,
        },
        {
          id: "context",
          pill: null,
          kicker: "Your context",
          title: "Start with the work you have.",
          lines: ["Connect a tool whenever you want a richer brief."],
          label: null,
          action: null,
        },
      ],
      sections: [
        { name: "A space for your team", lines: ["Start or join a company when you have work to share."] },
        { name: "Your brief belongs to you.", lines: ["No company is needed. Your personal work always has a place here."] },
      ],
      note: null,
    };
  }

  // A decision belongs to the company its origin names; one with no company is the lead company's.
  const owner = (d: BriefDecision) => companyName(d.origin?.companyUid?.trim() || companies[0]!, labels);
  const [first, ...rest] = input.decisions;
  const work = rest.length ? rest[rest.length - 1]! : null;
  const onCards = new Set([first?.id, work?.id].filter((id): id is string => !!id));

  // Each company lists its first item not on a card, in brief order, with its own line.
  const names = [...new Set(companies.map((slug) => companyName(slug, labels)))].slice(0, 3);
  const shown = new Set(onCards);
  // A company with nothing left to list has no section; an empty-state line adds nothing.
  const sections = names.flatMap((name): WelcomeEditionSection[] => {
    const next = input.decisions.find((d) => owner(d) === name && !onCards.has(d.id));
    if (!next) return [];
    shown.add(next.id);
    return [{ name, lines: [plainTitle(next, name), ...plainLines(next, plainTitle(next, name))] }];
  });

  const cards: WelcomeEditionCard[] = [];
  if (first) {
    cards.push({
      id: "decision",
      pill: "Your decision",
      kicker: owner(first),
      title: plainTitle(first, owner(first)),
      lines: plainLines(first, plainTitle(first, owner(first))),
      label: "Review the decision",
      action: launch(first, prompts),
    });
  }
  // The agenda card counts the distinct things on this page: a decision card and a project
  // row about the same piece of work (one thread) are one thing. Named by their companies.
  const onPage = input.decisions.filter((d) => shown.has(d.id));
  const things = new Set(onPage.map((d) => d.thread?.trim() || `id:${d.id}`));
  const shownNames = [...new Set(onPage.map(owner))];
  const day = dayCard(input, now, things.size, shownNames);
  if (day) cards.push(day);
  if (work) {
    cards.push({
      id: "work",
      pill: null,
      kicker: `Pick up your work · ${owner(work)}`,
      title: plainTitle(work, owner(work)),
      lines: plainLines(work, plainTitle(work, owner(work))),
      label: "Pick it up",
      action: launch(work, prompts),
    });
  }

  return {
    zero: false,
    headline: welcomeGreeting(now, input.userName),
    sub: WELCOME_EDITION_SUB,
    cards,
    sections,
    note: editionNote(input),
  };
}
