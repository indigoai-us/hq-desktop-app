/**
 * The brief.json `welcome` contract (Core writes it, Desktop reads it).
 *
 * Core proposed these fields and Desktop confirmed them (2026-10-19). They
 * extend `welcome` additively: every key the 16.0.30 skill writes stays, and
 * each new key is optional. A component on the welcome edition shows only
 * when its field is present; an absent field hides it, never a placeholder.
 *
 * ```jsonc
 * "welcome": {
 *   // 16.0.30 keys, unchanged
 *   "first_run": true,
 *   "import": { "conversations": 12, "skills": 3 },
 *   "sessions": { "total": 41, "claude": 38, "codex": 3, "days_seen": 9,
 *                 "local": 41, "imported": 12, "cursor": 0 },  // local, imported, cursor: new
 *   "repos": [],
 *   "apps": ["Linear", "Slack"],
 *   "next_steps": [{ "id": "company", "kind": "connect_company", "reason": "..." }],
 *   "getting_started": "...",
 *
 *   // New keys
 *   "headline": "38 projects, most of them in Claude Code.",
 *   "top_projects": [{ "name", "path", "sessions", "last_active_at", "harness" }],  // up to 5
 *   "top_repos":    [{ "name", "path", "sessions", "last_commit_at" }],             // up to 5
 *   "recent_work":  [{ "title", "project", "at", "harness" }],                      // up to 5, newest first
 *   "harness": {
 *     "primary": "claude-code" | "codex" | "cursor",
 *     "counts": { "claude_code": 38, "codex": 3, "cursor": 0 },
 *     "action": { "id": "open-hq-in-harness", "kind": "open_harness",
 *                 "harness": "claude-code", "label": "Open HQ in Claude Code", "launch_prompt": "..." }
 *   },
 *   "actions": [{ "id", "kind", "label", "reason", "launch_prompt", "primary",
 *                 "harness"?: "claude-code",              // open_harness only
 *                 "integration"?: { "slug", "name" } }],
 *   "tree": { "companies": 2, "projects": 38, "knowledge_files": 214 },
 *   "note": "Plain sentence, set when part of the welcome could not be read."
 * }
 * ```
 *
 * Harness ids are hyphenated (claude-code). Core PR 1432's earlier head wrote
 * claude_code, so either spelling reads as claude-code wherever a harness id
 * appears (harness.primary, harness.action.harness, actions[].harness,
 * top_projects[].harness, recent_work[].harness). `harness.counts` keys are
 * underscored; a "claude-code" count key reads the same.
 *
 * `actions[].kind` is one of open_harness, connect_ai_apps,
 * connect_integration, connect_company, import_history, open_tree. At most
 * one action is `primary` and drives IF YOU DO ONE THING: when several are
 * marked, the first marked one wins; with none marked, the first action does.
 *
 * `recent_work` is sorted newest first before the list is capped at five.
 *
 * The 16.0.30 shape (no new keys) still renders: `next_steps` become actions
 * (connect_company, import becomes import_history) and `sessions.claude` /
 * `sessions.codex` / `sessions.cursor` become the harness counts.
 */

export type WelcomeHarnessId = "claude-code" | "codex" | "cursor";

export type WelcomeActionKind =
  | "open_harness"
  | "connect_ai_apps"
  | "connect_integration"
  | "connect_company"
  | "import_history"
  | "open_tree";

export interface WelcomeProject {
  name: string;
  path: string;
  sessions: number;
  last_active_at: string | null;
  harness: WelcomeHarnessId | null;
}

export interface WelcomeRepo {
  name: string;
  path: string;
  sessions: number;
  last_commit_at: string | null;
}

export interface WelcomeRecentWork {
  title: string;
  project: string | null;
  at: string;
  harness: WelcomeHarnessId | null;
}

export interface WelcomeAction {
  id: string;
  kind: WelcomeActionKind;
  label: string;
  reason: string;
  launch_prompt: string;
  primary: boolean;
  /** open_harness only: the harness the button opens. */
  harness?: WelcomeHarnessId;
  integration?: { slug: string; name: string };
}

export interface WelcomeHarness {
  primary: WelcomeHarnessId;
  counts: { claude_code: number; codex: number; cursor: number };
  action: WelcomeAction & { kind: "open_harness"; harness: WelcomeHarnessId };
}

export interface WelcomeTree {
  companies: number;
  projects: number;
  knowledge_files: number;
}

export interface WelcomeSessions {
  total: number;
  claude: number;
  codex: number;
  days_seen: number;
  cursor?: number;
  local?: number;
  imported?: number;
}

/** The welcome fields the edition draws from. Each is absent when brief.json left it out or it did not parse. */
export interface WelcomeBriefFields {
  headline?: string;
  top_projects?: WelcomeProject[];
  top_repos?: WelcomeRepo[];
  recent_work?: WelcomeRecentWork[];
  harness?: WelcomeHarness;
  actions?: WelcomeAction[];
  tree?: WelcomeTree;
  sessions?: WelcomeSessions;
  note?: string;
}

export const WELCOME_ACTION_KINDS: readonly WelcomeActionKind[] = [
  "open_harness",
  "connect_ai_apps",
  "connect_integration",
  "connect_company",
  "import_history",
  "open_tree",
];
const HARNESSES: readonly WelcomeHarnessId[] = ["claude-code", "codex", "cursor"];
const LIMIT = 5;

/** The names the first-run decision uses. */
export const WELCOME_HARNESS_NAME: Record<WelcomeHarnessId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

/** Core's labels for the 16.0.30 next steps, the same words Core writes for these actions (hq-core-staging c7b8a026). */
export const WELCOME_CONNECT_COMPANY_LABEL = "Create or join a company";
export const WELCOME_IMPORT_LABEL = "Bring in your past work";

const object = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : null);
/** A name, title, label or headline: spaces collapse but line breaks stay, so the edition can hide multi-line text. */
const nameText = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.replace(/[^\S\r\n]+/g, " ").trim() : null);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
const when = (value: unknown): string | null => {
  const t = text(value);
  return t && Number.isFinite(Date.parse(t)) ? t : null;
};
/** A harness id in either spelling: claude_code reads as claude-code. */
const harnessId = (value: unknown): WelcomeHarnessId | null => {
  const id = typeof value === "string" ? value.trim().replace(/_/g, "-") : null;
  return HARNESSES.includes(id as WelcomeHarnessId) ? (id as WelcomeHarnessId) : null;
};
const list = <T>(
  value: unknown,
  one: (row: Record<string, unknown>) => T | null,
  order?: (a: T, b: T) => number,
): T[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const rows = value.flatMap((v) => {
    const row = object(v);
    const parsed = row ? one(row) : null;
    return parsed ? [parsed] : [];
  });
  if (order) rows.sort(order);
  return rows.length ? rows.slice(0, LIMIT) : undefined;
};

function action(row: Record<string, unknown>): WelcomeAction | null {
  const id = text(row.id);
  const kind = WELCOME_ACTION_KINDS.includes(row.kind as WelcomeActionKind) ? (row.kind as WelcomeActionKind) : null;
  const label = nameText(row.label);
  if (!id || !kind || !label) return null;
  const integration = object(row.integration);
  const slug = text(integration?.slug);
  const name = nameText(integration?.name);
  const target = kind === "open_harness" ? harnessId(row.harness) : null;
  return {
    id,
    kind,
    label,
    reason: text(row.reason) ?? "",
    launch_prompt: text(row.launch_prompt) ?? "",
    primary: row.primary === true,
    ...(target ? { harness: target } : {}),
    ...(slug && name ? { integration: { slug, name } } : {}),
  };
}

/** Keeps the first action marked primary; any later mark is dropped. */
function onePrimary(actions: WelcomeAction[] | undefined): WelcomeAction[] | undefined {
  const first = actions?.findIndex((a) => a.primary) ?? -1;
  return actions?.map((a, i) => (a.primary && i !== first ? { ...a, primary: false } : a));
}

function harness(row: Record<string, unknown> | null): WelcomeHarness | undefined {
  const primary = harnessId(row?.primary);
  if (!row || !primary) return undefined;
  const counts = object(row.counts);
  const act = object(row.action);
  const parsed = act ? action({ id: "open-hq-in-harness", ...act, kind: "open_harness" }) : null;
  const target = harnessId(act?.harness) ?? primary;
  return {
    primary,
    counts: { claude_code: count(counts?.claude_code ?? counts?.["claude-code"]), codex: count(counts?.codex), cursor: count(counts?.cursor) },
    action: {
      ...(parsed ?? { id: "open-hq-in-harness", label: `Open HQ in ${WELCOME_HARNESS_NAME[target]}`, reason: "", launch_prompt: "", primary: false }),
      kind: "open_harness",
      harness: target,
    },
  };
}

/** 16.0.30 `next_steps` as contract actions. */
function legacyActions(steps: unknown): WelcomeAction[] | undefined {
  return list(steps, (row) => {
    const reason = text(row.reason) ?? "";
    if (row.kind === "connect_company")
      return { id: text(row.id) ?? "connect-company", kind: "connect_company", label: WELCOME_CONNECT_COMPANY_LABEL, reason, launch_prompt: "", primary: false };
    if (row.kind === "import")
      return { id: text(row.id) ?? "import-history", kind: "import_history", label: WELCOME_IMPORT_LABEL, reason, launch_prompt: "", primary: false };
    return null;
  });
}

/** 16.0.30 `sessions.claude` / `codex` / `cursor` as the harness, when any has a session. The most used wins; a tie goes to the earlier one. */
function legacyHarness(sessions: Record<string, unknown> | null): WelcomeHarness | undefined {
  const counts = { claude_code: count(sessions?.claude), codex: count(sessions?.codex), cursor: count(sessions?.cursor) };
  const order: [WelcomeHarnessId, number][] = [["claude-code", counts.claude_code], ["codex", counts.codex], ["cursor", counts.cursor]];
  const [primary, most] = order.reduce((best, next) => (next[1] > best[1] ? next : best));
  if (!most) return undefined;
  return harness({ primary, counts });
}

/**
 * The contract fields from a brief.json `welcome` object. Unknown kinds,
 * rows without their required keys, and empty lists are dropped, so the
 * component they would fill stays hidden.
 */
export function parseWelcomeFields(row: Record<string, unknown>): WelcomeBriefFields {
  const sessionsRow = object(row.sessions);
  const sessions: WelcomeSessions | undefined = sessionsRow
    ? {
        total: count(sessionsRow.total),
        claude: count(sessionsRow.claude),
        codex: count(sessionsRow.codex),
        days_seen: count(sessionsRow.days_seen),
        ...(typeof sessionsRow.cursor === "number" ? { cursor: count(sessionsRow.cursor) } : {}),
        ...(typeof sessionsRow.local === "number" ? { local: count(sessionsRow.local) } : {}),
        ...(typeof sessionsRow.imported === "number" ? { imported: count(sessionsRow.imported) } : {}),
      }
    : undefined;
  const treeRow = object(row.tree);
  const actions = onePrimary(list(row.actions, action) ?? (Array.isArray(row.actions) ? undefined : legacyActions(row.next_steps)));
  const fields: WelcomeBriefFields = {
    headline: nameText(row.headline) ?? undefined,
    top_projects: list(row.top_projects, (p) => {
      const name = nameText(p.name);
      return name ? { name, path: text(p.path) ?? "", sessions: count(p.sessions), last_active_at: when(p.last_active_at), harness: harnessId(p.harness) } : null;
    }),
    top_repos: list(row.top_repos, (r) => {
      const name = nameText(r.name);
      return name ? { name, path: text(r.path) ?? "", sessions: count(r.sessions), last_commit_at: when(r.last_commit_at) } : null;
    }),
    recent_work: list(row.recent_work, (w) => {
      const title = nameText(w.title);
      const at = when(w.at);
      return title && at ? { title, project: nameText(w.project), at, harness: harnessId(w.harness) } : null;
    }, (a, b) => Date.parse(b.at) - Date.parse(a.at)),
    harness: harness(object(row.harness)) ?? legacyHarness(sessionsRow),
    actions,
    tree: treeRow ? { companies: count(treeRow.companies), projects: count(treeRow.projects), knowledge_files: count(treeRow.knowledge_files) } : undefined,
    sessions,
    note: text(row.note) ?? undefined,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as WelcomeBriefFields;
}

/** The action for IF YOU DO ONE THING: the one marked primary, else the first. */
export function primaryAction(actions: readonly WelcomeAction[] | undefined): WelcomeAction | null {
  if (!actions?.length) return null;
  return actions.find((a) => a.primary) ?? actions[0]!;
}
