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
  invokeCommand?: InvokeCommand;
}

export async function emitDesktopTelemetry({
  eventName,
  properties = {},
  invokeCommand = invoke as InvokeCommand,
}: EmitDesktopTelemetryOptions): Promise<void> {
  try {
    await invokeCommand(EMIT_DESKTOP_TELEMETRY_COMMAND, {
      eventName,
      properties,
    });
  } catch (err) {
    console.warn('[telemetry] emit_desktop_telemetry_if_opted_in failed:', err);
  }
}
