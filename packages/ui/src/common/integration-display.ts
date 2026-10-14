import { brandMarkFor } from "../chat/messaging/app-brand-marks.js";

/**
 * The name and website of a connected app, from one hq-pro connection row
 * (`GET /v1/integrations/admin`: `{ provider, installation: { displayName,
 * domain } }`).
 *
 * The console's rule (`connAppName` in the console's integrations hub data):
 * the installation's display name first, else the provider id made readable.
 * Raw ids never reach a person: the `factory:` namespace is dropped, and so is
 * the hash a remote MCP install carries at the end of its id
 * (`factory:remote_mcp_posthog_com_e755da2a…` reads "PostHog", not
 * "Factory:remote Mcp Posthog Com E755…").
 *
 * Company-neutral and network-free: names come from the row, a fixed table,
 * and the bundled brand-mark titles (app-brand-marks.ts).
 */

/** What the helpers read from a connection row. Every field may be missing. */
export interface IntegrationIdentity {
  provider?: unknown;
  installation?: unknown;
}

/** Providers whose spelling a title-case would get wrong, or that have no domain in the id. */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  slack: "Slack",
  "managed-slack": "Slack",
  linear: "Linear",
  gmail: "Gmail",
  google: "Google",
  notion: "Notion",
  github: "GitHub",
  gitlab: "GitLab",
  quickbooks: "QuickBooks",
  hubspot: "HubSpot",
  posthog: "PostHog",
  clickup: "ClickUp",
  deepwiki: "DeepWiki",
  youtube: "YouTube",
};

/** The website of a provider id that names no domain itself. */
const PROVIDER_DOMAINS: Readonly<Record<string, string>> = {
  slack: "slack.com",
  "managed-slack": "slack.com",
  linear: "linear.app",
  gmail: "gmail.com",
  google: "google.com",
  notion: "notion.so",
  github: "github.com",
  gitlab: "gitlab.com",
  quickbooks: "quickbooks.intuit.com",
  hubspot: "hubspot.com",
  posthog: "posthog.com",
  figma: "figma.com",
  sentry: "sentry.io",
  stripe: "stripe.com",
  vercel: "vercel.com",
  asana: "asana.com",
  airtable: "airtable.com",
  zoom: "zoom.us",
};

/** Last labels that make a token run a website (`posthog com` is posthog.com). */
const TLDS = new Set(["com", "io", "app", "so", "ai", "dev", "net", "org", "co", "us", "sh", "xyz", "tech", "cloud"]);

/** Leading words of a remote MCP id that say how it connects, not what it is. */
const TRANSPORT_WORDS = new Set(["remote", "mcp", "server", "http", "https", "sse"]);

/** A hash segment: six or more hex digits with at least one digit (`e755da2a`). */
function isHashSegment(token: string): boolean {
  return /^[0-9a-f]{6,}$/i.test(token) && /\d/.test(token);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** `factory:linear` → `linear`. */
export function providerSlug(provider: unknown): string {
  return text(provider).replace(/^factory:/i, "").trim().toLowerCase();
}

function titleCase(tokens: readonly string[]): string {
  return tokens
    .map((word) => (word.toLowerCase() === "mcp" ? "MCP" : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

interface ParsedProvider {
  /** Words that name the app, transport words and the hash removed. */
  nameTokens: string[];
  /** A website the id spells out (`posthog.com`), or "". */
  domain: string;
  /** Every readable word, for an id that is nothing but transport words. */
  allTokens: string[];
}

function parseProvider(provider: unknown): ParsedProvider {
  const tokens = providerSlug(provider).split(/[-_\s.:/]+/).filter(Boolean);
  while (tokens.length > 0 && isHashSegment(tokens[tokens.length - 1]!)) tokens.pop();
  const allTokens = [...tokens];
  let start = 0;
  while (start < tokens.length - 1 && TRANSPORT_WORDS.has(tokens[start]!)) start += 1;
  let nameTokens = tokens.slice(start);
  if (nameTokens.length === 1 && TRANSPORT_WORDS.has(nameTokens[0]!)) nameTokens = [];
  let domain = "";
  const last = nameTokens[nameTokens.length - 1];
  if (nameTokens.length >= 2 && last && TLDS.has(last)) {
    domain = nameTokens.join(".");
    nameTokens = nameTokens.slice(0, -1);
  }
  return { nameTokens, domain, allTokens };
}

/**
 * Best-effort registrable domain for a brand-mark lookup: lower case, no
 * scheme or path, leading `mcp.` and `www.` dropped (`mcp.linear.app` →
 * `linear.app`). Anything that is not a host reads as null.
 */
export function registrableDomain(domain: unknown): string | null {
  let host = text(domain).toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0] ?? "";
  if (!host || /\s/.test(host)) return null;
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  while (labels.length > 2 && (labels[0] === "mcp" || labels[0] === "www")) labels.shift();
  return labels.join(".");
}

function installationOf(row: IntegrationIdentity): Record<string, unknown> | null {
  return isRecord(row.installation) ? row.installation : null;
}

/** The app's website: the installation's domain, else one the provider id names, else a known one. "" when unknown. */
export function integrationDomain(row: IntegrationIdentity): string {
  const installed = registrableDomain(installationOf(row)?.domain);
  if (installed) return installed;
  const parsed = parseProvider(row.provider);
  if (parsed.domain) return registrableDomain(parsed.domain) ?? "";
  const slug = providerSlug(row.provider);
  return PROVIDER_DOMAINS[slug] ?? PROVIDER_DOMAINS[parsed.nameTokens.join("-")] ?? "";
}

/**
 * The name a person sees for a connection's app. Never a raw provider id:
 * no `factory:` prefix, no trailing hash, no transport words.
 */
export function integrationDisplayName(row: IntegrationIdentity): string {
  const installed = text(installationOf(row)?.displayName);
  if (installed && !/^factory:/i.test(installed)) return installed;
  const slug = providerSlug(row.provider);
  const known = PROVIDER_NAMES[slug];
  if (known) return known;
  const parsed = parseProvider(row.provider);
  const joined = parsed.nameTokens.join("-");
  if (PROVIDER_NAMES[joined]) return PROVIDER_NAMES[joined]!;
  const domain = integrationDomain(row);
  const brand = domain ? brandMarkFor(domain)?.title : undefined;
  if (brand) return brand;
  if (parsed.nameTokens.length) return titleCase(parsed.nameTokens);
  if (parsed.allTokens.length) return titleCase(parsed.allTokens);
  return "App";
}
