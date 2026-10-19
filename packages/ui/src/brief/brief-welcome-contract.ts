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
 *                 "local": 41, "imported": 12 },          // local, imported: new
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
 *                 "integration"?: { "slug", "name" } }],
 *   "tree": { "companies": 2, "projects": 38, "knowledge_files": 214 },
 *   "note": "Plain sentence, set when part of the welcome could not be read."
 * }
 * ```
 *
 * `actions[].kind` is one of open_harness, connect_ai_apps,
 * connect_integration, connect_company, import_history, open_tree. Exactly
 * one action is `primary` and drives IF YOU DO ONE THING; with none marked,
 * the first action does.
 *
 * The 16.0.30 shape (no new keys) still renders: `next_steps` become actions
 * (connect_company, import becomes import_history) and `sessions.claude` /
 * `sessions.codex` become the harness counts.
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

/** The 16.0.30 next-step labels. Same words as the old welcome block and the onboarding copy. */
export const WELCOME_CONNECT_COMPANY_LABEL = "Start or join a company";
export const WELCOME_IMPORT_LABEL = "Import your past work";

const object = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : null);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
const when = (value: unknown): string | null => {
  const t = text(value);
  return t && Number.isFinite(Date.parse(t)) ? t : null;
};
const harnessId = (value: unknown): WelcomeHarnessId | null =>
  HARNESSES.includes(value as WelcomeHarnessId) ? (value as WelcomeHarnessId) : null;
const list = <T>(value: unknown, one: (row: Record<string, unknown>) => T | null): T[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const rows = value.flatMap((v) => {
    const row = object(v);
    const parsed = row ? one(row) : null;
    return parsed ? [parsed] : [];
  });
  return rows.length ? rows.slice(0, LIMIT) : undefined;
};

function action(row: Record<string, unknown>): WelcomeAction | null {
  const id = text(row.id);
  const kind = WELCOME_ACTION_KINDS.includes(row.kind as WelcomeActionKind) ? (row.kind as WelcomeActionKind) : null;
  const label = text(row.label);
  if (!id || !kind || !label) return null;
  const integration = object(row.integration);
  const slug = text(integration?.slug);
  const name = text(integration?.name);
  return {
    id,
    kind,
    label,
    reason: text(row.reason) ?? "",
    launch_prompt: text(row.launch_prompt) ?? "",
    primary: row.primary === true,
    ...(slug && name ? { integration: { slug, name } } : {}),
  };
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
    counts: { claude_code: count(counts?.claude_code), codex: count(counts?.codex), cursor: count(counts?.cursor) },
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

/** 16.0.30 `sessions.claude` / `sessions.codex` as the harness, when either has a session. */
function legacyHarness(sessions: Record<string, unknown> | null): WelcomeHarness | undefined {
  const claude = count(sessions?.claude);
  const codex = count(sessions?.codex);
  if (!claude && !codex) return undefined;
  return harness({ primary: codex > claude ? "codex" : "claude-code", counts: { claude_code: claude, codex, cursor: 0 } });
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
        ...(typeof sessionsRow.local === "number" ? { local: count(sessionsRow.local) } : {}),
        ...(typeof sessionsRow.imported === "number" ? { imported: count(sessionsRow.imported) } : {}),
      }
    : undefined;
  const treeRow = object(row.tree);
  const actions = list(row.actions, action) ?? (Array.isArray(row.actions) ? undefined : legacyActions(row.next_steps));
  const fields: WelcomeBriefFields = {
    headline: text(row.headline) ?? undefined,
    top_projects: list(row.top_projects, (p) => {
      const name = text(p.name);
      return name ? { name, path: text(p.path) ?? "", sessions: count(p.sessions), last_active_at: when(p.last_active_at), harness: harnessId(p.harness) } : null;
    }),
    top_repos: list(row.top_repos, (r) => {
      const name = text(r.name);
      return name ? { name, path: text(r.path) ?? "", sessions: count(r.sessions), last_commit_at: when(r.last_commit_at) } : null;
    }),
    recent_work: list(row.recent_work, (w) => {
      const title = text(w.title);
      const at = when(w.at);
      return title && at ? { title, project: text(w.project), at, harness: harnessId(w.harness) } : null;
    })?.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
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
