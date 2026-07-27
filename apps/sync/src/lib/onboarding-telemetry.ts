import { invoke } from '@tauri-apps/api/core';

type InvokeCommand = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const POST_OPT_IN_COMMAND = 'post_telemetry_opt_in';
const WRITE_PREF_COMMAND = 'write_menubar_telemetry_pref';

export interface PostOptInOptions {
  enabled: boolean;
  invokeCommand?: InvokeCommand;
}

/**
 * Cache the telemetry choice locally, then persist it remotely when possible.
 *
 * The local write comes FIRST, deliberately. It is what stamps the answer with
 * the account that gave it (the Cognito subject, read at call time), and the
 * remote POST retries for up to ~15 seconds without being cancelled by a
 * sign-out. Writing after the upload meant a user who answered and then signed
 * out could have their answer stored under the NEXT account's subject — which
 * would later let that account's consent repair replay a choice it never made.
 *
 * It is also the honest order: the local cache exists precisely so the answer
 * survives a failed upload.
 */
export async function postOptIn({
  enabled,
  invokeCommand = invoke as InvokeCommand,
}: PostOptInOptions): Promise<void> {
  try {
    await invokeCommand(WRITE_PREF_COMMAND, { enabled });
  } catch (err) {
    console.error('[telemetry] write_menubar_telemetry_pref failed:', err);
  }

  try {
    await invokeCommand(POST_OPT_IN_COMMAND, { enabled });
  } catch (err) {
    console.error('[telemetry] post_telemetry_opt_in failed:', err);
  }
}
