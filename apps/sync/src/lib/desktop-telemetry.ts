import { invoke } from '@tauri-apps/api/core';

type InvokeCommand = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type DesktopTelemetryProperties = Record<
  string,
  string | number | boolean | string[] | null | undefined
>;

const EMIT_SKILL_TELEMETRY_COMMAND = 'emit_desktop_telemetry_if_opted_in';
const EMIT_OPERATIONAL_TELEMETRY_COMMAND = 'emit_desktop_operational_telemetry';
const PLAN_LIMIT_PROMPT_FLAG = 'billing.limit-at-action-prompt';

export type PlanLimitPromptEventName =
  | 'plan_limit_prompt_exposed'
  | 'plan_limit_prompt_engaged';

export interface EmitPlanLimitPromptTelemetryOptions {
  /** Authenticated native hq-pro transport; the webview never reads a token. */
  fetch: typeof globalThis.fetch;
  eventName: PlanLimitPromptEventName;
  companyUid: string;
  exposureId: string;
  action?: 'upgrade_clicked';
  occurredAt?: string;
}

/**
 * Send the rendered desktop sync-limit prompt facts through hq-pro's existing
 * authenticated telemetry endpoint. The rollout flag resolves through the
 * same hq-flags service and fails closed when absent or unreadable.
 */
export async function emitPlanLimitPromptTelemetry({
  fetch: authenticatedFetch,
  eventName,
  companyUid,
  exposureId,
  action,
  occurredAt = new Date().toISOString(),
}: EmitPlanLimitPromptTelemetryOptions): Promise<void> {
  if (!/^cmp_[A-Za-z0-9_-]+$/.test(companyUid)) return;
  if (
    !/^[A-Za-z0-9_.:#-]{1,160}$/.test(exposureId) ||
    /^(?:prs|agt|cmp)_[A-Za-z0-9_-]+$/.test(exposureId)
  ) return;
  if (
    (eventName === 'plan_limit_prompt_engaged' && action !== 'upgrade_clicked') ||
    (eventName === 'plan_limit_prompt_exposed' && action !== undefined)
  ) return;

  try {
    const flagResponse = await authenticatedFetch('/v1/flags/resolve');
    if (!flagResponse.ok) return;
    const snapshot: unknown = await flagResponse.json();
    if (
      typeof snapshot !== 'object' ||
      snapshot === null ||
      !('flags' in snapshot) ||
      typeof snapshot.flags !== 'object' ||
      snapshot.flags === null ||
      !(PLAN_LIMIT_PROMPT_FLAG in snapshot.flags) ||
      snapshot.flags[PLAN_LIMIT_PROMPT_FLAG] !== true
    ) return;

    const properties: Record<string, string> = {
      surface: 'desktop_sync_limit_notice',
      resourceKind: 'storageBytes',
      presentationKind: 'advisory',
      exposureId,
    };
    if (action) properties.action = action;

    const response = await authenticatedFetch('/v1/telemetry/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            eventName,
            app: 'hq-desktop-app',
            source: 'desktop',
            occurredAt,
            consentBasis: 'no-consent',
            schemaVersion: 2,
            idempotencyKey: `desktop-limit-prompt:${eventName}:${exposureId}`,
            companyUid,
            properties,
          },
        ],
      }),
    });
    if (!response.ok) {
      console.warn('[telemetry] desktop plan-limit prompt event was rejected');
    }
  } catch {
    // Best effort: telemetry transport failures must not affect the notice or CTA.
    console.warn('[telemetry] desktop plan-limit prompt event could not be sent');
  }
}

export interface EmitDesktopTelemetryOptions {
  eventName: string;
  properties?: DesktopTelemetryProperties;
  /** Stable install-session identifier, stored at the telemetry envelope level. */
  sessionId?: string;
  /** Product-seam timestamp retained when a buffered event is flushed later. */
  occurredAt?: string;
  invokeCommand?: InvokeCommand;
}

export type DesktopAuthProgressStep =
  | 'sign_in_started'
  | 'provider_page_opened'
  | 'callback_received'
  | 'token_exchange_ok';

export type DesktopAuthErrorCategory =
  | 'auth'
  | 'network'
  | 'dns'
  | 'tls'
  | 'timeout'
  | 'cancelled'
  | 'unsupported-platform'
  | 'unknown';

export interface EmitDesktopAuthProgressOptions {
  provider: string;
  step: DesktopAuthProgressStep;
  sessionId?: string;
  invokeCommand?: InvokeCommand;
}

export interface EmitDesktopAuthFailureOptions {
  provider: string;
  step: DesktopAuthProgressStep;
  error: unknown;
  invokeCommand?: InvokeCommand;
}

/**
 * Convert a local sign-in error into the small, closed vocabulary allowed in
 * operational telemetry. Raw provider errors, URLs, codes, and tokens must
 * never leave the desktop in these progress rows.
 */
export function classifyDesktopAuthError(error: unknown): DesktopAuthErrorCategory {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const value = message.toLowerCase();
  if (/cancel|denied/.test(value)) return 'cancelled';
  if (/timed out|timeout|expired/.test(value)) return 'timeout';
  if (/dns|resolve host|name or service/.test(value)) return 'dns';
  if (/tls|certificate|ssl/.test(value)) return 'tls';
  if (/network|offline|connection|fetch failed/.test(value)) return 'network';
  if (/desktop bridge|invoke|open.*browser|shell/.test(value)) return 'unsupported-platform';
  if (/oauth|provider|state|token|port.in.use|authentication/.test(value)) return 'auth';
  return 'unknown';
}

export async function emitDesktopAuthProgress({
  provider,
  step,
  sessionId,
  invokeCommand,
}: EmitDesktopAuthProgressOptions): Promise<void> {
  await emitDesktopOperationalTelemetry({
    eventName: 'desktop_auth_progress',
    properties: { provider, step },
    sessionId,
    invokeCommand,
  });
}

export async function emitDesktopAuthFailure({
  provider,
  step,
  error,
  invokeCommand,
}: EmitDesktopAuthFailureOptions): Promise<void> {
  await emitDesktopOperationalTelemetry({
    eventName: 'desktop_auth_failure',
    properties: { provider, step, errorCategory: classifyDesktopAuthError(error) },
    invokeCommand,
  });
}

export async function emitDesktopTelemetry({
  eventName,
  properties = {},
  sessionId,
  occurredAt,
  invokeCommand = invoke as InvokeCommand,
}: EmitDesktopTelemetryOptions): Promise<void> {
  try {
    await emitDesktopTelemetryStrict({
      eventName,
      properties,
      sessionId,
      occurredAt,
      invokeCommand,
    });
  } catch (err) {
    console.warn('[telemetry] emit_desktop_telemetry_if_opted_in failed:', err);
  }
}

/**
 * Send a consent-gated skill event while preserving delivery failures for a
 * caller that owns a durable skill-telemetry queue. Most callers should use
 * the best-effort `emitDesktopTelemetry` wrapper instead.
 */
export async function emitDesktopTelemetryStrict({
  eventName,
  properties = {},
  sessionId,
  occurredAt,
  invokeCommand = invoke as InvokeCommand,
}: EmitDesktopTelemetryOptions): Promise<void> {
  const args: Record<string, unknown> = { eventName, properties };
  if (sessionId !== undefined) args.sessionId = sessionId;
  if (occurredAt !== undefined) args.occurredAt = occurredAt;
  await invokeCommand(EMIT_SKILL_TELEMETRY_COMMAND, args);
}

/**
 * Send installation and service-transaction telemetry. These records describe
 * setup and delivery health, never skill usage, so they do not depend on the
 * person's skill-telemetry preference.
 */
export async function emitDesktopOperationalTelemetry({
  eventName,
  properties = {},
  sessionId,
  occurredAt,
  invokeCommand = invoke as InvokeCommand,
}: EmitDesktopTelemetryOptions): Promise<void> {
  try {
    await emitDesktopOperationalTelemetryStrict({
      eventName,
      properties,
      sessionId,
      occurredAt,
      invokeCommand,
    });
  } catch (err) {
    console.warn('[telemetry] emit_desktop_operational_telemetry failed:', err);
  }
}

/**
 * Send an operational event while preserving failures for the durable
 * authentication-delivery queue owned by onboarding telemetry.
 */
export async function emitDesktopOperationalTelemetryStrict({
  eventName,
  properties = {},
  sessionId,
  occurredAt,
  invokeCommand = invoke as InvokeCommand,
}: EmitDesktopTelemetryOptions): Promise<void> {
  const args: Record<string, unknown> = { eventName, properties };
  if (sessionId !== undefined) args.sessionId = sessionId;
  if (occurredAt !== undefined) args.occurredAt = occurredAt;
  await invokeCommand(EMIT_OPERATIONAL_TELEMETRY_COMMAND, args);
}
