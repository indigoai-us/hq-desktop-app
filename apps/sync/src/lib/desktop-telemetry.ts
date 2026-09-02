import { invoke } from '@tauri-apps/api/core';

type InvokeCommand = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type DesktopTelemetryProperties = Record<
  string,
  string | number | boolean | null | undefined
>;

const EMIT_SKILL_TELEMETRY_COMMAND = 'emit_desktop_telemetry_if_opted_in';
const EMIT_OPERATIONAL_TELEMETRY_COMMAND = 'emit_desktop_operational_telemetry';

export interface EmitDesktopTelemetryOptions {
  eventName: string;
  properties?: DesktopTelemetryProperties;
  /** Stable install-session identifier, stored at the telemetry envelope level. */
  sessionId?: string;
  /** Product-seam timestamp retained when a buffered event is flushed later. */
  occurredAt?: string;
  invokeCommand?: InvokeCommand;
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
