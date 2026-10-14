/**
 * Personal Secrets and Connections (console-rail US-033).
 *
 * Reuses the US-029 secret sheets: values are stripped with publicSecret
 * before a row exists, and share sheets carry the name only. The page
 * paints from the personal cache and refreshes after the first frame.
 * Bot policy on a connection is Allowed, Ask first, or Never.
 */

import {
  publicSecret,
  type SecretRow,
} from "../company/files-connect/files-connect-model.js";
import { registerAccountCache } from "../common/account-caches.js";

export const metadata = {
  performanceBudget: {
    scrollDroppedFramesPct: 0.01,
    worstFrameMs: 33,
  },
};

export const BOT_POLICIES = ["allowed", "ask", "never"] as const;
export type BotPolicy = (typeof BOT_POLICIES)[number];

export const BOT_POLICY_LABEL: Record<BotPolicy, string> = {
  allowed: "Allowed",
  ask: "Ask first",
  never: "Never",
};

export function clampBotPolicy(value: string): BotPolicy {
  if (value === "allowed" || value === "allow") return "allowed";
  if (value === "never") return "never";
  return "ask";
}

export interface PersonalSecret extends SecretRow {
  scope: "Personal";
  usedBy: string;
  created: string;
}

export interface ConnectionBot {
  id: string;
  name: string;
  detail: string;
  policy: BotPolicy;
  where: string;
}

export interface PersonalConnection {
  id: string;
  name: string;
  mark: string;
  detail: string;
  status: "connected" | "reconnect" | "available";
  scopes: string;
  lastUsed: string;
  account: string;
  /** Secret name only. Never a value. */
  secretName: string;
  policy: BotPolicy;
  mcpServer: string;
  mcpNote: string;
  local: boolean;
  tools: string;
  bots: ConnectionBot[];
}

export interface PersonalRailCache {
  secrets: PersonalSecret[];
  connections: PersonalConnection[];
}

const caches = new Map<string, PersonalRailCache>();
registerAccountCache(() => caches.clear());

export function readPersonalRailCache(owner: string): PersonalRailCache | null {
  return caches.get(owner) ?? null;
}

export function writePersonalRailCache(owner: string, value: PersonalRailCache): void {
  if (owner) caches.set(owner, value);
}

/** Drop every cached personal page (sign-out and tests). */
export function clearPersonalRailCache(): void {
  caches.clear();
}

export function emptyPersonalRail(): PersonalRailCache {
  return { secrets: [], connections: [] };
}

/**
 * Design fixture for the perf harness and tests only. The running app never
 * paints these rows; PersonalRailPage reads them only when `fixtures` is set.
 */
export function fixturePersonalRail(): PersonalRailCache {
  return {
    secrets: [
      { id: "github", name: "GITHUB_TOKEN", kind: "standard", version: "v5", host: "", scope: "Personal", rotated: "6d ago", apps: "hq-sync, deacon, nightly-qa", readers: "you · 2 bots", usedBy: "hq run, hq secrets exec, 2 bots", created: "Jan 8 · by you" },
      { id: "anthropic", name: "ANTHROPIC_API_KEY", kind: "proxy", version: "v3", host: "api.anthropic.com", scope: "Personal", rotated: "29d ago", apps: "Outpost jobs (3)", readers: "you", usedBy: "Outpost jobs", created: "Mar 2 · by you" },
      { id: "openai", name: "OPENAI_API_KEY", kind: "proxy", version: "v2", host: "api.openai.com", scope: "Personal", rotated: "29d ago", apps: "grok-worker, cut30", readers: "you", usedBy: "grok-worker", created: "Mar 2 · by you" },
      { id: "screenpipe", name: "SCREENPIPE_TOKEN", kind: "standard", version: "v1", host: "", scope: "Personal", rotated: "112d ago", apps: "recall", readers: "you", usedBy: "recall", created: "May 1 · by you" },
      { id: "vercel", name: "VERCEL_TOKEN", kind: "standard", version: "v1", host: "", scope: "Personal", rotated: "never", apps: "—", readers: "you", usedBy: "—", created: "Jun 4 · by you" },
    ],
    connections: [
      {
        id: "github",
        name: "GitHub",
        mark: "GH",
        detail: "@coreyepstein · indigoai-us, liverecover",
        status: "connected",
        scopes: "repo · workflow · read:org",
        lastUsed: "14m",
        account: "@coreyepstein · since Jan 8",
        secretName: "GITHUB_TOKEN",
        policy: "ask",
        mcpServer: "github-mcp · v1.9",
        mcpNote: "Reviewed · pinned v1.9",
        local: false,
        tools: "9 · 4w",
        bots: [
          { id: "deacon", name: "deacon", detail: "push, open PRs", policy: "allowed", where: "hq-desktop-app" },
          { id: "scout", name: "scout", detail: "read only", policy: "ask", where: "this Mac" },
        ],
      },
      {
        id: "google",
        name: "Google",
        mark: "GO",
        detail: "corey@vyg.ai · Gmail, Calendar, Drive",
        status: "connected",
        scopes: "gmail.readonly · calendar · drive.file",
        lastUsed: "1h",
        account: "corey@vyg.ai",
        secretName: "GOOGLE_OAUTH",
        policy: "ask",
        mcpServer: "google-mcp · v2.0",
        mcpNote: "Reviewed · pinned v2.0",
        local: false,
        tools: "11 · 5w",
        bots: [{ id: "deacon", name: "deacon", detail: "calendar read, gmail read", policy: "ask", where: "meeting-prep" }],
      },
      {
        id: "slack",
        name: "Slack",
        mark: "SL",
        detail: "indigo.slack.com as you · token expired Sep 28",
        status: "reconnect",
        scopes: "chat:write · search:read · users:read",
        lastUsed: "3d",
        account: "indigo.slack.com",
        secretName: "SLACK_USER_TOKEN",
        policy: "never",
        mcpServer: "slack-mcp · v2.3",
        mcpNote: "paused · reconnect Slack",
        local: false,
        tools: "4 · 2w",
        bots: [{ id: "deacon", name: "deacon", detail: "post as you", policy: "ask", where: "#dev-standup" }],
      },
      {
        id: "linear",
        name: "Linear",
        mark: "LN",
        detail: "corey · Indigo workspace",
        status: "connected",
        scopes: "issues:read · issues:write",
        lastUsed: "yesterday",
        account: "corey · Indigo",
        secretName: "LINEAR_API_KEY",
        policy: "ask",
        mcpServer: "linear-mcp · v1.2",
        mcpNote: "Reviewed · pinned v1.2",
        local: false,
        tools: "5 · 2w",
        bots: [{ id: "deacon", name: "deacon", detail: "update_issue", policy: "ask", where: "DESK project" }],
      },
      {
        id: "screenpipe",
        name: "Screenpipe",
        mark: "SP",
        detail: "local · this Mac",
        status: "connected",
        scopes: "search",
        lastUsed: "2h",
        account: "this Mac",
        secretName: "SCREENPIPE_TOKEN",
        policy: "allowed",
        mcpServer: "screenpipe-mcp · local",
        mcpNote: "community · runs with the app",
        local: true,
        tools: "3 · 0w",
        bots: [{ id: "scout", name: "scout", detail: "search_screen", policy: "allowed", where: "/recall" }],
      },
      {
        id: "onepassword",
        name: "1Password",
        mark: "1P",
        detail: "service account · HQ vault only",
        status: "connected",
        scopes: "items:read · HQ vault",
        lastUsed: "6d",
        account: "HQ vault",
        secretName: "OP_SERVICE_ACCOUNT",
        policy: "never",
        mcpServer: "none",
        mcpNote: "no MCP · secrets on rotate",
        local: false,
        tools: "—",
        bots: [],
      },
      {
        id: "notion",
        name: "Notion",
        mark: "NT",
        detail: "HQ Reviewed · pages, databases",
        status: "available",
        scopes: "—",
        lastUsed: "",
        account: "",
        secretName: "",
        policy: "ask",
        mcpServer: "none",
        mcpNote: "not connected",
        local: false,
        tools: "—",
        bots: [],
      },
    ],
  };
}

/** Keep only personal-scope rows. Company grants stay in the company pane. */
export function personalSecretsOnly(rows: readonly SecretRow[]): PersonalSecret[] {
  return rows
    .filter((row) => row.scope.trim().toLowerCase() === "personal")
    .map((row) => ({
      ...row,
      scope: "Personal" as const,
      usedBy: row.apps,
      created: "—",
    }));
}

/** Build a personal row from an API record. Drops the value and any company scope. */
export function personalSecretFromRaw(raw: Record<string, unknown>): PersonalSecret | null {
  const row = publicSecret(raw);
  if (!row) return null;
  const scoped = personalSecretsOnly([row]);
  return scoped[0] ?? null;
}

export function filterPersonalSecrets(
  rows: readonly PersonalSecret[],
  tab: "all" | "standard" | "proxy" | "stale",
  query: string,
): PersonalSecret[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (tab === "standard" && row.kind !== "standard") return false;
    if (tab === "proxy" && row.kind !== "proxy") return false;
    if (tab === "stale" && !/never|9\d|1\d{2}/.test(row.rotated)) return false;
    if (!q) return true;
    return `${row.name} ${row.apps}`.toLowerCase().includes(q);
  });
}

/** OWNER-R36: the Secrets header pills (Mode, and the Not rotated in 90 d toggle). */
export interface SecretFilterPills {
  mode: "all" | "standard" | "proxy";
  stale: boolean;
}

export const DEFAULT_SECRET_PILLS: SecretFilterPills = { mode: "all", stale: false };

export function secretPillsAreDefault(pills: SecretFilterPills): boolean {
  return pills.mode === "all" && !pills.stale;
}

/** Mode and staleness combine; the old side list could only pick one. */
export function filterPersonalSecretsBy(
  rows: readonly PersonalSecret[],
  pills: SecretFilterPills,
  query: string,
): PersonalSecret[] {
  const byMode = filterPersonalSecrets(rows, pills.mode, query);
  return pills.stale ? filterPersonalSecrets(byMode, "stale", "") : byMode;
}

export function filterConnections(
  rows: readonly PersonalConnection[],
  tab: "connected" | "available" | "agents" | "attention",
  query: string,
): PersonalConnection[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (tab === "connected" && row.status !== "connected" && row.status !== "reconnect") return false;
    if (tab === "available" && row.status !== "available") return false;
    if (tab === "agents" && row.mcpServer === "none" && row.bots.length === 0) return false;
    if (tab === "attention" && row.status !== "reconnect") return false;
    if (!q) return true;
    return `${row.name} ${row.detail} ${row.mcpServer}`.toLowerCase().includes(q);
  });
}

export function execSnippet(name: string): string {
  return `hq secrets exec --only ${name}`;
}

export function secretHasValue(row: PersonalSecret | Record<string, unknown>): boolean {
  return "value" in row && row.value != null && String(row.value).length > 0;
}

function relativeDay(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso.trim() || "—";
  const days = Math.max(0, Math.floor((now - at) / 86_400_000));
  return days === 0 ? "today" : `${days}d ago`;
}

/**
 * Rows from the personal vault, loaded through the same secrets source the
 * company pane uses with the personal slug. The desktop returns groups shaped
 * `{ env, items: [{ key, upd, rot }] }`; every row in the personal vault is
 * personal. Flat API rows with an explicit scope go through
 * personalSecretFromRaw. Names and dates only.
 */
export function personalSecretsFromSource(
  loaded: readonly unknown[],
  now: number = Date.now(),
): PersonalSecret[] {
  const out: PersonalSecret[] = [];
  const seen = new Set<string>();
  for (const entry of loaded) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (Array.isArray(record.items)) {
      const group = typeof record.env === "string" ? record.env.trim() : "";
      for (const item of record.items) {
        if (!item || typeof item !== "object") continue;
        const raw = item as Record<string, unknown>;
        const key = typeof raw.key === "string" ? raw.key.trim() : "";
        if (!key) continue;
        const name =
          group && group !== "default" && !key.startsWith(`${group}/`) ? `${group}/${key}` : key;
        if (seen.has(name)) continue;
        seen.add(name);
        const rot = typeof raw.rot === "string" ? raw.rot : "";
        const upd = typeof raw.upd === "string" ? raw.upd : "";
        out.push({
          id: name,
          name,
          kind: "standard",
          version: "v1",
          host: "",
          scope: "Personal",
          rotated: rot || upd ? relativeDay(rot || upd, now) : "never",
          apps: "—",
          readers: "you",
          usedBy: "—",
          created: "—",
        });
      }
      continue;
    }
    const row = personalSecretFromRaw(record);
    if (row && !seen.has(row.name)) {
      seen.add(row.name);
      out.push(row);
    }
  }
  return out;
}

/** Plain reason for a failed secrets load. Never the raw transport text. */
export function personalSecretsErrorReason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err ?? "");
  if (/AUTH_REQUIRED|auth:|unauthori[sz]ed|\b401\b|\b403\b/i.test(text)) {
    return "Your sign-in expired. Sign in again to see your secrets.";
  }
  if (/not connected to cloud|was not found|invalid identity/i.test(text)) {
    return "Your personal vault is not connected to HQ yet.";
  }
  if (/not available on this platform|no platform api/i.test(text)) {
    return "Secrets are not available in this window.";
  }
  return "Could not reach your vault. Check your connection and retry.";
}
