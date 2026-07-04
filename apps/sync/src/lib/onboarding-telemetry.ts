import { invoke } from '@tauri-apps/api/core';

type InvokeCommand = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const POST_OPT_IN_COMMAND = 'post_telemetry_opt_in';
const WRITE_PREF_COMMAND = 'write_menubar_telemetry_pref';

export interface PostOptInOptions {
  enabled: boolean;
  invokeCommand?: InvokeCommand;
}

/**
 * Persist the onboarding telemetry choice remotely when possible and always
 * best-effort cache it locally for the telemetry fallback path.
 */
export async function postOptIn({
  enabled,
  invokeCommand = invoke as InvokeCommand,
}: PostOptInOptions): Promise<void> {
  try {
    await invokeCommand(POST_OPT_IN_COMMAND, { enabled });
  } catch (err) {
    console.error('[telemetry] post_telemetry_opt_in failed:', err);
  }

  try {
    await invokeCommand(WRITE_PREF_COMMAND, { enabled });
  } catch (err) {
    console.error('[telemetry] write_menubar_telemetry_pref failed:', err);
  }
}
