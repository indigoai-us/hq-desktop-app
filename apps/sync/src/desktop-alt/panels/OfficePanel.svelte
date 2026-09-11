<script lang="ts">
  /**
   * Desktop-alt binding for the Office surface (US-018).
   *
   * There is exactly ONE Office implementation and it lives in
   * `@hq/ui` (`packages/ui/src/meet/OfficePanel.svelte`), because the shipping
   * shell mounts it too. This file only supplies the two things @hq/ui may not
   * reach for itself: the Sync platform adapter and the native calling seams
   * (bundled US-011 receipt, `calls_open_window`, device fingerprint).
   */
  import { invoke as tauriInvoke } from '@tauri-apps/api/core';
  import { createSyncPlatformAdapter, type SyncInvokeFn } from '@hq/platform';
  import { meet } from '@hq/ui';
  import { createNativeCallsHost } from '../work-shell-capabilities';

  interface Props {
    /** Cloud company uid. Null when this company is not cloud-backed. */
    companyUid?: string | null;
    /** Human label for the company, used in the not-connected state. */
    companyLabel?: string;
    invokeFn?: SyncInvokeFn;
  }

  let {
    companyUid = null,
    companyLabel = 'This company',
    invokeFn = tauriInvoke as SyncInvokeFn,
  }: Props = $props();

  const adapter = createSyncPlatformAdapter({
    invoke: (command, args) => invokeFn(command, args),
  });
  const callsHost = createNativeCallsHost(
    <T,>(command: string, args?: Record<string, unknown>) =>
      invokeFn(command, args) as Promise<T>,
  );
</script>

<meet.OfficePanel {adapter} {callsHost} {companyUid} {companyLabel} />
