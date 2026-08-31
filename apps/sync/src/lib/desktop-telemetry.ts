import { invoke } from '@tauri-apps/api/core';

type InvokeCommand = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type DesktopTelemetryProperties = Record<
  string,
  string | number | boolean | null | undefined
>;

const EMIT_DESKTOP_TELEMETRY_COMMAND = 'emit_desktop_telemetry_if_opted_in';

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
    const args: Record<string, unknown> = { eventName, properties };
    if (sessionId !== undefined) args.sessionId = sessionId;
    if (occurredAt !== undefined) args.occurredAt = occurredAt;
    await invokeCommand(EMIT_DESKTOP_TELEMETRY_COMMAND, args);
  } catch (err) {
    console.warn('[telemetry] emit_desktop_telemetry_if_opted_in failed:', err);
  }
}
