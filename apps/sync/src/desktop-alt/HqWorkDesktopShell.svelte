<script lang="ts">
  /**
   * Embedded HQ Work shell for the Sync desktop-alt window (US-103).
   *
   * Mounts @hq/ui DesktopApp with the Sync PlatformAdapter. ⌘, is handled
   * inside DesktopApp (openSettings) — never a second settings window.
   */
  import { invoke as tauriInvoke } from '@tauri-apps/api/core';
  import { getVersion } from '@tauri-apps/api/app';
  import { listen } from '@tauri-apps/api/event';
  import { onMount } from 'svelte';
  import {
    DesktopApp,
    createChatWakeBus,
    createLiveNotificationsApi,
    settingsProfileFromSelf,
    toSelfIdentity,
    workspacesFromMembershipRows,
    type SelfIdentity,
    type Workspace,
  } from '@hq/ui';
  import {
    createSyncPlatformAdapter,
    type SyncInvokeFn,
  } from '../lib/hq-work-adapter';
  import { applyDesktopAltRoute, createHqWorkSidebarApi } from './hq-work-host';
  import { getVaultObject, putVaultObject } from './vault-s3-put';

  interface Props {
    invokeFn?: SyncInvokeFn;
  }

  let { invokeFn = tauriInvoke as SyncInvokeFn }: Props = $props();

  const adapter = createSyncPlatformAdapter({
    invoke: (cmd, args) => invokeFn(cmd, args),
  });
  const sidebarApi = createHqWorkSidebarApi(adapter);
  const notificationsApi = createLiveNotificationsApi(adapter);
  const wakes = createChatWakeBus();

  let self = $state<SelfIdentity | null>(null);
  let companies = $state<Workspace[] | null>(null);
  let version = $state('0.0.0');

  onMount(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [who, workspaces, ver] = await Promise.all([
          adapter.identity.whoami(),
          adapter.identity.listWorkspaces(),
          getVersion().catch(() => '0.0.0'),
        ]);
        if (cancelled) return;
        if (who.ok) {
          self = toSelfIdentity({
            uid: who.value.personUid,
            email: who.value.email,
            displayName: who.value.displayName,
          });
        }
        if (workspaces.ok) {
          companies = workspacesFromMembershipRows(workspaces.value);
        }
        version = ver;
      } catch {
        /* DesktopApp still paints; identity chrome stays empty. */
      }
    })();

    void invokeFn('desktop_alt_consume_pending_route')
      .then((pending) => {
        if (cancelled) return;
        applyDesktopAltRoute(typeof pending === 'string' ? pending : null);
      })
      .catch(() => undefined);

    const unlistenPromise = listen<string>('desktop:navigate', (event) => {
      applyDesktopAltRoute(event.payload);
    }).catch(() => () => {});

    return () => {
      cancelled = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  });
</script>

<div class="hq-work-embedded" data-testid="hq-work-embedded-shell">
  <DesktopApp
    {adapter}
    {version}
    {sidebarApi}
    {notificationsApi}
    {wakes}
    {companies}
    {self}
    settingsProfile={settingsProfileFromSelf(self)}
    hydrateLiveMessages={true}
    coreFixtures={false}
    putAttachmentObject={putVaultObject}
    getAttachmentObject={getVaultObject}
  />
</div>

<style>
  :global(html),
  :global(body),
  :global(#desktop-alt) {
    width: 100%;
    height: 100%;
    margin: 0;
  }

  .hq-work-embedded {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
</style>
