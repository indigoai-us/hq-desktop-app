/**
 * Canonical HQ web-console URLs — the single source of truth for every external
 * link the desktop window opens into the HQ console.
 *
 * Centralised so the "all links resolve to the right place" guarantee lives in
 * one file rather than scattered string literals (CompanyPage, MeetingsPage,
 * MarketplacePanel, the shell's secondary-sidebar footer all consume these).
 * Every link opens in the system browser via the host platform's external-
 * `open()`.
 */

/** Production HQ console host. */
export const HQ_CONSOLE_BASE = "https://hq.computer";

/** @deprecated Use HQ_CONSOLE_BASE — console.getindigo.ai is the old host. */
export const LEGACY_INDIGO_CONSOLE_BASE = "https://console.getindigo.ai";

/**
 * A company's console home. The console namespaces every company surface under
 * `/companies/{slug}` (Next.js route `src/app/(shell)/companies/[slug]`), so the
 * `/companies` segment is REQUIRED — linking to `${HQ_CONSOLE_BASE}/${slug}`
 * 404s (the bug these links used to ship).
 */
export function companyConsoleUrl(slug: string): string {
  return `${HQ_CONSOLE_BASE}/companies/${encodeURIComponent(slug)}`;
}

/**
 * A company's settings page in the console — the dedicated settings surface at
 * `/companies/{slug}/settings` (route `companies/[slug]/settings`), where sync
 * rules, members, and roles live. The desktop Company page's "Settings" button
 * opens this.
 */
export function companySettingsUrl(slug: string): string {
  return `${companyConsoleUrl(slug)}/settings`;
}

/**
 * A company's invite surface in the console — the admin Team → Invites page at
 * `/companies/{slug}/team/invites` (route `companies/[slug]/team/invites`),
 * which carries the "Invite teammate" send flow. (Per-token accept links live
 * separately under `/invite/{token}`; this is the company-scoped entry point.)
 */
export function companyInviteUrl(slug: string): string {
  return `${companyConsoleUrl(slug)}/team/invites`;
}

/**
 * A company's HQ Integrations page in the console, where apps are connected
 * (route `companies/[slug]/integrations`). The console also resolves a company
 * uid in the slug position, so either works here.
 */
export function companyIntegrationsUrl(slugOrUid: string): string {
  return `${companyConsoleUrl(slugOrUid)}/integrations`;
}

/**
 * One bot's settings in the console, where it is connected to Slack: the
 * company's bots page with `?settings={agentUid}` naming the bot to open.
 */
export function agentSlackSettingsUrl(slugOrUid: string, agentUid: string): string {
  return `${companyConsoleUrl(slugOrUid)}/agents?settings=${encodeURIComponent(agentUid)}`;
}

/** Personal Console Integrations (calendar / meeting-bot connect). */
export const HQ_CONSOLE_INTEGRATIONS_URL = `${HQ_CONSOLE_BASE}/personal/integrations`;

/** Console creators index. */
export const HQ_CONSOLE_CREATORS_URL = `${HQ_CONSOLE_BASE}/creators`;

/** A single creator's public profile in the console. */
export function creatorProfileUrl(handle: string): string {
  return `${HQ_CONSOLE_CREATORS_URL}/${encodeURIComponent(handle)}`;
}
