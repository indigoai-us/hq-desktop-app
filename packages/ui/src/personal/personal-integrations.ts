/**
 * Personal integrations from the real source: the same hq-pro routes the
 * console's Personal > Integrations page reads.
 *
 *   GET    /v1/google/accounts                 { accounts: GoogleAccount[] }
 *   GET    /v1/slack/personal/accounts         { accounts: SlackPersonalAccount[] }
 *
 * View-only: connections are managed in the web console at
 * https://hq.computer/personal/integrations, opened in the browser.
 */
import type { AdapterPromise, Json } from "@hq/platform";
import { HQ_CONSOLE_BASE } from "../common/hq-console.js";

export const PERSONAL_INTEGRATIONS_URL = `${HQ_CONSOLE_BASE}/personal/integrations`;

export interface PersonalIntegrationsApi {
  listMyGoogleAccounts?(): AdapterPromise<Json>;
  listMySlackAccounts?(): AdapterPromise<Json>;
}

export type IntegrationProvider = "google" | "slack";

export interface PersonalIntegration {
  /** `${provider}:${accountId}` so Google and Slack ids never collide. */
  id: string;
  provider: IntegrationProvider;
  accountId: string;
  app: string;
  /** Email for Google, display name and workspace for Slack. */
  identity: string;
  status: "active" | "reconnect";
  /** ISO timestamp from hq-pro, "" when absent. */
  connectedAt: string;
  /** Connected sources in console order (Google only). */
  sources: string[];
}

const GOOGLE_SOURCE_LABEL: Record<string, string> = {
  calendar: "Calendar",
  contacts: "Contacts",
  docs: "Docs",
  drive: "Drive",
  gmail: "Gmail",
  sheets: "Sheets",
};

function failCode(res: { reason: string; code?: string }): string {
  return res.code ?? res.reason;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function rows(body: unknown): Record<string, unknown>[] {
  const list = (body as { accounts?: unknown } | null)?.accounts;
  return Array.isArray(list) ? list.filter((row): row is Record<string, unknown> => !!row && typeof row === "object") : [];
}

export function googleIntegrationsFromBody(body: unknown): PersonalIntegration[] {
  return rows(body).flatMap((row) => {
    const accountId = str(row.accountId);
    if (!accountId) return [];
    const caps = Array.isArray(row.capabilities) ? row.capabilities.map(str) : [];
    const sources = Object.keys(GOOGLE_SOURCE_LABEL)
      .filter((key) => caps.includes(key))
      .map((key) => GOOGLE_SOURCE_LABEL[key]);
    return [{
      id: `google:${accountId}`,
      provider: "google" as const,
      accountId,
      app: "Google",
      identity: str(row.email),
      status: "active" as const,
      connectedAt: str(row.connectedAt),
      sources,
    }];
  });
}

export function slackIntegrationsFromBody(body: unknown): PersonalIntegration[] {
  return rows(body).flatMap((row) => {
    const accountId = str(row.accountId);
    if (!accountId) return [];
    const display = str(row.slackUserDisplay);
    const team = str(row.teamName);
    return [{
      id: `slack:${accountId}`,
      provider: "slack" as const,
      accountId,
      app: "Slack (personal)",
      identity: [display, team].filter(Boolean).join(" · "),
      status: row.reconnectNeeded === true ? ("reconnect" as const) : ("active" as const),
      connectedAt: str(row.connectedAt),
      sources: [],
    }];
  });
}

/** "Connected Sep 30, 2026"; "" when the date is missing or unreadable. */
export function connectedLabel(iso: string): string {
  const ms = Date.parse(iso);
  if (!iso || Number.isNaN(ms)) return "";
  return `Connected ${new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}

/** Plain-language copy for a failed load. Never echoes server text. */
export function integrationsErrorReason(code: string): string {
  if (/http-401|http-403|auth/i.test(code)) {
    return "Your sign-in expired. Sign in again to see your connections.";
  }
  if (code === "unavailable") return "Connections are not available in this window.";
  return "Could not load your connections. Check your connection and retry.";
}

export class IntegrationsLoadError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "IntegrationsLoadError";
  }
}

/**
 * Load both providers. One provider failing still returns the other's rows;
 * only a total failure throws.
 */
export async function loadPersonalIntegrations(api: PersonalIntegrationsApi | null | undefined): Promise<PersonalIntegration[]> {
  if (!api?.listMyGoogleAccounts && !api?.listMySlackAccounts) {
    throw new IntegrationsLoadError(integrationsErrorReason("unavailable"));
  }
  const [google, slack] = await Promise.all([
    api.listMyGoogleAccounts?.() ?? null,
    api.listMySlackAccounts?.() ?? null,
  ]);
  const results = [google, slack].filter((res) => res !== null);
  const failed = results.filter((res) => !res.ok);
  if (results.length > 0 && failed.length === results.length) {
    const first = failed[0];
    console.warn("[personal-integrations] load failed", first && !first.ok ? failCode(first) : "");
    throw new IntegrationsLoadError(integrationsErrorReason(first && !first.ok ? failCode(first) : ""));
  }
  for (const res of failed) {
    if (!res.ok) console.warn("[personal-integrations] one provider failed", failCode(res));
  }
  return [
    ...(google?.ok ? googleIntegrationsFromBody(google.value) : []),
    ...(slack?.ok ? slackIntegrationsFromBody(slack.value) : []),
  ];
}

const cache = new Map<string, PersonalIntegration[]>();

export function readIntegrationsCache(owner = "personal"): PersonalIntegration[] | null {
  return cache.get(owner) ?? null;
}

export function writeIntegrationsCache(rowsToSave: PersonalIntegration[], owner = "personal"): void {
  cache.set(owner, rowsToSave);
}

export function clearIntegrationsCache(): void {
  cache.clear();
}
