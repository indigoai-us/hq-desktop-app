<script lang="ts">
  /**
   * Native desktop host for the shared @hq/work shell.
   *
   * This deliberately retains the Sync-owned lifecycle and event bridges.
   * The product UI below the host boundary is WorkShell; this component only
   * supplies native authority and delivery seams.
   */
  import { getVersion } from '@tauri-apps/api/app';
  import { invoke as tauriInvoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import WorkShell from '@hq/work/WorkShell';
  import { createSyncPlatformAdapter, type SyncInvokeFn } from '@hq/platform';
  import {
    applyAvailableUpdate,
    applyRecommendBanner,
    clearRecommendBanner,
    createChatWakeBus,
    dispatchEmbeddedNavigation,
    markDownloaded,
    markInstallStarted,
    reportDownloadProgress,
    reportIdleWait,
    reportInstallFailed,
    toSelfIdentity,
    workspacesFromMembershipRows,
    type ConversationRow,
    type EmbeddedNavigationTarget,
    type RowExtrasResolver,
    type SelfIdentity,
    type Workspace,
  } from '@hq/ui';
  import { flushSync, onMount, tick, untrack, type ComponentProps } from 'svelte';
  import { safeUnlisten } from '../lib/listener-registry';
  import { dismissBootLoader } from './boot-loader';
  import SignInPrompt from '../components/SignInPrompt.svelte';
  import { openApprovedExternalUrl, openBrowserUrl } from './external-open';
  import {
    applyDesktopAltRoute,
    createEmbeddedNavigationController,
    createHqWorkPackagesEvents,
    subscribeHqWorkNativeWakes,
  } from './hq-work-host';
  import { startDesktopMeshPresence } from './mesh-presence';
  import SessionsExtraPage from './pages/SessionsExtraPage.svelte';
  import {
    encodeHistorySessionParam,
    encodeLiveSessionParam,
    parseSessionsParam,
    sessionDraftStorageKey,
  } from './pages/sessions-route-param';
  import { liveSessionStore } from './lib/live-session-store.svelte';
  import { configureSessionStarterCache } from '../components/sessions/session-starter';
  import { saveSessionComposerDraft, setSessionComposerDraftAccount } from '../components/sessions/session-composer-drafts';
  import { projectLinksStore } from './lib/project-links-store.svelte';
  import {
    newSessionParam,
    historySessionParam,
    rowExtrasFor,
    PROJECT_CHANNEL_LINKED_EVENT,
    type ProjectChannelLinked,
    type ProjectLink,
  } from './lib/session-project-links';
  import {
    createNativeWorkShellCapabilities,
    type NativeInvokeFn,
    type NativeWorkShellCapabilities,
  } from './work-shell-capabilities';

  interface Props {
    invokeFn?: SyncInvokeFn;
    /** Tests shorten the first-paint bound so a hung fetch cannot stall. */
    bootTimeoutMs?: number;
  }

  let {
    invokeFn = tauriInvoke as SyncInvokeFn,
    bootTimeoutMs,
  }: Props = $props();

  const adapter = createSyncPlatformAdapter({
    invoke: (command, args) => invokeFn(command, args),
  });
  const wakes = createChatWakeBus();
  const navigation = createEmbeddedNavigationController();
  const packagesEvents = createHqWorkPackagesEvents(listen);
  const nativeInvoke: NativeInvokeFn = (command, args) =>
    invokeFn(command, args) as Promise<never>;

  let self = $state<SelfIdentity | null>(null);
  let companies = $state<Workspace[] | null>(null);
  let capabilities = $state<NativeWorkShellCapabilities | null>(null);
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
  let notificationWakeSeq = $state(0);
  let hydration = $state(0);
  let authGeneration = $state(0);
  let authAccountId = $state<string | null>(null);
  let revalidationPending = false;
  let detachNavigation: (() => void) | null = null;
  let updateWakeSeq = $state(0);
  // Sessions are generally available, independent of legacy machine preferences.
  type HostExtraPages = NonNullable<ComponentProps<typeof WorkShell>['extraPages']>;
  const extraPages = $derived<HostExtraPages>({
    sessions: {
      label: 'Sessions',
      detail: 'Run a Codex or Claude session inside the app',
      // A unique draft route also resets an already-open empty composer.
      // Global creation is standalone; project actions bind explicitly.
      createAction: { label: 'New session', param: () => `new?draft=${crypto.randomUUID()}` },
      component: SessionsExtraPage,
    },
  });

  /**
   * Project channels ↔ sessions. The shared sidebar paints a badge, nested
   * session rows and a "New session" action on project-channel rows through the
   * generic `rowExtras` seam; what those mean comes from this host's
   * `session_project_links` store, keyed by company slug. A new resolver on
   * every store change is what makes the rows repaint.
   */
  const companySlugByUid = $derived(
    new Map(
      (companies ?? [])
        .filter((company) => company.cloudUid)
        .map((company) => [company.cloudUid as string, company.slug]),
    ),
  );

  function companyOfLink(
    link: ProjectLink,
    byCompany: Record<string, ProjectLink[]>,
  ): string | null {
    return Object.entries(byCompany).find(([, links]) => links.includes(link))?.[0] ?? null;
  }

  async function stampSessionsExtra(
    target: EmbeddedNavigationTarget,
  ): Promise<EmbeddedNavigationTarget> {
    if (
      target.kind !== 'extra' ||
      target.page !== 'sessions' ||
      target.companyUid ||
      !target.param
    ) {
      return target;
    }
    const route = parseSessionsParam(target.param);
    let company =
      (route.kind === 'session' ? route.company : null) ||
      (route.kind === 'history' ? route.company : null) ||
      (route.kind === 'new' ? route.company : null) ||
      (route.kind === 'session' || route.kind === 'history'
        ? liveSessionStore.companyOf(route.sessionId)
        : null);
    if (
      !company &&
      (route.kind === 'session' || route.kind === 'history')
    ) {
      await liveSessionStore.refreshList();
      company = liveSessionStore.companyOf(route.sessionId);
    }
    if (!company) return target;
    if (route.kind === 'session') {
      return {
        ...target,
        companyUid: company,
        param: encodeLiveSessionParam(route.sessionId, company),
      };
    }
    if (route.kind === 'history') {
      return {
        ...target,
        companyUid: company,
        param: encodeHistorySessionParam({
          id: route.sessionId,
          tool: route.tool,
          company,
          project: route.project,
          title: route.title,
          startedAt: route.startedAt,
        }),
      };
    }
    return { ...target, companyUid: company };
  }

  const rowExtras = $derived.by<RowExtrasResolver | null>(() => {
    if (lifecycle !== 'ready') return null;
    const byCompany = projectLinksStore.byCompany;
    const slugByUid = companySlugByUid;
    return (row: ConversationRow, destination) => {
      const route = destination?.page === 'sessions' ? parseSessionsParam(destination.param) : null;
      const selectedSessionId = route?.kind === 'session' || route?.kind === 'history' || route?.kind === 'shared' ? route.sessionId : null;
      const slug = row.companyUid ? slugByUid.get(row.companyUid) : undefined;
      const links = slug ? (byCompany[slug] ?? []) : Object.values(byCompany).flat();
      return rowExtrasFor(
        row,
        links,
        null,
        (link) => {
          const company = slug ?? companyOfLink(link, byCompany);
          if (!company) return;
          navigation.navigate({
            kind: 'extra',
            page: 'sessions',
            param: newSessionParam(company, link.project, link.channelId),
            companyUid: row.companyUid ?? company,
          });
        },
        (_link, session) => {
          const company = slug ?? companyOfLink(_link, byCompany);
          if (!company) return;
          navigation.navigate({
            kind: 'extra',
            page: 'sessions',
            param: historySessionParam(company, _link.project, session),
            companyUid: row.companyUid ?? company,
          });
        },
        selectedSessionId,
        (link, visible) => {
          const company = slug ?? companyOfLink(link, byCompany);
          if (company) projectLinksStore.watchSharedChannel(company, link, visible);
        },
      );
    };
  });

  $effect(() => {
    if (lifecycle !== 'ready') return;
    const slugs = (companies ?? [])
      .filter((company) => company.kind === 'company' && company.slug !== 'personal')
      .map((company) => company.slug);
    // untrack: start() reads/writes store runes. Tracking those from this
    // effect re-ran start → stop → start until effect_update_depth_exceeded.
    untrack(() => projectLinksStore.start(slugs));
    return () => projectLinksStore.stop();
  });

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
    configureSessionStarterCache(next.status === 'active' ? next.accountId : null);
    setSessionComposerDraftAccount(next.status === 'active' ? next.accountId : null);
    hydration += 1;
    detachNavigation?.();
    detachNavigation = null;
    self = null;
    companies = null;
    capabilities = null;
    workspaceError = null;
    identityError = null;
    signOutError = null;
    navigation.clear();

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
    // Do not render stale tenant/account data while a new auth probe runs.
    self = null;
    companies = null;
    capabilities = null;

    try {
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
      capabilities = await createNativeWorkShellCapabilities({
        invoke: nativeInvoke,
        onUnauthorized: () => {
          void signOut();
        },
        hostIdentity: self
          ? {
              sub: self.uid,
              ...(self.email ? { email: self.email } : {}),
              ...(self.displayName ? { name: self.displayName } : {}),
            }
          : null,
      });
      if (request !== hydration || expectedGeneration !== authGeneration) return;
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
      configureSessionStarterCache(null);
      setSessionComposerDraftAccount(null);
      self = null;
      companies = null;
      capabilities = null;
      workspaceError = null;
      signedOutReason = 'signed-out';
      lifecycle = 'signed-out';
    } catch (error) {
      signOutError = readableError(error, 'Couldn’t sign out. Please try again.');
    } finally {
      signingOut = false;
    }
  }

  function handleWorkspaceSignInSuccess(): void {
    void hydrateSession();
    void invokeFn('open_desktop_alt_window');
  }

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

  // Presence lane (US-014): MeshClient over native hq-pro fetch → chat bus.
  $effect(() => {
    const fetchImpl = capabilities?.fetch;
    if (lifecycle !== 'ready' || !fetchImpl || !self?.uid) return;
    const handle = startDesktopMeshPresence({
      wakes,
      fetchImpl,
    });
    return () => handle.stop();
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
    ).catch(() => undefined);
  }

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

    const bootRevealTimeoutId = setTimeout(() => void reveal(), IDENTITY_SETTLE_TIMEOUT_MS);

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
        const setupTarget = await invokeFn('take_pending_setup_target');
        if (
          !cancelled &&
          setupTarget &&
          typeof setupTarget === 'object' &&
          typeof (setupTarget as { companyUid?: string }).companyUid === 'string' &&
          (setupTarget as { companyUid: string }).companyUid.trim()
        ) {
          const companyUid = (setupTarget as { companyUid: string }).companyUid.trim();
          const checkout =
            typeof (setupTarget as { checkout?: string }).checkout === 'string'
              ? (setupTarget as { checkout: string }).checkout
              : 'done';
          navigation.navigate({
            kind: 'setup-checkout',
            companyUid,
            checkout,
          });
        }
        const meetingId = await invokeFn('meetings_take_pending_focus');
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
        // A mounted shell still receives later native route events.
      }
    };
    void hydrateSession().finally(() => {
      void reveal();
      if (!cancelled) void restoreInitialNavigation();
    });

    const unlistenSetupPromise = listen<{
      companyUid?: string;
      checkout?: string;
    }>('messages:open-setup', (event) => {
      const companyUid = event.payload?.companyUid?.trim();
      if (!companyUid) return;
      latestLiveNavigation = 'other';
      navigation.navigate({
        kind: 'setup-checkout',
        companyUid,
        checkout: event.payload?.checkout ?? 'done',
      });
    }).catch(() => () => {});

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

    const unlistenAuthReadyPromise = listen('auth:session-ready', () => {
      if (!cancelled) requestRevalidation();
    }).catch(() => () => {});

    const updateEvents = [
      'update:available',
      'update:cleared',
      'hq-cli-update:available',
      'hq-cli-update:cleared',
    ];
    const unlistenUpdatePromises = updateEvents.map((eventName) =>
      listen(eventName, (event) => {
        if (cancelled) return;
        if (eventName === 'update:available') {
          const nextVersion =
            event.payload &&
            typeof event.payload === 'object' &&
            'version' in event.payload &&
            typeof (event.payload as { version?: unknown }).version === 'string'
              ? (event.payload as { version: string }).version
              : null;
          applyAvailableUpdate(nextVersion);
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
    const unlistenIdleWaitPromise = listen('update:waiting-for-idle', (event) => {
      if (!cancelled) reportIdleWait(event.payload);
    }).catch(() => () => {});
    const unlistenRecommendPromise = listen(
      'version-gate:update-recommended',
      (event) => {
        if (!cancelled) applyRecommendBanner(event.payload);
      },
    ).catch(() => () => {});
    const unlistenRecommendClearPromise = listen(
      'version-gate:current',
      () => {
        if (!cancelled) clearRecommendBanner();
      },
    ).catch(() => () => {});
    const unlistenForcePromise = listen('version-gate:update-required', () => {
      if (!cancelled) clearRecommendBanner();
    }).catch(() => () => {});

    const unlistenAuthSessionPromise = listen<unknown>('auth:session-changed', (event) => {
      if (cancelled) return;
      const next = parseAuthSessionEnvelope(event.payload);
      if (next) acceptAuthSession(next);
    }).catch(() => () => {});

    // WorkShell adds one component boundary before DesktopApp attaches its
    // shortcut listener. Keep the existing host shortcut live during that
    // handoff; the navigation controller queues it until the renderer is
    // ready, and duplicate delivery after attachment is idempotent.
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== ',') return;
      event.preventDefault();
      navigation.navigate({ kind: 'settings' });
    };
    window.addEventListener('keydown', onKeyDown);

    const onProjectChannelLinked = (event: Event) => {
      if (cancelled) return;
      const detail = (event as CustomEvent<ProjectChannelLinked>).detail;
      const companyUid =
        (companies ?? []).find((company) => company.slug === detail?.company)?.cloudUid ?? null;
      if (detail?.channelId && detail.channelName) {
        wakes.emit?.('channel:updated', {
          channelId: detail.channelId,
          name: detail.channelName,
          scope: 'company',
          companyUid,
          membership: 'joined',
        });
      }
      wakes.emit?.('channel:unread-changed', undefined);
    };
    window.addEventListener(PROJECT_CHANNEL_LINKED_EVENT, onProjectChannelLinked);

    const revalidateOnRecovery = () => {
      if (!cancelled) requestRevalidation({ automatic: true });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') revalidateOnRecovery();
    };
    window.addEventListener('focus', revalidateOnRecovery);
    window.addEventListener('online', revalidateOnRecovery);
    window.addEventListener('pageshow', revalidateOnRecovery);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      clearTimeout(bootRevealTimeoutId);
      hydration += 1;
      detachNavigation?.();
      detachNavigation = null;
      void unlistenSetupPromise.then((unlisten) => safeUnlisten(unlisten)());
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
      void unlistenIdleWaitPromise.then((unlisten) => safeUnlisten(unlisten)());
      void unlistenRecommendPromise.then((unlisten) => safeUnlisten(unlisten)());
      void unlistenRecommendClearPromise.then((unlisten) => safeUnlisten(unlisten)());
      void unlistenForcePromise.then((unlisten) => safeUnlisten(unlisten)());
      void unlistenAuthSessionPromise.then((unlisten) => safeUnlisten(unlisten)());
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(PROJECT_CHANNEL_LINKED_EVENT, onProjectChannelLinked);
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
      <div class="workspace-signin">
        <SignInPrompt
          reauth={signedOutReason === 'expired' || signedOutReason === 'invalid'}
          bringMainToFront={false}
          onsuccess={handleWorkspaceSignInSuccess}
        />
      </div>
      <button type="button" class="secondary" onclick={() => void hydrateSession()}>Retry</button>
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
  {:else if capabilities}
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
      <WorkShell
        onGenerateTask={async (seed) => {
          const company = (companies ?? []).find((row) => row.cloudUid === seed.companyUid);
          const slug = company?.slug?.trim();
          if (!slug) throw new Error('Company unavailable');
          const param = newSessionParam(slug, seed.projectId, seed.channelId ?? undefined);
          saveSessionComposerDraft(sessionDraftStorageKey(param), { text: seed.prompt, images: [] });
          dispatchEmbeddedNavigation({
            kind: 'extra',
            page: 'sessions',
            param,
            companyUid: seed.companyUid,
          });
        }}
        data={{ user: capabilities.hostIdentity }}
        runtimeKind={capabilities.runtimeKind}
        fetch={capabilities.fetch}
        onUnauthorized={capabilities.onUnauthorized}
        loadFilePreview={capabilities.loadFilePreview}
        hostIdentity={capabilities.hostIdentity}
        hostTenantAccountId={authAccountId}
        hostTenantGeneration={authGeneration}
        invoke={invokeFn}
        {listen}
        {wakes}
        {version}
        {updateWakeSeq}
        refreshAppVersion={getVersion}
        {packagesEvents}
        onOpenConsole={openApprovedExternalUrl}
        onopenurl={openBrowserUrl}
        {notificationWakeSeq}
        onactivethreadchange={setActiveReplyThread}
        {extraPages}
        {rowExtras}
        rowExtrasLoading={(companies === null && !workspaceError) || projectLinksStore.loading}
        rowExtrasError={Boolean(workspaceError) || projectLinksStore.initialError}
        bootTimeoutMs={bootTimeoutMs}
        onShellReady={() => {
          void invokeFn('shell_ready');
        }}
        onembeddednavigationready={() => {
          detachNavigation?.();
          // Pending-route bridge only: the shared shell converts `target`
          // through destinationFromEmbeddedTarget and commits via navigate().
          const detach = navigation.attach((target) => {
            void stampSessionsExtra(target).then((next) => {
              dispatchEmbeddedNavigation(next);
            });
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
    /* The document owns WebKit's viewport scrolling. Clipping only the
       embedded shell leaves native rubber-banding free to move all chrome. */
    overflow: hidden;
    overscroll-behavior: none;
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

  .lifecycle-state > button,
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

  .workspace-signin {
    width: min(100%, 420px);
  }

  .workspace-signin :global(.sign-in-container) {
    width: 100%;
    height: auto;
    min-height: 0;
  }

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
    from { opacity: 0.35; }
    to { opacity: 0.9; }
  }

  @media (prefers-reduced-motion: reduce) {
    .hq-work-boot-mark {
      animation: none;
      opacity: 0.85;
    }
  }
</style>
