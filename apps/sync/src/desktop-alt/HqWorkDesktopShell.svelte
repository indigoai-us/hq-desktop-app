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
  import { flushSync, onMount, tick } from 'svelte';
  import {
    DesktopApp,
    applyAvailableUpdate,
    createChatWakeBus,
    createLiveNotificationsApi,
    dispatchEmbeddedNavigation,
    markDownloaded,
    markInstallStarted,
    reportDownloadProgress,
    reportInstallFailed,
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
    subscribeHqWorkNativeWakes,
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
  type Lifecycle =
    | 'loading'
    | 'ready'
    | 'signed-out'
    | 'recovery'
    | 'identity-error';
  type AuthSessionStatus =
    | 'active'
    | 'credentials_absent'
    | 'credentials_invalid'
    | 'refresh_temporarily_unavailable';
  interface AuthSessionEnvelope {
    accountId: string | null;
    generation: number;
    status: AuthSessionStatus;
    reason: string | null;
  }
  let lifecycle = $state<Lifecycle>('loading');
  let signedOutReason = $state<'signed-out' | 'expired' | 'invalid'>('signed-out');
  let identityError = $state<string | null>(null);
  let workspaceError = $state<string | null>(null);
  let signOutError = $state<string | null>(null);
  let signingOut = $state(false);
  let reauthError = $state<string | null>(null);
  let notificationWakeSeq = $state(0);
  let hydration = $state(0);
  let authGeneration = $state(0);
  let authAccountId = $state<string | null>(null);
  let revalidationPending = false;
  let detachNavigation: (() => void) | null = null;
  // Incrementing, rather than storing an update payload, guarantees the pane
  // re-reads each authoritative command after every native state edge.
  let updateWakeSeq = $state(0);

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

  function parseAuthSessionEnvelope(value: unknown): AuthSessionEnvelope | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Record<string, unknown>;
    const accountId =
      typeof candidate.accountId === 'string' && candidate.accountId.trim()
        ? candidate.accountId.trim()
        : null;
    const generation = candidate.generation;
    const status = candidate.status;
    if (
      typeof generation !== 'number' ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      !isAuthSessionStatus(status)
    ) {
      return null;
    }
    const rawReason = typeof candidate.reason === 'string' ? candidate.reason.trim() : '';
    return {
      accountId,
      generation,
      status,
      reason: rawReason ? rawReason.slice(0, 200) : null,
    };
  }

  function isAuthSessionStatus(value: unknown): value is AuthSessionStatus {
    return (
      value === 'active' ||
      value === 'credentials_absent' ||
      value === 'credentials_invalid' ||
      value === 'refresh_temporarily_unavailable'
    );
  }

  /**
   * The native session event is the only authority allowed to cross tenants.
   * Clear synchronously before starting a B request: every mounted descendant
   * is keyed by this generation, so its async work is cancelled at the same
   * boundary rather than being asked to recognize a future account later.
   */
  function acceptAuthSession(next: AuthSessionEnvelope): void {
    if (next.generation < authGeneration) return;
    if (
      next.generation === authGeneration &&
      next.accountId === authAccountId &&
      next.status === 'active'
    ) {
      return;
    }
    authGeneration = next.generation;
    authAccountId = next.accountId;
    hydration += 1;
    detachNavigation?.();
    detachNavigation = null;
    self = null;
    companies = null;
    workspaceError = null;
    identityError = null;
    signOutError = null;
    reauthError = null;

    if (next.status === 'credentials_absent') {
      signedOutReason = 'signed-out';
      lifecycle = 'signed-out';
      flushSync();
      return;
    }
    if (next.status === 'credentials_invalid') {
      signedOutReason = 'invalid';
      lifecycle = 'signed-out';
      flushSync();
      return;
    }
    if (next.status === 'refresh_temporarily_unavailable') {
      lifecycle = 'recovery';
      flushSync();
      return;
    }
    lifecycle = 'loading';
    flushSync();
    void hydrateSession(next.generation);
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

  async function refreshWorkspaces(request: number, generation = authGeneration): Promise<void> {
    try {
      const result = await bounded(
        adapter.identity.listWorkspaces(),
        'Workspace lookup',
      );
      if (request !== hydration || generation !== authGeneration || lifecycle !== 'ready') return;
      if (!result.ok) {
        companies = null;
        workspaceError = result.message ?? 'Couldn’t load company workspaces.';
        return;
      }
      companies = workspacesFromMembershipRows(result.value);
      workspaceError = null;
    } catch (error) {
      if (request !== hydration || generation !== authGeneration || lifecycle !== 'ready') return;
      companies = null;
      workspaceError = readableError(error, 'Couldn’t load company workspaces.');
    }
  }

  async function hydrateSession(expectedGeneration = authGeneration): Promise<void> {
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
      // Start the identity request under this request/generation lease while
      // native resolves credentials. If native reports a newer tenant, its
      // completion is ignored below; starting both keeps the no-transition
      // bootstrap path from adding a second visible loading turn.
      const whoami = bounded(adapter.identity.whoami(), 'Identity lookup');
      const nativeSession = parseAuthSessionEnvelope(
        await bounded(invokeFn('get_auth_session'), 'Auth session lookup'),
      );
      if (request !== hydration || expectedGeneration !== authGeneration) return;
      if (
        nativeSession &&
        (nativeSession.generation !== authGeneration ||
          nativeSession.accountId !== authAccountId ||
          nativeSession.status !== 'active')
      ) {
        // This request no longer owns the shell. Its speculative identity
        // result cannot update a later tenant, but must still be observed so
        // a rejected network promise never becomes an unhandled rejection.
        void whoami.catch(() => undefined);
        acceptAuthSession(nativeSession);
        return;
      }
      const who = await whoami;
      if (request !== hydration || expectedGeneration !== authGeneration) return;
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
      void refreshWorkspaces(request, expectedGeneration);
    } catch (error) {
      if (request !== hydration || expectedGeneration !== authGeneration) return;
      identityError = readableError(error, 'Couldn’t verify your account.');
      lifecycle = 'identity-error';
    }

    void getVersion()
      .then((next) => {
        if (request === hydration && expectedGeneration === authGeneration) version = next;
      })
      .catch(() => undefined);
  }

  async function retryWorkspaces(): Promise<void> {
    if (lifecycle !== 'ready') return;
    workspaceError = null;
    await refreshWorkspaces(hydration, authGeneration);
  }

  function requestRevalidation(options: { automatic?: boolean } = {}): void {
    // Browser wakeups are recovery probes only. Revalidating a ready session
    // forces `hydrateSession()` through loading and remounts DesktopApp,
    // which discards the user's current destination for no auth transition.
    // OAuth completion and explicit Retry remain allowed outside recovery.
    if (options.automatic && lifecycle !== 'recovery') return;
    if (revalidationPending) return;
    revalidationPending = true;
    void hydrateSession(authGeneration).finally(() => {
      revalidationPending = false;
    });
  }

  async function signOut(): Promise<void> {
    if (signingOut) return;
    signingOut = true;
    signOutError = null;
    try {
      await invokeFn('sign_out');
      navigation.clear();
      authGeneration += 1;
      authAccountId = null;
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

  // Sync owns MQTT credentials and turns wake-only publishes into reconciled,
  // authenticated native events. Subscribe only for the currently mounted
  // account/membership snapshot; explicit foreign company payloads fail closed.
  $effect(() => {
    const personUid = self?.uid?.trim() ?? '';
    const scopedCompanies = companies;
    if (lifecycle !== 'ready' || !personUid) return;
    const companyUids = new Set(
      (scopedCompanies ?? [])
        .map((company) => company.cloudUid?.trim() ?? '')
        .filter(Boolean),
    );
    let closed = false;
    const subscribed = subscribeHqWorkNativeWakes({
      listen,
      wakes,
      scope: () => {
        if (closed || lifecycle !== 'ready' || self?.uid !== personUid) return null;
        return { personUid, companyUids };
      },
      onNotificationWake: () => {
        if (!closed && lifecycle === 'ready' && self?.uid === personUid) {
          notificationWakeSeq += 1;
        }
      },
    });
    return () => {
      closed = true;
      void subscribed.then((unsubscribe) => unsubscribe());
    };
  });

  function setActiveReplyThread(
    active:
      | {
          rootEventId: string;
          scope: 'channel' | 'dm';
          channelId?: string | null;
          withPersonUid?: string | null;
          seenReplyIds: string[];
        }
      | null,
  ): void {
    if (lifecycle !== 'ready' || !self?.uid) return;
    void invokeFn(
      'set_active_thread',
      active
        ? {
            rootEventId: active.rootEventId,
            scope: active.scope,
            channelId: active.channelId ?? null,
            withPersonUid: active.withPersonUid ?? null,
            seenReplyIds: active.seenReplyIds,
          }
        : { rootEventId: null },
    ).catch(() => {
      // Native active-thread registration is a realtime optimization. The
      // shared UI retains its bounded disconnected-state fallback when absent.
    });
  }

  /** Hung whoami / listWorkspaces must not shimmer this window forever. */
  const IDENTITY_SETTLE_TIMEOUT_MS = 4000;

  onMount(() => {
    let cancelled = false;
    let latestLiveNavigation: 'meetings' | 'other' | null = null;
    let receivedLiveMeetingFocus = false;
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
    const bootRevealTimeoutId = setTimeout(() => void reveal(), IDENTITY_SETTLE_TIMEOUT_MS);

    // The route must be restored before its optional meeting-focus payload.
    // Consume them in this order so a specific focus target is the final
    // navigation request during a slow auth mount. A live request received
    // after this window was created is newer than both cold-start values: still
    // consume them to clear native state, but never let them navigate backward.
    const restoreInitialNavigation = async () => {
      try {
        const pending = await invokeFn('desktop_alt_consume_pending_route');
        if (cancelled) return;
        if (!latestLiveNavigation) {
          applyDesktopAltRoute(
            typeof pending === 'string' ? pending : null,
            navigation,
          );
        }
        const meetingId = await invokeFn('meetings_take_pending_focus');
        // Native emits a meeting-focus event before its paired live Meetings
        // route. If listener registration missed only that first event, the
        // one-shot pending ID still belongs to the latest visible destination.
        const pendingFocusIsCurrent =
          latestLiveNavigation === null ||
          (latestLiveNavigation === 'meetings' && !receivedLiveMeetingFocus);
        if (
          cancelled ||
          !pendingFocusIsCurrent ||
          typeof meetingId !== 'string' ||
          !meetingId.trim()
        ) return;
        navigation.navigate({ kind: 'meetings', meetingId });
      } catch {
        // Pending desktop navigation is best-effort; a mounted route still
        // accepts future native navigation events.
      }
    };
    // Hydration may perform an extra native session lookup before the shared
    // app mounts. Deferring cold delivery until that boundary has settled keeps
    // a pending route/focus pair from racing a not-yet-attached renderer.
    void hydrateSession().finally(() => {
      void reveal();
      if (!cancelled) void restoreInitialNavigation();
    });

    const unlistenPromise = listen<string>('desktop:navigate', (event) => {
      const target = applyDesktopAltRoute(event.payload, navigation);
      if (target) {
        latestLiveNavigation = target.kind === 'meetings' ? 'meetings' : 'other';
      }
    }).catch(() => () => {});

    const unlistenMeetingFocusPromise = listen<{ meetingId?: string }>(
      'meetings:focus-meeting',
      (event) => {
        const meetingId = event.payload?.meetingId?.trim();
        if (meetingId) {
          latestLiveNavigation = 'meetings';
          receivedLiveMeetingFocus = true;
          navigation.navigate({ kind: 'meetings', meetingId });
        }
      },
    ).catch(() => () => {});

    // Emitted only after OAuth tokens have been persisted by native code. This
    // is an authoritative completion edge, not a timing-based reauth poll.
    const unlistenAuthReadyPromise = listen('auth:session-ready', () => {
      if (!cancelled) requestRevalidation();
    }).catch(() => () => {});

    const updateEvents = [
      'update:available',
      'update:cleared',
      // `check_core_state` emits this after every successful probe. Treating
      // that completion as a wake would recursively re-run the same probe.
      'hq-cli-update:available',
      'hq-cli-update:cleared',
    ];
    const unlistenUpdatePromises = updateEvents.map((eventName) =>
      listen(eventName, (event) => {
        if (cancelled) return;
        if (eventName === 'update:available') {
          const version =
            event.payload &&
            typeof event.payload === 'object' &&
            'version' in event.payload &&
            typeof (event.payload as { version?: unknown }).version === 'string'
              ? (event.payload as { version: string }).version
              : null;
          applyAvailableUpdate(version);
        } else if (eventName === 'update:cleared') {
          applyAvailableUpdate(null);
        }
        updateWakeSeq += 1;
      }).catch(() => () => {}),
    );
    const unlistenProgressPromise = listen('update:progress', (event) => {
      if (!cancelled) reportDownloadProgress(event.payload);
    }).catch(() => () => {});
    const unlistenInstallStartedPromise = listen<{ version?: string }>(
      'update:install-started',
      (event) => {
        if (!cancelled) markInstallStarted(event.payload?.version ?? null);
      },
    ).catch(() => () => {});
    const unlistenDownloadedPromise = listen<{ version?: string }>(
      'update:downloaded',
      (event) => {
        if (!cancelled) markDownloaded(event.payload?.version ?? null);
      },
    ).catch(() => () => {});
    const unlistenInstallFailedPromise = listen('update:install-failed', (event) => {
      if (!cancelled) reportInstallFailed(event.payload);
    }).catch(() => () => {});

    const unlistenAuthSessionPromise = listen<unknown>('auth:session-changed', (event) => {
      if (cancelled) return;
      const next = parseAuthSessionEnvelope(event.payload);
      if (next) acceptAuthSession(next);
    }).catch(() => () => {});

    const revalidateOnRecovery = () => {
      if (!cancelled) requestRevalidation({ automatic: true });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') revalidateOnRecovery();
    };
    window.addEventListener('focus', revalidateOnRecovery);
    window.addEventListener('online', revalidateOnRecovery);
    // `pageshow` covers a restored/resumed webview where focus is not
    // re-dispatched (for example after an OS sleep/wake cycle).
    window.addEventListener('pageshow', revalidateOnRecovery);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      clearTimeout(bootRevealTimeoutId);
      hydration += 1;
      detachNavigation?.();
      detachNavigation = null;
      // Shared teardown boundary: idempotent, and a throw here can never
      // escape into Svelte's cleanup pass.
      void unlistenPromise.then((unlisten) => safeUnlisten(unlisten)());
      void unlistenMeetingFocusPromise.then((unlisten) => safeUnlisten(unlisten)());
      void unlistenAuthReadyPromise.then((unlisten) => safeUnlisten(unlisten)());
      for (const unlistenPromise of unlistenUpdatePromises) {
        void unlistenPromise.then((unlisten) => safeUnlisten(unlisten)());
      }
      void unlistenProgressPromise.then((unlisten) => safeUnlisten(unlisten)());
      void unlistenInstallStartedPromise.then((unlisten) => safeUnlisten(unlisten)());
      void unlistenDownloadedPromise.then((unlisten) => safeUnlisten(unlisten)());
      void unlistenInstallFailedPromise.then((unlisten) => safeUnlisten(unlisten)());
      void unlistenAuthSessionPromise.then((unlisten) => safeUnlisten(unlisten)());
      window.removeEventListener('focus', revalidateOnRecovery);
      window.removeEventListener('online', revalidateOnRecovery);
      window.removeEventListener('pageshow', revalidateOnRecovery);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  });
</script>

<div class="hq-work-embedded" data-testid="hq-work-embedded-shell">
  {#if lifecycle === 'loading'}
    <section class="lifecycle-state" data-testid="hq-work-loading" role="status">
      <div class="hq-work-boot" data-testid="hq-work-boot" aria-busy="true" aria-live="polite">
        <span class="hq-work-boot-mark">HQ</span>
      </div>
    </section>
  {:else if lifecycle === 'signed-out'}
    <section class="lifecycle-state" data-testid="hq-work-signed-out" role="status">
      <h1>{signedOutReason === 'expired' ? 'Your session expired' : signedOutReason === 'invalid' ? 'Your sign-in is no longer valid' : 'You are signed out'}</h1>
      <p>
        {signedOutReason === 'expired'
          ? 'Sign in again to continue using HQ Work.'
          : 'This device no longer has an active HQ Work session.'}
      </p>
      <button type="button" onclick={() => void beginReauth()}>Sign in</button>
      <button type="button" class="secondary" onclick={() => void hydrateSession()}>Retry</button>
      {#if reauthError}<p class="lifecycle-error" role="alert">{reauthError}</p>{/if}
    </section>
  {:else if lifecycle === 'recovery'}
    <section class="lifecycle-state" data-testid="hq-work-auth-recovery" role="status">
      <h1>Reconnecting your HQ Work session</h1>
      <p>Your credentials are still saved. We’ll retry when the connection returns.</p>
      <button type="button" class="secondary" onclick={() => requestRevalidation()}>Retry now</button>
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
    {#key authGeneration}
    <DesktopApp
      {adapter}
      {version}
      {updateWakeSeq}
      refreshAppVersion={getVersion}
      {sidebarApi}
      {notificationsApi}
      {wakes}
      {notificationWakeSeq}
      {packagesEvents}
      {companies}
      {self}
      tenantAccountId={authAccountId}
      tenantGeneration={authGeneration}
      settingsProfile={settingsProfileFromSelf(self)}
      hydrateLiveMessages={true}
      coreFixtures={false}
      putAttachmentObject={putVaultObject}
      getAttachmentObject={getVaultObject}
      onsignout={signOut}
      onOpenConsole={openApprovedExternalUrl}
      onopenurl={openApprovedExternalUrl}
      onactivethreadchange={setActiveReplyThread}
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
    {/key}
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
