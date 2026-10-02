import { deploymentFromApp, type DeployAppsPage } from "../../library/personal-deployments.js";

/**
 * Company Files and connect (console-rail US-029).
 *
 * Vault, Integrations, Secrets, and Deployments share one model so the
 * pages stay out of the boot graph. Views paint from the last cache and
 * refresh after the first frame. Secret values are stripped before any
 * view model is built. Grant and share levels are read or write.
 */

export const metadata = {
  performanceBudget: {
    scrollDroppedFramesPct: 0.01,
    worstFrameMs: 33,
  },
};

export const FILES_CONNECT_PAGES = [
  "vault",
  "integrations",
  "secrets",
  "deployments",
] as const;
export type FilesConnectPageId = (typeof FILES_CONNECT_PAGES)[number];

export const ACCESS_LEVELS = ["read", "write"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export function clampAccess(level: string): AccessLevel {
  return level === "write" ? "write" : "read";
}

export interface VaultNode {
  id: string;
  name: string;
  path: string;
  kind: "dir" | "file";
  depth: number;
  acl: string;
  editedBy: string;
  editing: boolean;
  preview: string;
}

export interface VaultGrant {
  id: string;
  name: string;
  role: string;
  level: AccessLevel;
  locked: boolean;
}

export interface IntegrationRow {
  id: string;
  name: string;
  mark: string;
  detail: string;
  status: "active" | "needs-sign-in" | "disconnected" | "available";
  owner: string;
  audience: string;
  synced: string;
  kind: "connected" | "available" | "mcp";
}

export interface SecretRow {
  id: string;
  name: string;
  kind: "standard" | "proxy";
  version: string;
  host: string;
  scope: string;
  rotated: string;
  apps: string;
  readers: string;
}

export interface DeploymentRowModel {
  id: string;
  name: string;
  url: string;
  project: string;
  status: "live" | "error" | "off";
  access: AccessLevel;
  updated: string;
}

export interface FilesConnectCache {
  files: number;
  nodes: VaultNode[];
  grants: VaultGrant[];
  integrations: IntegrationRow[];
  secrets: SecretRow[];
  deployments: DeploymentRowModel[];
}

const caches = new Map<string, FilesConnectCache>();

export function readFilesConnectCache(slug: string): FilesConnectCache | null {
  return caches.get(slug) ?? null;
}

export function writeFilesConnectCache(slug: string, value: FilesConnectCache): void {
  if (slug) caches.set(slug, value);
}

export function fixtureCache(): FilesConnectCache {
  return {
    files: 1248,
    nodes: [
      { id: "knowledge", name: "knowledge", path: "companies/indigo/knowledge", kind: "dir", depth: 1, acl: "team · read", editedBy: "214", editing: false, preview: "" },
      { id: "policies", name: "policies", path: "companies/indigo/policies", kind: "dir", depth: 1, acl: "team · read", editedBy: "38", editing: false, preview: "" },
      { id: "storyboard", name: "index.html", path: "companies/indigo/projects/hq-desktop-console-rail/design/mockups/console-rail/index.html", kind: "file", depth: 3, acl: "engineering · write", editedBy: "deacon · editing", editing: true, preview: "<!doctype html>\n<html lang=\"en\">\n<head><title>HQ Desktop · Console Rail</title></head>\n…" },
      { id: "design", name: "design.md", path: "companies/indigo/projects/hq-desktop-console-rail/design/design.md", kind: "file", depth: 3, acl: "engineering · write", editedBy: "Corey · 12s", editing: false, preview: "# Console rail\n\nShell retune notes." },
    ],
    grants: [
      { id: "corey", name: "Corey", role: "owner", level: "write", locked: true },
      { id: "deacon", name: "deacon", role: "bot", level: "write", locked: false },
      { id: "eric", name: "Eric B.", role: "member", level: "write", locked: false },
      { id: "eng", name: "Engineering", role: "group · 5", level: "write", locked: true },
    ],
    integrations: [
      { id: "slack", name: "Slack", mark: "SL", detail: "indigo.slack.com · channels:read, chat:write", status: "active", owner: "Corey", audience: "Everyone on the team", synced: "2m ago", kind: "connected" },
      { id: "linear", name: "Linear", mark: "LN", detail: "indigo · issues:read, issues:write", status: "active", owner: "Yousuf", audience: "Engineering · 5", synced: "11m ago", kind: "connected" },
      { id: "gmail", name: "Gmail", mark: "GM", detail: "Saved sign-in is no longer valid", status: "needs-sign-in", owner: "Eric B.", audience: "Only Eric B.", synced: "3d ago", kind: "connected" },
      { id: "notion", name: "Notion", mark: "NT", detail: "HQ Reviewed · pages, databases", status: "available", owner: "", audience: "", synced: "", kind: "available" },
      { id: "hq-work", name: "hq-work", mark: "HQ", detail: "Board and work-mesh tools", status: "active", owner: "HQ", audience: "Agents", synced: "live", kind: "mcp" },
    ],
    secrets: [
      { id: "attio", name: "ATTIO_API_KEY", kind: "standard", version: "v4", host: "", scope: "Company", rotated: "12d ago", apps: "crm-sync, meeting-prep", readers: "@all" },
      { id: "anthropic", name: "ANTHROPIC_API_KEY", kind: "proxy", version: "v7", host: "api.anthropic.com", scope: "Company", rotated: "41d ago", apps: "3 apps", readers: "Engineering" },
      { id: "stripe", name: "STRIPE_SECRET_KEY", kind: "standard", version: "v6", host: "", scope: "Company", rotated: "22d ago", apps: "hq-pro-billing", readers: "2 people" },
    ],
    deployments: [
      { id: "standup", name: "indigo-standup-report", url: "https://indigo-standup-report.indigo-hq.com", project: "standup-brief", status: "live", access: "read", updated: "2h ago" },
      { id: "docs", name: "docs.getindigo.ai", url: "https://docs.getindigo.ai", project: "indigo-docs", status: "live", access: "read", updated: "1d ago" },
    ],
  };
}

/** Drop any secret value before it can reach a view or the DOM. */
export function publicSecret(raw: Record<string, unknown>): SecretRow | null {
  const name = typeof raw.name === "string" ? raw.name : typeof raw.key === "string" ? raw.key : "";
  if (!name) return null;
  const kind = raw.kind === "proxy" || raw.proxy === true ? "proxy" : "standard";
  return {
    id: typeof raw.id === "string" ? raw.id : name,
    name,
    kind,
    version: typeof raw.version === "string" ? raw.version : "v1",
    host: typeof raw.host === "string" ? raw.host : "",
    scope: typeof raw.scope === "string" ? raw.scope : "Company",
    rotated: typeof raw.rotated === "string" ? raw.rotated : "—",
    apps: typeof raw.apps === "string" ? raw.apps : "—",
    readers: typeof raw.readers === "string" ? raw.readers : "creator only",
  };
}

export function shareSheet(secret: { name: string; value?: string }): {
  name: string;
  levels: readonly AccessLevel[];
} {
  return { name: secret.name, levels: ACCESS_LEVELS };
}

/** New and rotate fields accept paste only. Typed characters are rejected. */
export function acceptSecretKey(inputType: string): boolean {
  return inputType === "insertFromPaste" || inputType === "insertFromDrop";
}

export interface ConnectSession {
  app: string;
  url: string;
  phase: "form" | "waiting" | "returned";
}

export function oauthUrl(app: string): string {
  return `https://connect.hq.dev/oauth/${encodeURIComponent(app)}`;
}

export function beginConnect(app: string): ConnectSession {
  return { app, url: oauthUrl(app), phase: "waiting" };
}

export function applyDeepLink(session: ConnectSession, link: string): ConnectSession {
  if (!link.includes("hq://") && !link.includes("code=")) return session;
  return { ...session, phase: "returned" };
}

/**
 * Company Deployments rows from the same hq-deploy client as the personal
 * Deployments page (`list_deploy_apps` for this company's org). Names come
 * from the app record, never a placeholder.
 */
export function companyDeploymentRows(page: DeployAppsPage, slug: string): DeploymentRowModel[] {
  const scope = { id: slug, label: slug };
  const rows: DeploymentRowModel[] = [];
  for (const raw of page.apps ?? []) {
    const row = deploymentFromApp(raw, scope, page.callerSub);
    if (!row) continue;
    rows.push({
      id: row.id,
      name: row.name,
      url: row.url,
      project: row.project,
      status: row.status === "failed" ? "error" : row.status === "active" || row.status === "building" || row.status === "deploying" ? "live" : "off",
      access: "read",
      updated: row.lastVisit ? `visited ${row.lastVisit}` : row.detail,
    });
  }
  return rows;
}

/** Legacy `get_company_deployments` rows carry the subdomain in `sub`. */
export function legacyDeploymentRow(rec: Record<string, unknown>, slug: string, index: number): DeploymentRowModel {
  const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
  const name = pick(rec.name) || pick(rec.sub) || pick(rec.subdomain) || pick(rec.slug) || `deploy-${index}`;
  const url = pick(rec.url);
  return {
    id: name,
    name,
    url: url && !url.startsWith("http") ? `https://${url}` : url,
    project: pick(rec.project) || slug,
    status: rec.state === "error" ? "error" : rec.state === "paused" ? "off" : "live",
    access: "read",
    updated: pick(rec.lastDeploy) || "—",
  };
}

export function deployPrompt(slug: string, artifact: string): string {
  return [
    `/deploy ${slug}`,
    "",
    `Artifact: ${artifact}`,
    "Use the existing hq-deploy command and return the share URL.",
  ].join("\n");
}

export function redeployPrompt(slug: string, name: string): string {
  return [
    `/deploy ${slug}`,
    "",
    `Redeploy ${name} with the existing hq-deploy command.`,
  ].join("\n");
}

/** Redeploy runs only after the confirm sheet. */
export function redeployAllowed(confirmed: boolean): boolean {
  return confirmed === true;
}

export function filterSecrets(rows: readonly SecretRow[], tab: "all" | "standard" | "proxy", query: string): SecretRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (tab === "standard" && row.kind !== "standard") return false;
    if (tab === "proxy" && row.kind !== "proxy") return false;
    if (!q) return true;
    return `${row.name} ${row.apps} ${row.scope}`.toLowerCase().includes(q);
  });
}

export function filterIntegrations(
  rows: readonly IntegrationRow[],
  tab: "connected" | "available" | "mcp",
  query: string,
): IntegrationRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (tab === "connected" && row.kind !== "connected") return false;
    if (tab === "available" && row.kind !== "available") return false;
    if (tab === "mcp" && row.kind !== "mcp") return false;
    if (!q) return true;
    return `${row.name} ${row.detail}`.toLowerCase().includes(q);
  });
}

export function filterVault(nodes: readonly VaultNode[], tab: "all" | "new", query: string): VaultNode[] {
  const q = query.trim().toLowerCase();
  return nodes.filter((node) => {
    if (tab === "new" && !node.editing && !/s$|m$|h$|12s|2h/.test(node.editedBy)) return false;
    if (!q) return true;
    return `${node.name} ${node.path}`.toLowerCase().includes(q);
  });
}

/**
 * Every secret row from the real secrets source (QA-014). The desktop
 * command returns environment groups (`{ env, count, items: [{ key, upd,
 * rot }] }`); flat rows (`{ name | key }`) are accepted too. Values are
 * never read. No cap: the page lists what the sidepane counts.
 */
export function secretRowsFromSource(list: readonly unknown[]): SecretRow[] {
  const rows: SecretRow[] = [];
  for (const raw of list) {
    const rec = (raw ?? {}) as Record<string, unknown>;
    if (Array.isArray(rec.items)) {
      const env = typeof rec.env === "string" && rec.env ? rec.env : "default";
      for (const item of rec.items) {
        const it = (item ?? {}) as Record<string, unknown>;
        const key = typeof it.key === "string" ? it.key : "";
        if (!key) continue;
        const rot = typeof it.rot === "string" && it.rot ? it.rot : "";
        const upd = typeof it.upd === "string" && it.upd ? it.upd : "";
        rows.push({
          id: `${env}:${key}`,
          name: key,
          kind: "standard",
          version: "",
          host: "",
          scope: env,
          rotated: rot || upd || "—",
          apps: "—",
          readers: "",
        });
      }
      continue;
    }
    const row = publicSecret(rec);
    if (row) rows.push(row);
  }
  return rows;
}

export function deploymentRowsFromSource(list: readonly unknown[], slug: string): DeploymentRowModel[] {
  return list.map((item, index) => legacyDeploymentRow((item ?? {}) as Record<string, unknown>, slug, index));
}

/** Status label for a dot-plus-text status. */
export function statusLabel(status: string): string {
  switch (status) {
    case "active":
    case "live":
      return "Live";
    case "needs-sign-in":
      return "Needs sign-in";
    case "error":
      return "Error";
    case "off":
      return "Paused";
    case "disconnected":
      return "Disconnected";
    default:
      return "Available";
  }
}

/** Vault object key (company-relative) for an upload into `folder`. */
export function vaultUploadKey(companyRoot: string, folder: string, name: string): string | null {
  const root = companyRoot.replace(/\/+$/, "");
  const dir = folder.replace(/\/+$/, "");
  if (dir !== root && !dir.startsWith(`${root}/`)) return null;
  const rel = dir.slice(root.length).replace(/^\/+/, "");
  const clean = name.replace(/[\\/]/g, "-").trim();
  if (!clean || clean === "." || clean === "..") return null;
  return rel ? `${rel}/${clean}` : clean;
}

/** Agent hand-off for creating or rotating a secret. The value is entered in
 *  the terminal prompt that `hq secrets set` opens, never in this window. */
export function secretSetPrompt(slug: string, name: string, rotate: boolean): string {
  return [
    `/hq-secrets ${rotate ? "rotate" : "set"} ${name} --company ${slug}`,
    "",
    `${rotate ? "Rotate" : "Create"} the company secret ${name} with \`hq secrets set\`.`,
    "Let me paste the value into the hidden terminal prompt. Never print or echo it.",
  ].join("\n");
}

export function secretBindPrompt(slug: string, name: string, target: "app" | "outpost"): string {
  return [
    `/hq-secrets bind ${name} --company ${slug}`,
    "",
    target === "outpost"
      ? `Bind ${name} to my outpost by name. Never print the value.`
      : `Bind ${name} to an app by name. Ask me which app. Never print the value.`,
  ].join("\n");
}

export function shareAccessPrompt(slug: string, path: string, level: AccessLevel): string {
  return [
    `/hq-share ${path}`,
    "",
    `Company: ${slug}. Grant ${level} access. Ask me who to share with.`,
  ].join("\n");
}

export function secretSharePrompt(slug: string, name: string, level: AccessLevel): string {
  return [
    `/hq-secrets share ${name} --company ${slug}`,
    "",
    `Give ${level} access to the secret ${name}. Ask me who to share with. Never print the value.`,
  ].join("\n");
}
