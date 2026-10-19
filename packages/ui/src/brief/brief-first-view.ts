/**
 * The first view: the welcome Daily Brief's data model (S3 of the
 * welcome-as-daily-brief plan). `buildFirstView` maps brief.json `welcome`
 * (the Core 1432 contract, with the 16.0.30 keys as fallbacks) and the
 * newest import report into what each Daily Brief slot shows: the greeting
 * and stat pills, the connect card, IF YOU DO ONE THING, recent work, where
 * you work and the watch list. Pure: no fetches, no Svelte.
 *
 * Also home to `runnableEdition`, the "only actions this host can run" rule
 * the welcome edition uses.
 */

import {
  WELCOME_HARNESS_NAME,
  parseWelcomeFields,
  primaryAction,
  type WelcomeAction,
  type WelcomeBriefFields,
  type WelcomeHarness,
  type WelcomeHarnessId,
} from "./brief-welcome-contract.js";
import type { WelcomeEdition, WelcomeEditionAction, WelcomeEditionCard } from "./brief-welcome-edition.js";
import { welcomeGreeting, welcomeName } from "./brief-welcome-names.js";

export const watchKicker = (n: number) => `Watch · ${n}`;

/**
 * The welcome edition as this host can run it. A watch row that opens a
 * harness this host cannot open is dropped, so no row offers to open a tool
 * it cannot. When IF YOU DO ONE THING cannot run, the first watch action that
 * can takes its place, so a lead card always carries an action.
 */
export function runnableEdition(edition: WelcomeEdition, canRun: (action: WelcomeEditionAction | null) => boolean): WelcomeEdition {
  if (!edition.welcome) return edition;
  const deadOpen = (a: WelcomeEditionAction | null) => a?.kind === "welcome" && a.action.kind === "open_harness" && !canRun(a);
  let rows = edition.cards.find((c) => c.id === "watch")?.rows?.filter((r) => !deadOpen(r.action)) ?? [];
  const cards = edition.cards.flatMap((card): WelcomeEditionCard[] => {
    if (card.id === "one-thing" && !canRun(card.action)) {
      const next = rows.find((r) => r.lead && canRun(r.action));
      if (!next?.lead) return [];
      rows = rows.filter((r) => r !== next);
      return [next.lead];
    }
    return [card];
  });
  return {
    ...edition,
    cards: cards.flatMap((card) => (card.id !== "watch" ? [card] : rows.length ? [{ ...card, kicker: watchKicker(rows.length), rows }] : [])),
  };
}

/** The connect card's integration rows lead with these, by name, in this order (frame 1). */
const INTEGRATION_ORDER: readonly string[] = ["github", "linear", "slack"];

/** What the connect card's Connect button does. 'expand' opens the connect flow inside the card; 'settings' opens the Settings integrations page. */
export type FirstViewConnectMode = "expand" | "settings";
/** The owner has not decided yet; switching to the Settings page is this one line. */
export const FIRST_VIEW_CONNECT_MODE: FirstViewConnectMode = "expand";

export type FirstViewCard = "sunrise" | "connect" | "oneThing" | "recentWork";
/** The welcome card order in the Daily Brief slots. */
export const FIRST_VIEW_CARD_ORDER: readonly FirstViewCard[] = ["sunrise", "connect", "oneThing", "recentWork"];

/** The sessions block of an import report (contract 2026-10-19). */
export interface ImportReportSessions {
  total: number;
  claude: number;
  codex: number;
  cursor: number;
  days_seen: number;
  first_at: string | null;
  last_at: string | null;
}

/**
 * `<hq>/workspace/imports/<stamp>/report.json`, as the desktop tree step or
 * `/import-context` writes it. An older report has no sessions block.
 */
export interface ImportReport {
  scan_id: string;
  counts: Record<string, number>;
  sessions: ImportReportSessions | null;
  /** The harnesses found, as harness ids. */
  tools: WelcomeHarnessId[];
  /** Top project names; never paths. */
  projects: string[];
  source: string | null;
  written_at: string | null;
}

const object = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const when = (value: unknown): string | null => {
  const t = str(value);
  return t && Number.isFinite(Date.parse(t)) ? t : null;
};
const HARNESSES: readonly WelcomeHarnessId[] = ["claude-code", "codex", "cursor"];
const harnessId = (value: unknown): WelcomeHarnessId | null => {
  const id = typeof value === "string" ? value.trim().toLowerCase().replace(/[_\s]+/g, "-") : null;
  return HARNESSES.includes(id as WelcomeHarnessId) ? (id as WelcomeHarnessId) : null;
};
/** A project name that is not a path: no separator, no leading ~, no drive letter. welcomeName drops home paths and credentials. */
const projectName = (value: unknown): string | null => {
  const name = welcomeName(typeof value === "string" ? value : null, 80);
  return name && !/[\\/]|^~|^[a-z]:/i.test(name) ? name : null;
};
const REPORT_PROJECTS = 10;

/** An import report from its parsed JSON; null when it is not an object. Unknown or malformed fields read as empty. */
export function parseImportReport(raw: unknown): ImportReport | null {
  const row = object(raw);
  if (!row) return null;
  const counts = Object.fromEntries(Object.entries(object(row.counts) ?? {}).map(([k, v]) => [k, count(v)]));
  const s = object(row.sessions);
  const tools = Array.isArray(row.tools) ? [...new Set(row.tools.flatMap((t) => harnessId(t) ?? []))] : [];
  const projects = Array.isArray(row.projects) ? [...new Set(row.projects.flatMap((p) => projectName(p) ?? []))].slice(0, REPORT_PROJECTS) : [];
  return {
    scan_id: str(row.scan_id) ?? "",
    counts,
    sessions: s
      ? {
          total: count(s.total),
          claude: count(s.claude),
          codex: count(s.codex),
          cursor: count(s.cursor),
          days_seen: count(s.days_seen),
          first_at: when(s.first_at),
          last_at: when(s.last_at),
        }
      : null,
    tools,
    projects,
    source: str(row.source),
    written_at: when(row.written_at),
  };
}

export interface FirstViewInput {
  /** brief.json `welcome` as read (Core 1432 or 16.0.30 shape); null when the brief has none. */
  welcome: Record<string, unknown> | null;
  /** The newest import report, when one exists. */
  importReport?: ImportReport | null;
  /** Whether this host can run an action (open this harness, for one). Defaults to every action. */
  canRun?: (action: WelcomeAction) => boolean;
  now: string | Date;
  userName?: string | null;
  /** Integrations the host suggests (the "Your apps" scan), by slug. */
  suggestedApps?: readonly { slug: string; name: string }[];
  /** AI apps already connected, so the connect card leaves them out. */
  connectedAiApps?: readonly WelcomeHarnessId[];
  connectMode?: FirstViewConnectMode;
}

export interface FirstViewPills {
  sessions: number | null;
  days: number | null;
  projects: number | null;
  tools: number | null;
}

export interface FirstViewIntegration {
  slug: string;
  name: string;
  /** Core's connect_integration action, when Core named this one; null for a host suggestion. */
  action: WelcomeAction | null;
}

export interface FirstViewAiApp {
  harness: WelcomeHarnessId;
  name: string;
  sessions: number;
}

export interface FirstViewConnect {
  mode: FirstViewConnectMode;
  integrations: FirstViewIntegration[];
  /** Core's connect_ai_apps action; null when Core did not offer it. */
  aiAction: WelcomeAction | null;
  /** The AI apps not yet connected, shown with connect_ai_apps. */
  aiApps: FirstViewAiApp[];
  harnessCounts: WelcomeHarness["counts"];
}

export interface FirstViewWork {
  title: string;
  project: string | null;
  harness: WelcomeHarnessId | null;
  tool: string | null;
  at: string;
}

export interface FirstViewProject {
  name: string;
  sessions: number | null;
}

export interface FirstViewTool {
  harness: WelcomeHarnessId;
  name: string;
  sessions: number;
}

export interface FirstView {
  greeting: string;
  /** The session count the greeting line and pill use. */
  count: number;
  /** "N sessions over N days in A and B. Top threads: x, y, z."; null when hidden. */
  countLine: string | null;
  /** The tools found, by name: the Tools pill, its caption and the count line. */
  tools: string[];
  pills: FirstViewPills;
  connect: FirstViewConnect;
  oneThing: WelcomeAction | null;
  recentWork: FirstViewWork[];
  topProjects: FirstViewProject[];
  whereYouWork: { tools: FirstViewTool[]; open: WelcomeAction | null };
  watchList: WelcomeAction[];
  cardOrder: readonly FirstViewCard[];
}

const LIMIT = 5;
/** Actions the connect card and where-you-work carry, so the watch list leaves them out. */
const ELSEWHERE = new Set<WelcomeAction["kind"]>(["connect_integration", "connect_ai_apps", "open_harness"]);
const COUNT_KEY: Record<WelcomeHarnessId, keyof WelcomeHarness["counts"]> = { "claude-code": "claude_code", codex: "codex", cursor: "cursor" };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** "A", "A and B", "A, B, and C". */
function listOf(names: readonly string[]): string {
  if (names.length < 3) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * The session count and its days: the import report's sessions.total, then
 * sessions.imported + sessions.local, then sessions.total. The days always
 * come from the same source as the count; a source with no days gives 0,
 * so the count line never pairs one source's sessions with another's days.
 */
function sessionCount(f: WelcomeBriefFields, report: ImportReport | null): { total: number; days: number } {
  if (report?.sessions?.total) return { total: report.sessions.total, days: report.sessions.days_seen };
  const s = f.sessions;
  const days = s?.days_seen ?? 0;
  if (s && (s.imported !== undefined || s.local !== undefined)) {
    const sum = (s.imported ?? 0) + (s.local ?? 0);
    if (sum > 0) return { total: sum, days };
  }
  return { total: s?.total ?? 0, days };
}

/**
 * True when "Bring in your past work" must not show: an import report
 * exists, sessions were imported, the report counted sessions, past
 * conversations were imported, or any session was found (the contract's
 * rule both sides keep).
 */
function pastWorkDone(f: WelcomeBriefFields, welcome: Record<string, unknown> | null, report: ImportReport | null, total: number): boolean {
  const legacyImport = object(welcome?.import);
  const harness = f.harness ? f.harness.counts.claude_code + f.harness.counts.codex + f.harness.counts.cursor : 0;
  return (
    // A report covers "the report counted sessions" too.
    !!report ||
    (f.sessions?.imported ?? 0) > 0 ||
    count(legacyImport?.conversations) > 0 ||
    total > 0 ||
    (f.sessions?.local ?? 0) > 0 ||
    harness > 0
  );
}

/** The welcome actions with plain labels, each open action naming its harness, and the harness's own open action when Core listed none. */
function welcomeActions(f: WelcomeBriefFields): WelcomeAction[] {
  const target = f.harness?.action.harness ?? f.harness?.primary ?? "claude-code";
  const plain = (a: WelcomeAction): WelcomeAction[] => {
    const label = welcomeName(a.label);
    return label ? [{ ...a, label }] : [];
  };
  const listed = (f.actions ?? []).flatMap(plain).map((a) => (a.kind === "open_harness" ? { ...a, harness: a.harness ?? target } : a));
  if (f.harness && !listed.some((a) => a.kind === "open_harness")) listed.push(...plain(f.harness.action));
  return listed;
}

/** The harnesses with sessions, the primary first; legacy `apps` names when no counts were read. */
function toolsFound(f: WelcomeBriefFields, welcome: Record<string, unknown> | null, report: ImportReport | null): WelcomeHarnessId[] {
  if (report?.tools.length) return report.tools;
  if (f.harness) {
    const primary = f.harness.primary;
    const counts = f.harness.counts;
    return [primary, ...HARNESSES.filter((h) => h !== primary)].filter((h) => counts[COUNT_KEY[h]] > 0);
  }
  const apps = Array.isArray(welcome?.apps) ? welcome.apps : [];
  return [...new Set(apps.flatMap((a) => harnessId(a) ?? []))];
}

/** The first-view model for the Daily Brief slots. */
export function buildFirstView(input: FirstViewInput): FirstView {
  const welcome = input.welcome ?? null;
  const f: WelcomeBriefFields = welcome ? parseWelcomeFields(welcome) : {};
  const report = input.importReport ?? null;
  const canRun = input.canRun ?? (() => true);
  const now = input.now instanceof Date ? input.now : new Date(input.now);

  const { total, days } = sessionCount(f, report);
  // One source for every count on the page: the report's sessions block when
  // it has one, else the welcome row. Never one source's total beside the
  // other's per-tool counts.
  const fromReport = report?.sessions?.total ? report.sessions : null;
  const counts: WelcomeHarness["counts"] = fromReport
    ? { claude_code: fromReport.claude, codex: fromReport.codex, cursor: fromReport.cursor }
    : f.harness?.counts ?? { claude_code: f.sessions?.claude ?? 0, codex: f.sessions?.codex ?? 0, cursor: f.sessions?.cursor ?? 0 };
  const tools = fromReport && !report?.tools.length ? HARNESSES.filter((h) => counts[COUNT_KEY[h]] > 0) : toolsFound(f, welcome, report);

  const fromWelcome = (f.top_projects ?? []).flatMap((p): FirstViewProject[] => {
    const name = welcomeName(p.name);
    return name ? [{ name, sessions: p.sessions || null }] : [];
  });
  const topProjects = (fromWelcome.length ? fromWelcome : (report?.projects ?? []).map((name) => ({ name, sessions: null }))).slice(0, LIMIT);
  const projectCount = f.tree?.projects || fromWelcome.length || report?.projects?.length || 0;

  // The past-work step goes first, so it can never be the lead or a watch row.
  const done = pastWorkDone(f, welcome, report, total);
  const actions = welcomeActions(f).filter((a) => !(done && a.kind === "import_history")).filter((a) => canRun(a));
  const oneThing = primaryAction(actions);

  const open = actions.find((a) => a.kind === "open_harness") ?? null;
  const whereTools = tools.flatMap((h): FirstViewTool[] => {
    const sessions = counts[COUNT_KEY[h]];
    return sessions > 0 ? [{ harness: h, name: WELCOME_HARNESS_NAME[h], sessions }] : [];
  });

  const integrations: FirstViewIntegration[] = [];
  for (const a of actions) {
    if (a.kind !== "connect_integration" || !a.integration) continue;
    const name = welcomeName(a.integration.name);
    if (name && !integrations.some((i) => i.slug === a.integration!.slug)) integrations.push({ slug: a.integration.slug, name, action: a });
  }
  for (const s of input.suggestedApps ?? []) {
    const name = welcomeName(s.name);
    if (name && s.slug.trim() && !integrations.some((i) => i.slug === s.slug)) integrations.push({ slug: s.slug, name, action: null });
  }
  // Frame 1's order: GitHub, Linear, Slack first, then the rest in source order (sort is stable).
  const rank = (i: FirstViewIntegration) => {
    const r = INTEGRATION_ORDER.indexOf(i.name.toLowerCase());
    return r < 0 ? INTEGRATION_ORDER.length : r;
  };
  integrations.sort((a, b) => rank(a) - rank(b));
  const aiAction = actions.find((a) => a.kind === "connect_ai_apps") ?? null;
  const connected = new Set(input.connectedAiApps ?? []);
  const aiApps = aiAction
    ? HARNESSES.filter((h) => !connected.has(h)).map((h) => ({ harness: h, name: WELCOME_HARNESS_NAME[h], sessions: counts[COUNT_KEY[h]] }))
    : [];

  const recentWork = (f.recent_work ?? []).flatMap((w): FirstViewWork[] => {
    const title = welcomeName(w.title);
    if (!title) return [];
    return [{ title, project: welcomeName(w.project), harness: w.harness, tool: w.harness ? WELCOME_HARNESS_NAME[w.harness] : null, at: w.at }];
  }).slice(0, LIMIT);

  const watchList = actions.filter((a) => a !== oneThing && !ELSEWHERE.has(a.kind));

  const toolNames = tools.map((h) => WELCOME_HARNESS_NAME[h]);
  const threads = topProjects.slice(0, 3).map((p) => p.name);
  const countLine =
    total === 0 || (total <= 1 && !report)
      ? null
      : [
          `${plural(total, "session", "sessions")}${days ? ` over ${plural(days, "day", "days")}` : ""}${toolNames.length ? ` in ${listOf(toolNames)}` : ""}.`,
          ...(threads.length ? [`Top threads: ${threads.join(", ")}.`] : []),
        ].join(" ");

  return {
    greeting: welcomeGreeting(now, input.userName),
    count: total,
    countLine,
    tools: toolNames,
    pills: {
      sessions: total || null,
      days: days || null,
      projects: projectCount || null,
      tools: tools.length || null,
    },
    connect: { mode: input.connectMode ?? FIRST_VIEW_CONNECT_MODE, integrations, aiAction, aiApps, harnessCounts: counts },
    oneThing,
    recentWork,
    topProjects,
    whereYouWork: { tools: whereTools, open },
    watchList,
    cardOrder: FIRST_VIEW_CARD_ORDER,
  };
}
