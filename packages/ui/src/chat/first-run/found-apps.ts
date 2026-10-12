/**
 * Integration auto-detect (first-run "Your apps"): the signature table that
 * maps what `detect_work_apps` found on this computer to an app HQ knows,
 * and the matcher.
 *
 * The scan gives names only: macOS bundle ids and app names, Windows
 * uninstall display names and program folders, and MCP server names and
 * hosts from the AI tools' configs. Nothing here leaves the computer. The
 * catalog is asked about {@link SIGNATURE_DOMAINS}, the whole fixed list, so
 * the server never learns which of them were found.
 *
 * MCP hosts come from hq-pro's auth profiles
 * (`src/integration-factory/auth-profiles/*.json`, `mcpUrl`). A docs URL is
 * set only where a page is known to describe the vendor's MCP server; it is
 * what "Set up with HQ" sends to `POST /v1/integrations/factory/discover-docs`.
 *
 * Pure: no I/O.
 */

import type { FoundMcpServer, FoundWorkApps } from "@hq/platform";

/** The presentation categories the Integrations page uses (`deriveCategory`). */
export type FoundAppKind =
  | "Meetings"
  | "Work"
  | "Knowledge"
  | "Design"
  | "Comms"
  | "Data"
  | "Dev"
  | "Analytics"
  | "Payments"
  | "Other";

/** HQ connects these through its own providers, not the integration catalog. */
export type NativeProvider = "slack" | "google";

export interface AppSignature {
  /** The app's website domain: the catalog handle and the connection match. */
  domain: string;
  name: string;
  kind: FoundAppKind;
  /** macOS `CFBundleIdentifier`s, compared case-insensitively. */
  bundleIds?: readonly string[];
  /** Installed-app names (macOS bundle name, Windows DisplayName or folder), compared loosely. */
  appNames?: readonly string[];
  /** MCP server hosts. A found host matches when equal or a subdomain. */
  mcpHosts?: readonly string[];
  /** MCP server names as people write them in configs, compared loosely. */
  mcpNames?: readonly string[];
  /** A page describing the vendor's MCP server, for the docs-based setup. */
  docsUrl?: string;
  /** Connected through HQ's own provider rather than the catalog. */
  native?: NativeProvider;
  /**
   * Found but never offered: password managers, VPN and identity agents,
   * local infrastructure and the AI tools HQ already detects.
   */
  exclude?: true;
}

export const APP_SIGNATURES: readonly AppSignature[] = [
  // Meetings
  { domain: "fireflies.ai", name: "Fireflies", kind: "Meetings", appNames: ["Fireflies"], mcpHosts: ["api.fireflies.ai"], mcpNames: ["fireflies"] },
  { domain: "granola.ai", name: "Granola", kind: "Meetings", bundleIds: ["com.granola.app"], appNames: ["Granola"], mcpHosts: ["mcp.granola.ai"], mcpNames: ["granola"] },
  { domain: "fathom.video", name: "Fathom", kind: "Meetings", appNames: ["Fathom"], mcpNames: ["fathom"] },
  { domain: "otter.ai", name: "Otter", kind: "Meetings", appNames: ["Otter"], mcpNames: ["otter"] },
  { domain: "loom.com", name: "Loom", kind: "Meetings", bundleIds: ["com.loom.desktop"], appNames: ["Loom"], mcpNames: ["loom"] },
  {
    domain: "zoom.us",
    name: "Zoom",
    kind: "Meetings",
    bundleIds: ["us.zoom.xos"],
    appNames: ["zoom.us", "Zoom", "Zoom Workplace"],
    mcpHosts: ["mcp.zoom.us"],
    mcpNames: ["zoom"],
    docsUrl: "https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/",
  },
  { domain: "teams.microsoft.com", name: "Microsoft Teams", kind: "Meetings", bundleIds: ["com.microsoft.teams2", "com.microsoft.teams"], appNames: ["Microsoft Teams", "Microsoft Teams (work or school)"] },
  // Work
  { domain: "linear.app", name: "Linear", kind: "Work", bundleIds: ["com.linear"], appNames: ["Linear"], mcpHosts: ["mcp.linear.app"], mcpNames: ["linear"] },
  { domain: "atlassian.com", name: "Jira and Confluence", kind: "Work", mcpHosts: ["mcp.atlassian.com"], mcpNames: ["atlassian", "jira", "confluence"] },
  { domain: "asana.com", name: "Asana", kind: "Work", appNames: ["Asana"], mcpHosts: ["mcp.asana.com"], mcpNames: ["asana"] },
  { domain: "clickup.com", name: "ClickUp", kind: "Work", bundleIds: ["com.clickup.desktop-app"], appNames: ["ClickUp"], mcpHosts: ["mcp.clickup.com"], mcpNames: ["clickup"] },
  { domain: "monday.com", name: "monday.com", kind: "Work", appNames: ["monday.com"], mcpHosts: ["mcp.monday.com"], mcpNames: ["monday"] },
  { domain: "todoist.com", name: "Todoist", kind: "Work", bundleIds: ["com.todoist.mac.Todoist"], appNames: ["Todoist"], mcpNames: ["todoist"] },
  // Knowledge
  { domain: "notion.com", name: "Notion", kind: "Knowledge", bundleIds: ["notion.id"], appNames: ["Notion"], mcpHosts: ["mcp.notion.com"], mcpNames: ["notion"] },
  { domain: "obsidian.md", name: "Obsidian", kind: "Knowledge", bundleIds: ["md.obsidian"], appNames: ["Obsidian"] },
  // Design
  { domain: "figma.com", name: "Figma", kind: "Design", bundleIds: ["com.figma.Desktop"], appNames: ["Figma"], mcpNames: ["figma"] },
  { domain: "miro.com", name: "Miro", kind: "Design", bundleIds: ["com.electron.realtimeboard"], appNames: ["Miro"], mcpHosts: ["mcp.miro.com"], mcpNames: ["miro"] },
  // Comms
  { domain: "slack.com", name: "Slack", kind: "Comms", bundleIds: ["com.tinyspeck.slackmacgap"], appNames: ["Slack"], mcpNames: ["slack"], native: "slack" },
  { domain: "workspace.google.com", name: "Google Workspace", kind: "Comms", bundleIds: ["com.google.drivefs"], appNames: ["Google Drive"], mcpNames: ["gmail", "google-drive", "gdrive", "google-workspace"], native: "google" },
  { domain: "hubspot.com", name: "HubSpot", kind: "Comms", mcpHosts: ["mcp.hubspot.com"], mcpNames: ["hubspot"] },
  { domain: "discord.com", name: "Discord", kind: "Comms", bundleIds: ["com.hnc.Discord"], appNames: ["Discord"] },
  // Data and analytics
  { domain: "supabase.com", name: "Supabase", kind: "Data", mcpHosts: ["mcp.supabase.com"], mcpNames: ["supabase"] },
  { domain: "airtable.com", name: "Airtable", kind: "Data", appNames: ["Airtable"], mcpHosts: ["mcp.airtable.com"], mcpNames: ["airtable"] },
  { domain: "posthog.com", name: "PostHog", kind: "Analytics", mcpHosts: ["mcp.posthog.com"], mcpNames: ["posthog"] },
  { domain: "sentry.io", name: "Sentry", kind: "Analytics", mcpHosts: ["mcp.sentry.dev"], mcpNames: ["sentry"] },
  // Dev
  { domain: "github.com", name: "GitHub", kind: "Dev", bundleIds: ["com.github.GitHubClient"], appNames: ["GitHub Desktop"], mcpHosts: ["api.githubcopilot.com"], mcpNames: ["github"] },
  { domain: "api.aws", name: "AWS Knowledge", kind: "Dev", mcpHosts: ["knowledge-mcp.global.api.aws"], mcpNames: ["aws-knowledge", "aws-knowledge-mcp-server"] },
  { domain: "cloudflare.com", name: "Cloudflare", kind: "Dev", mcpHosts: ["mcp.cloudflare.com"], mcpNames: ["cloudflare"] },
  { domain: "vercel.com", name: "Vercel", kind: "Dev", mcpHosts: ["mcp.vercel.com"], mcpNames: ["vercel"], docsUrl: "https://vercel.com/docs/mcp/vercel-mcp" },
  // Payments
  { domain: "stripe.com", name: "Stripe", kind: "Payments", mcpHosts: ["mcp.stripe.com"], mcpNames: ["stripe"] },
  // Found, never offered
  { domain: "1password.com", name: "1Password", kind: "Other", bundleIds: ["com.1password.1password", "com.agilebits.onepassword7"], appNames: ["1Password"], exclude: true },
  { domain: "okta.com", name: "Okta Verify", kind: "Other", appNames: ["Okta Verify"], exclude: true },
  { domain: "tailscale.com", name: "Tailscale", kind: "Other", bundleIds: ["io.tailscale.ipn.macos", "io.tailscale.ipn.macsys"], appNames: ["Tailscale"], exclude: true },
  { domain: "docker.com", name: "Docker", kind: "Other", bundleIds: ["com.docker.docker"], appNames: ["Docker", "Docker Desktop"], exclude: true },
  { domain: "claude.ai", name: "Claude", kind: "Other", bundleIds: ["com.anthropic.claudefordesktop"], appNames: ["Claude"], exclude: true },
  { domain: "chatgpt.com", name: "ChatGPT", kind: "Other", bundleIds: ["com.openai.chat", "com.openai.codex"], appNames: ["ChatGPT", "Codex"], exclude: true },
  { domain: "cursor.com", name: "Cursor", kind: "Other", bundleIds: ["com.todesktop.230313mzl4w4u92"], appNames: ["Cursor"], exclude: true },
];

/**
 * The domains the catalog is asked about: every offerable signature, always
 * the same list, so the request says nothing about this computer.
 */
export const SIGNATURE_DOMAINS: readonly string[] = APP_SIGNATURES.filter((s) => !s.exclude && !s.native).map((s) => s.domain);

/** Where an app was seen. */
export interface FoundEvidence {
  /** Installed on this computer. */
  app: boolean;
  /** AI tools whose MCP config names it. */
  tools: FoundMcpServer["tool"][];
}

export interface FoundApp {
  domain: string;
  name: string;
  kind: FoundAppKind;
  evidence: FoundEvidence;
  docsUrl: string | null;
  native: NativeProvider | null;
  /** Found but never offered (see {@link AppSignature.exclude}). */
  excluded: boolean;
}

/** Lowercase letters and digits only: "Google Drive" and "google-drive" read alike. */
function loose(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hostMatches(host: string, wanted: string): boolean {
  const h = host.toLowerCase();
  const w = wanted.toLowerCase();
  return h === w || h.endsWith(`.${w}`);
}

interface Index {
  bundle: Map<string, AppSignature>;
  appName: Map<string, AppSignature>;
  mcpName: Map<string, AppSignature>;
}

function buildIndex(signatures: readonly AppSignature[]): Index {
  const index: Index = { bundle: new Map(), appName: new Map(), mcpName: new Map() };
  for (const s of signatures) {
    for (const id of s.bundleIds ?? []) index.bundle.set(id.toLowerCase(), s);
    for (const name of s.appNames ?? []) index.appName.set(loose(name), s);
    for (const name of s.mcpNames ?? []) index.mcpName.set(loose(name), s);
  }
  return index;
}

function signatureForServer(server: FoundMcpServer, signatures: readonly AppSignature[], index: Index): AppSignature | null {
  if (server.host) {
    const byHost = signatures.find(
      (s) => (s.mcpHosts ?? []).some((h) => hostMatches(server.host!, h)) || hostMatches(server.host!, s.domain),
    );
    if (byHost) return byHost;
  }
  if (server.local) return null;
  return index.mcpName.get(loose(server.name)) ?? null;
}

export interface FoundAppsResult {
  /** Matched apps, one per domain, in signature-table order within each kind. */
  apps: FoundApp[];
  /** Installed apps and servers that matched no signature (counted, never named). */
  unmatched: number;
}

/**
 * Map a scan to the apps HQ knows. Disabled MCP servers count too: the
 * person has used the app. One entry per domain, merging the evidence.
 */
export function matchFoundApps(found: FoundWorkApps | null | undefined, signatures: readonly AppSignature[] = APP_SIGNATURES): FoundAppsResult {
  if (!found) return { apps: [], unmatched: 0 };
  const index = buildIndex(signatures);
  const byDomain = new Map<string, FoundApp>();
  let unmatched = 0;
  const hit = (s: AppSignature): FoundApp => {
    let app = byDomain.get(s.domain);
    if (!app) {
      app = {
        domain: s.domain,
        name: s.name,
        kind: s.kind,
        evidence: { app: false, tools: [] },
        docsUrl: s.docsUrl ?? null,
        native: s.native ?? null,
        excluded: s.exclude === true,
      };
      byDomain.set(s.domain, app);
    }
    return app;
  };
  for (const app of Array.isArray(found.apps) ? found.apps : []) {
    const s =
      (app.bundleId ? index.bundle.get(app.bundleId.toLowerCase()) : undefined) ??
      (typeof app.name === "string" ? index.appName.get(loose(app.name)) : undefined);
    if (s) hit(s).evidence.app = true;
    else unmatched += 1;
  }
  for (const server of Array.isArray(found.mcpServers) ? found.mcpServers : []) {
    const s = signatureForServer(server, signatures, index);
    if (!s) {
      if (!server.local) unmatched += 1;
      continue;
    }
    const app = hit(s);
    if (!app.evidence.tools.includes(server.tool)) app.evidence.tools.push(server.tool);
  }
  const order = new Map(signatures.map((s, i) => [s.domain, i]));
  const apps = [...byDomain.values()].sort((a, b) => (order.get(a.domain) ?? 0) - (order.get(b.domain) ?? 0));
  return { apps, unmatched };
}

const TOOL_LABEL: Record<FoundMcpServer["tool"], string> = {
  claude_code: "Claude Code",
  claude_desktop: "Claude",
  cursor: "Cursor",
  codex: "Codex",
};

/** One short line saying where an app was found: "Mac app", "In Claude Code and Codex". */
export function evidenceLine(evidence: FoundEvidence, hostNoun: "Mac" | "PC" = "Mac"): string {
  if (evidence.tools.length > 0) {
    const names = evidence.tools.map((t) => TOOL_LABEL[t]);
    const joined = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    return `In ${joined}`;
  }
  return evidence.app ? `${hostNoun} app` : "";
}

/** What the catalog lookup says about one domain. */
export interface CatalogMatch {
  entryId: string | null;
  name: string | null;
  authClass: "none" | "oauth" | "key" | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Read a catalog lookup answer (`{ ok, companyUid, matches: { [domain]:
 * entry | null } }`) into a match per requested domain. Domains the answer
 * leaves out read as not in the catalog; anything not shaped like the answer
 * is null (the step then offers nothing from the catalog).
 */
export function readCatalogLookup(json: unknown, domains: readonly string[] = SIGNATURE_DOMAINS): Record<string, CatalogMatch | null> | null {
  const root = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  const matches = root?.matches && typeof root.matches === "object" && !Array.isArray(root.matches) ? (root.matches as Record<string, unknown>) : null;
  if (!matches) return null;
  const out: Record<string, CatalogMatch | null> = {};
  for (const domain of domains) {
    const entry = matches[domain];
    if (!entry || typeof entry !== "object") {
      out[domain] = null;
      continue;
    }
    const e = entry as Record<string, unknown>;
    const auth = e.authClass;
    out[domain] = {
      entryId: text(e.entryId),
      name: text(e.name),
      authClass: auth === "none" || auth === "oauth" || auth === "key" ? auth : null,
    };
  }
  return out;
}
