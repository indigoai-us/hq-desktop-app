import { integrationDisplayName, integrationDomain, providerSlug, registrableDomain } from "../../common/integration-display.js";
import type { IntegrationRow } from "./files-connect-model.js";

/**
 * Integrations grouped by app, with health, the way the web console's
 * Integrations hub shows them (`groupByApp`, `appStatusSummary`, `connStatus`
 * and `connectionHealthNotice` in the console). One row per app; its
 * connections open in the detail pane.
 *
 * Health reads hq-pro's fault fields (`errorReason`, `needsReauthReason`,
 * `degradedReason`, `fix_path`, `installation.status`). Reason codes are a
 * closed hq-pro vocabulary and map to fixed plain-language sentences here;
 * provider text is never shown. `fix_path` is the one server string shown,
 * because HQ writes it for the reader's role.
 */

export type IntegrationHealthState = "active" | "needs-attention" | "needs-sign-in" | "disconnected";

export interface IntegrationHealth {
  state: IntegrationHealthState;
  /** Short label for the status dot: "Active", "Needs attention", "Needs sign-in", "Disconnected". */
  label: string;
  /** Plain-language diagnosis, HQ-authored. "" when there is none. */
  reason: string;
  /** The server's role-aware fix, verbatim. "" when it sent none. */
  fixPath: string;
}

/** Codes that mean the saved sign-in is no longer good: the person signs in again. */
const SIGN_IN_REASONS: Readonly<Record<string, string>> = {
  oauth_refresh_invalid_grant: "The saved sign-in is no longer valid.",
  oauth_refresh_unavailable: "The saved sign-in can no longer be renewed.",
  token_refresh_failed: "The saved sign-in could not be renewed.",
  credentials_rejected: "The app rejected the saved sign-in.",
  oauth_token_expired: "The saved sign-in expired.",
  oauth_refresh_missing_refresh_token: "The saved sign-in cannot be renewed automatically.",
  unauthenticated_install_rejected: "The app needs a sign-in. Add it again and sign in.",
};

/** Codes for every other known fault. */
const ATTENTION_REASONS: Readonly<Record<string, string>> = {
  oauth_refresh_transient: "Renewing the sign-in did not work just now. The saved sign-in is fine.",
  oauth_refresh_write_conflict: "Two renewals collided. The next attempt should settle it.",
  upstream_503: "The app is temporarily unavailable.",
  oauth_client_secret_unavailable: "This is an HQ setup problem, not something on your end.",
  oauth_refresh_missing_client: "HQ has no sign-in app set up for this integration.",
  client_registration_refused: "This app does not let HQ register itself automatically.",
};

const HTTP_REASON = /^http_(\d{3})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The first recorded reason code. `unspecified` records the absence of one. */
function reasonCode(c: Record<string, unknown>): string {
  for (const key of ["errorReason", "needsReauthReason", "degradedReason"]) {
    const value = text(c[key]);
    if (value && value !== "unspecified") return value;
  }
  return "";
}

function reasonSentence(code: string): string {
  if (!code) return "";
  const fixed = SIGN_IN_REASONS[code] ?? ATTENTION_REASONS[code];
  if (fixed) return fixed;
  const http = HTTP_REASON.exec(code);
  return http ? `The app turned the request away (error ${http[1]}).` : "";
}

/**
 * Health of one hq-pro connection row. Fails closed: anything that is not
 * explicitly `connected` with no recorded fault needs attention, so a status
 * hq-pro adds later never reads as Active. Only `revoked` (or `disconnected`)
 * reads as Disconnected.
 */
export function integrationHealth(raw: unknown): IntegrationHealth {
  const c = isRecord(raw) ? raw : {};
  const status = text(c.status);
  if (status === "revoked" || status === "disconnected") {
    return { state: "disconnected", label: "Disconnected", reason: "", fixPath: "" };
  }
  const code = reasonCode(c);
  const installation = isRecord(c.installation) ? c.installation : null;
  const awaitingKey = installation?.status === "needs_credentials";
  if (status === "connected" && !code && !awaitingKey) {
    return { state: "active", label: "Active", reason: "", fixPath: "" };
  }
  const fixPath = text(c.fix_path);
  const signIn = status === "needs-reauth" || (!!code && code in SIGN_IN_REASONS);
  let reason = reasonSentence(code);
  if (!reason && awaitingKey) reason = "Waiting for an access key before agents can use it.";
  if (!reason && status === "degraded") reason = "Partly working.";
  return signIn
    ? { state: "needs-sign-in", label: "Needs sign-in", reason, fixPath }
    : { state: "needs-attention", label: "Needs attention", reason, fixPath };
}

/** Well-known name fragments → a presentation category (console `deriveCategory`). */
const CATEGORY_BY_FRAGMENT: ReadonlyArray<[string, string]> = [
  ["linear", "Work"],
  ["atlassian", "Work"],
  ["jira", "Work"],
  ["monday", "Work"],
  ["asana", "Work"],
  ["clickup", "Work"],
  ["posthog", "Analytics"],
  ["amplitude", "Analytics"],
  ["mixpanel", "Analytics"],
  ["sentry", "Analytics"],
  ["datadog", "Analytics"],
  ["notion", "Knowledge"],
  ["deepwiki", "Knowledge"],
  ["guru", "Knowledge"],
  ["confluence", "Knowledge"],
  ["figma", "Design"],
  ["canva", "Design"],
  ["miro", "Design"],
  ["gamma", "Design"],
  ["slack", "Comms"],
  ["intercom", "Comms"],
  ["hubspot", "Comms"],
  ["salesforce", "Comms"],
  ["zendesk", "Comms"],
  ["gmail", "Comms"],
  ["airtable", "Data"],
  ["snowflake", "Data"],
  ["bigquery", "Data"],
  ["supabase", "Data"],
  ["github", "Dev"],
  ["gitlab", "Dev"],
  ["vercel", "Dev"],
  ["netlify", "Dev"],
  ["fathom", "Meetings"],
  ["granola", "Meetings"],
  ["zoom", "Meetings"],
  ["loom", "Meetings"],
  ["stripe", "Payments"],
  ["paypal", "Payments"],
  ["quickbooks", "Payments"],
  ["intuit", "Payments"],
];

/** Presentation-only category for an app. Never used for access decisions. */
export function deriveCategory(domain: string, name: string): string {
  const hay = `${domain} ${name}`.toLowerCase();
  for (const [fragment, category] of CATEGORY_BY_FRAGMENT) {
    if (hay.includes(fragment)) return category;
  }
  return "Other";
}

/** The grouping key of a connection's app: its website, else its provider id without the hash. */
export function integrationAppKey(raw: unknown): string {
  const c = isRecord(raw) ? raw : {};
  const domain = integrationDomain(c);
  if (domain) return domain;
  const name = integrationDisplayName(c).toLowerCase();
  return name !== "app" ? name : providerSlug(c.provider) || "app";
}

export interface IntegrationApp {
  key: string;
  name: string;
  /** The app's website, "" when unknown. */
  domain: string;
  category: string;
  connections: IntegrationRow[];
}

export interface AppStatusSummary {
  state: "active" | "needs-attention" | "disconnected";
  text: string;
}

/** One app per key, in first-seen order; name and domain come from the first row that has a domain. */
export function groupIntegrationApps(rows: readonly IntegrationRow[]): IntegrationApp[] {
  const groups = new Map<string, IntegrationApp>();
  for (const row of rows) {
    const key = row.appKey || row.id;
    let app = groups.get(key);
    if (!app) {
      app = { key, name: row.name, domain: row.domain, category: "", connections: [] };
      groups.set(key, app);
    }
    if (!app.domain && row.domain) {
      app.domain = row.domain;
      app.name = row.name;
    }
    app.connections.push(row);
  }
  for (const app of groups.values()) app.category = deriveCategory(app.domain, app.name);
  return [...groups.values()];
}

/** The app row's status: any fault wins, then "N active", else Disconnected. */
export function appStatusSummary(app: Pick<IntegrationApp, "connections">): AppStatusSummary {
  const faults = app.connections.filter((c) => c.status === "needs-attention" || c.status === "needs-sign-in").length;
  const active = app.connections.filter((c) => c.status === "active").length;
  if (faults > 0) {
    return { state: "needs-attention", text: faults === 1 ? "Needs attention" : `${faults} need attention` };
  }
  if (active === 0) return { state: "disconnected", text: "Disconnected" };
  return { state: "active", text: `${active} active` };
}

/** "2 connections · Work". */
export function appMetaLine(app: Pick<IntegrationApp, "connections" | "category">): string {
  const n = app.connections.length;
  return `${n} ${n === 1 ? "connection" : "connections"} · ${app.category}`;
}

/** Apps whose name, website, category or any connection's detail matches the filter. */
export function filterIntegrationApps(apps: readonly IntegrationApp[], query: string): IntegrationApp[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...apps];
  return apps.filter((app) =>
    `${app.name} ${app.domain} ${app.category} ${app.connections.map((c) => `${c.detail} ${c.owner}`).join(" ")}`
      .toLowerCase()
      .includes(q),
  );
}

const AUTH_COPY: Readonly<Record<string, string>> = {
  oauth: "Sign in with your browser",
  key: "Needs an access key",
  none: "No sign-in needed",
};

/**
 * The apps HQ can connect, from `GET /v1/integrations/factory/catalog`
 * (`{ entries: [{ name, domain, description, authClass, entryId }] }`). A body
 * without an `entries` list is a failed read, not an empty catalog.
 */
export function catalogIntegrationRows(body: unknown): IntegrationRow[] {
  const list = isRecord(body) ? body.entries : undefined;
  if (!Array.isArray(list)) throw new Error("catalog response has no entries list");
  const rows: IntegrationRow[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const domain = registrableDomain(raw.domain) ?? "";
    const label = domain.split(".")[0] ?? "";
    const name = text(raw.name) || (label ? label.charAt(0).toUpperCase() + label.slice(1) : "");
    if (!name) continue;
    const id = `catalog:${text(raw.entryId) || domain || name.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const auth = AUTH_COPY[text(raw.authClass)] ?? "";
    rows.push({
      id,
      name,
      domain,
      appKey: domain || name.toLowerCase(),
      detail: text(raw.description) || auth || "Connect from the console",
      status: "available",
      owner: "",
      audience: auth,
      synced: "",
      kind: "available",
      reason: "",
      fixPath: "",
    });
  }
  return rows;
}

/** Why the catalog could not be shown, in plain words. Server text is never shown. */
export function catalogFailureLine(
  failure: { status?: number; code?: string; message?: string } | null | undefined,
): {
  line: string;
  retry: boolean;
} {
  // The server's code can arrive as the failure code or inside its message;
  // it is only matched here, never shown.
  const said = `${failure?.code ?? ""} ${failure?.message ?? ""}`;
  if (said.includes("INTEGRATION_FACTORY_DISABLED")) {
    return { line: "Adding apps is not turned on for this company yet.", retry: false };
  }
  if (failure?.status === 403 || said.includes("INTEGRATION_FACTORY_FORBIDDEN")) {
    return { line: "Only company owners and admins can browse apps to connect.", retry: false };
  }
  return { line: "Could not load apps to connect.", retry: true };
}
