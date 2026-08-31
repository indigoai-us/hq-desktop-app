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
    dispatchEmbeddedNavigation,
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
  import {
    applyDesktopAltRoute,
    createEmbeddedNavigationController,
    createHqWorkPackagesEvents,
    createHqWorkSidebarApi,
  } from './hq-work-host';
  import { openApprovedExternalUrl } from './external-open';
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
  const navigation = createEmbeddedNavigationController();
  const packagesEvents = createHqWorkPackagesEvents(listen);

  let self = $state<SelfIdentity | null>(null);
  let companies = $state<Workspace[] | null>(null);
  let version = $state('0.0.0');
  type Lifecycle = 'loading' | 'ready' | 'signed-out' | 'identity-error';
  let lifecycle = $state<Lifecycle>('loading');
  let signedOutReason = $state<'signed-out' | 'expired'>('signed-out');
  let identityError = $state<string | null>(null);
  let workspaceError = $state<string | null>(null);
  let signOutError = $state<string | null>(null);
  let signingOut = $state(false);
  let reauthError = $state<string | null>(null);
  let hydration = 0;
  let detachNavigation: (() => void) | null = null;

  const HOST_REQUEST_TIMEOUT_MS = 15_000;

  function readableError(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
  }

  function isUnauthenticated(result: { code?: string; message?: string }): boolean {
    const code = result.code?.toLowerCase() ?? '';
    const message = result.message?.toLowerCase() ?? '';
    return (
      code === 'unauthenticated' ||
      code === 'auth' ||
      code === 'http-401' ||
      message.includes('not signed in') ||
      message.includes('unauthenticated')
    );
  }

  async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} timed out. Please retry.`)),
            HOST_REQUEST_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function refreshWorkspaces(request: number): Promise<void> {
    try {
      const result = await bounded(
        adapter.identity.listWorkspaces(),
        'Workspace lookup',
      );
      if (request !== hydration || lifecycle === 'signed-out') return;
      if (!result.ok) {
        companies = null;
        workspaceError = result.message ?? 'Couldn’t load company workspaces.';
        return;
      }
      companies = workspacesFromMembershipRows(result.value);
      workspaceError = null;
    } catch (error) {
      if (request !== hydration || lifecycle === 'signed-out') return;
      companies = null;
      workspaceError = readableError(error, 'Couldn’t load company workspaces.');
    }
  }

  async function hydrateSession(): Promise<void> {
    const request = ++hydration;
    lifecycle = 'loading';
    identityError = null;
    workspaceError = null;
    signOutError = null;
    reauthError = null;
    // Do not render stale tenant/account data while a new auth probe runs.
    self = null;
    companies = null;

    try {
      const who = await bounded(adapter.identity.whoami(), 'Identity lookup');
      if (request !== hydration) return;
      if (!who.ok) {
        if (isUnauthenticated(who)) {
          signedOutReason = 'expired';
          lifecycle = 'signed-out';
        } else {
          identityError = who.message ?? 'Couldn’t verify your account.';
          lifecycle = 'identity-error';
        }
        return;
      }
      self = toSelfIdentity({
        uid: who.value.personUid,
        email: who.value.email,
        displayName: who.value.displayName,
      });
      lifecycle = 'ready';
      void refreshWorkspaces(request);
    } catch (error) {
      if (request !== hydration) return;
      identityError = readableError(error, 'Couldn’t verify your account.');
      lifecycle = 'identity-error';
    }

    void getVersion()
      .then((next) => {
        if (request === hydration) version = next;
      })
      .catch(() => undefined);
  }

  async function retryWorkspaces(): Promise<void> {
    if (lifecycle !== 'ready') return;
    workspaceError = null;
    await refreshWorkspaces(hydration);
  }

  async function signOut(): Promise<void> {
    if (signingOut) return;
    signingOut = true;
    signOutError = null;
    try {
      await invokeFn('sign_out');
      navigation.clear();
      self = null;
      companies = null;
      workspaceError = null;
      signedOutReason = 'signed-out';
      lifecycle = 'signed-out';
    } catch (error) {
      signOutError = readableError(error, 'Couldn’t sign out. Please try again.');
    } finally {
      signingOut = false;
    }
  }

  async function beginReauth(): Promise<void> {
    reauthError = null;
    try {
      await invokeFn('begin_reauth');
    } catch (error) {
      reauthError = readableError(error, 'Couldn’t start sign-in. Please try again.');
    }
  }

  /** Hung whoami / listWorkspaces must not shimmer this window forever. */
  const IDENTITY_SETTLE_TIMEOUT_MS = 4000;

  onMount(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let revealed = false;

    const reveal = async () => {
      if (cancelled || revealed) return;
      revealed = true;
      await tick();
      if (!cancelled) dismissBootLoader();
    };

    // Race the initial session hydration with a timeout so a hung invoke
    // cannot blank/spinner the boot loader forever; either way the shell's
    // own lifecycle states take over once revealed.
    timeoutId = setTimeout(() => void reveal(), IDENTITY_SETTLE_TIMEOUT_MS);
    void hydrateSession().finally(() => void reveal());

    void invokeFn('desktop_alt_consume_pending_route')
      .then((pending) => {
        if (cancelled) return;
        applyDesktopAltRoute(
          typeof pending === 'string' ? pending : null,
          navigation,
        );
      })
      .catch(() => undefined);

    const unlistenPromise = listen<string>('desktop:navigate', (event) => {
      applyDesktopAltRoute(event.payload, navigation);
    }).catch(() => () => {});

    void invokeFn('meetings_take_pending_focus')
      .then((meetingId) => {
        if (cancelled || typeof meetingId !== 'string' || !meetingId.trim()) return;
        navigation.navigate({ kind: 'meetings', meetingId });
      })
      .catch(() => undefined);

    const unlistenMeetingFocusPromise = listen<{ meetingId?: string }>(
      'meetings:focus-meeting',
      (event) => {
        const meetingId = event.payload?.meetingId?.trim();
        if (meetingId) navigation.navigate({ kind: 'meetings', meetingId });
      },
    ).catch(() => () => {});

    // Emitted only after OAuth tokens have been persisted by native code. This
    // is an authoritative completion edge, not a timing-based reauth poll.
    const unlistenAuthReadyPromise = listen('auth:session-ready', () => {
      if (!cancelled) void hydrateSession();
    }).catch(() => () => {});

    return () => {
      cancelled = true;
if (timeoutId !== undefined) clearTimeout(timeoutId);
      hydration += 1;
      detachNavigation?.();
      detachNavigation = null;
      // Shared teardown boundary: idempotent, and a throw here can never
      // escape into Svelte's cleanup pass.
      void unlistenPromise.then((unlisten) => safeUnlisten(unlisten)());
      void unlistenMeetingFocusPromise.then((unlisten) => safeUnlisten(unlisten)());
      void unlistenAuthReadyPromise.then((unlisten) => safeUnlisten(unlisten)());
    };
  });
</script>

<div class="hq-work-embedded" data-testid="hq-work-embedded-shell">
  {#if lifecycle === 'loading'}
    <section class="lifecycle-state" data-testid="hq-work-loading" role="status">
      Loading your HQ Work account…
    </section>
  {:else if lifecycle === 'signed-out'}
    <section class="lifecycle-state" data-testid="hq-work-signed-out" role="status">
      <h1>{signedOutReason === 'expired' ? 'Your session expired' : 'You are signed out'}</h1>
      <p>
        {signedOutReason === 'expired'
          ? 'Sign in again to continue using HQ Work.'
          : 'This device no longer has an active HQ Work session.'}
      </p>
      <button type="button" onclick={() => void beginReauth()}>Sign in</button>
      <button type="button" class="secondary" onclick={() => void hydrateSession()}>Retry</button>
      {#if reauthError}<p class="lifecycle-error" role="alert">{reauthError}</p>{/if}
    </section>
  {:else if lifecycle === 'identity-error'}
    <section class="lifecycle-state" data-testid="hq-work-identity-error" role="alert">
      <h1>Couldn’t load your account</h1>
      <p>{identityError ?? 'Check your connection and retry.'}</p>
      <button type="button" onclick={() => void hydrateSession()}>Retry</button>
    </section>
  {:else}
    {#if workspaceError}
      <div class="workspace-warning" data-testid="hq-work-workspace-error" role="alert">
        <span>{workspaceError}</span>
        <button type="button" onclick={() => void retryWorkspaces()}>Retry workspaces</button>
      </div>
    {/if}
    {#if signOutError}
      <div class="workspace-warning" data-testid="hq-work-sign-out-error" role="alert">
        <span>{signOutError}</span>
      </div>
    {/if}
    <DesktopApp
      {adapter}
      {version}
      {sidebarApi}
      {notificationsApi}
      {wakes}
      {packagesEvents}
      {companies}
      {self}
      settingsProfile={settingsProfileFromSelf(self)}
      hydrateLiveMessages={true}
      coreFixtures={false}
      putAttachmentObject={putVaultObject}
      getAttachmentObject={getVaultObject}
      onsignout={signOut}
      onOpenConsole={openApprovedExternalUrl}
      onopenurl={openApprovedExternalUrl}
      onembeddednavigationready={() => {
        detachNavigation?.();
        const detach = navigation.attach((target) => {
          // DesktopApp installed its event listener before calling this hook.
          dispatchEmbeddedNavigation(target);
        });
        detachNavigation = detach;
        return () => {
          detach();
          if (detachNavigation === detach) detachNavigation = null;
        };
      }}
    />
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

  .lifecycle-state {
    display: grid;
    place-content: center;
    gap: 12px;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding: 32px;
    color: #f1f5f9;
    background: #121417;
  }

  .lifecycle-state h1,
  .lifecycle-state p {
    max-width: 440px;
    margin: 0;
  }

  .lifecycle-state button,
  .workspace-warning button {
    width: fit-content;
    padding: 7px 10px;
    border: 1px solid #4b5563;
    border-radius: 7px;
    color: inherit;
    background: #252a33;
    cursor: pointer;
  }

  .lifecycle-state .secondary { background: transparent; }
  .lifecycle-error { color: #fca5a5; }

  .workspace-warning {
    position: absolute;
    z-index: 100;
    right: 16px;
    bottom: 16px;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: min(560px, calc(100% - 32px));
    padding: 10px 12px;
    border: 1px solid #854d0e;
    border-radius: 8px;
    color: #fef3c7;
    background: #3b2f10;
  }
</style>
