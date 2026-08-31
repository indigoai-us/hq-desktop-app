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
  import { onMount, tick } from 'svelte';
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
  import { safeUnlisten } from '../lib/listener-registry';
  import { getVaultObject, putVaultObject } from './vault-s3-put';
  import { dismissBootLoader } from './boot-loader';

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
  /**
   * `DesktopApp` snapshots `settingsProfile` into its own state at mount, so
   * mounting before `whoami` resolves bakes in the empty profile derived from
   * `self === null` — the Settings → Profile pane then reads "No profile data
   * yet" for a signed-in user, which the US-107 live run recorded. Mount once
   * the identity attempt has SETTLED, not once it succeeded: a failed or
   * signed-out probe must still paint the shell rather than hang on a
   * spinner forever.
   */
  let identitySettled = $state(false);

  /** Hung whoami / listWorkspaces must not shimmer this window forever. */
  const IDENTITY_SETTLE_TIMEOUT_MS = 4000;

  onMount(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let revealed = false;

    const reveal = async () => {
      if (cancelled || revealed) return;
      revealed = true;
      identitySettled = true;
      await tick();
      if (!cancelled) dismissBootLoader();
    };

    void (async () => {
      const identity = Promise.all([
        adapter.identity.whoami(),
        adapter.identity.listWorkspaces(),
        getVersion().catch(() => '0.0.0'),
      ]);

      // Race the identity probe with a timeout so a hung invoke cannot
      // blank/spinner the window forever. On timeout we paint DesktopApp
      // with whatever identity we have (same settled-not-succeeded rule
      // as a failed probe). A late response still fills chrome below.
      const outcome = await Promise.race([
        identity.then(
          () => 'ready' as const,
          () => 'ready' as const,
        ),
        new Promise<'timeout'>((resolve) => {
          timeoutId = setTimeout(() => resolve('timeout'), IDENTITY_SETTLE_TIMEOUT_MS);
        }),
      ]);
      if (timeoutId !== undefined) clearTimeout(timeoutId);

      if (cancelled) return;
      if (outcome === 'timeout') {
        await reveal();
      }

      try {
        const [who, workspaces, ver] = await identity;
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
      } finally {
        await reveal();
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
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      // Shared teardown boundary: idempotent, and a throw here can never
      // escape into Svelte's cleanup pass.
      void unlistenPromise.then((unlisten) => safeUnlisten(unlisten)());
    };
  });
</script>

<div class="hq-work-embedded" data-testid="hq-work-embedded-shell">
  {#if identitySettled}
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
  {:else}
    <div
      class="hq-work-boot"
      data-testid="hq-work-boot"
      aria-busy="true"
      aria-live="polite"
    >
      <span class="hq-work-boot-mark">HQ</span>
    </div>
  {/if}
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

  .hq-work-boot {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .hq-work-boot-mark {
    font-family: var(--font-sans, system-ui, sans-serif);
    font-weight: 600;
    font-size: 15px;
    letter-spacing: 0.16em;
    line-height: 1;
    color: var(--c-text, var(--v4-text-1, currentColor));
    animation: hq-work-boot-pulse 1.6s ease-in-out infinite alternate;
  }

  @keyframes hq-work-boot-pulse {
    from {
      opacity: 0.35;
    }
    to {
      opacity: 0.9;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .hq-work-boot-mark {
      animation: none;
      opacity: 0.85;
    }
  }
</style>
