<script lang="ts">
  /**
   * Native desktop host for the shared @hq/work shell.
   *
   * This deliberately retains the Sync-owned lifecycle and event bridges.
   * The product UI below the host boundary is WorkShell; this component only
   * supplies native authority and delivery seams.
   */
  import { getVersion } from '@tauri-apps/api/app';
  import { readUiHotStatus } from '../lib/ui-hot';
  import { invoke as tauriInvoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import WorkShell from '@hq/work/WorkShell';
  import {
    approvedPlanUpgradeUrl,
    createSyncPlatformAdapter,
    DESKTOP_LIMIT_STATUS_PUSH_FLAG,
    type SyncInvokeFn,
  } from '@hq/platform';
  import { createSetupInstallGuideCallbacks } from './lib/install-guide-adapter';
  import {
    applyAvailableUpdate,
    applyRecommendBanner,
    clearRecommendBanner,
    createChatWakeBus,
    createRosterRefresher,
    dispatchEmbeddedNavigation,
    markDownloaded,
    markInstallStarted,
    reportDownloadProgress,
    reportIdleWait,
    reportInstallFailed,
    dispatchWorkPush,
    subscribeRosterRefreshEvents,
    WORK_PUSH_EVENTS,
    toSelfIdentity,
    workspacesFromMembershipRows,
    common,
    type ConversationRow,
    type EmbeddedNavigationTarget,
    type SelfIdentity,
    type Workspace,
  } from '@hq/ui';
  import { flushSync, onDestroy, onMount, tick, untrack, type ComponentProps } from 'svelte';
  import { safeUnlisten } from '../lib/listener-registry';
  import { emitPlanLimitPromptTelemetry } from '../lib/desktop-telemetry';
  import { isPostReadyActionReady } from '../lib/post-ready-action-telemetry';
  import type { DmRequestContact } from '../lib/dmRequests';
  import { dismissBootLoader } from './boot-loader';
  import SignInPrompt from '../components/SignInPrompt.svelte';
  import PlanUpgradeAction from '../components/PlanUpgradeAction.svelte';
  import { openApprovedExternalUrl, openBrowserUrl } from './external-open';
  import {
    applyDesktopAltRoute,
    createEmbeddedNavigationController,
    createHqWorkPackagesEvents,
    subscribeHqWorkNativeWakes,
  } from './hq-work-host';
  import { startDesktopMeshPresence } from './mesh-presence';
  import { startMeetingRecordingBridge } from './meeting-recording-bridge';
  import { SETUP_PROMPT } from './lib/setup-launch';
  import {
    createNativeWorkShellCapabilities,
    type NativeInvokeFn,
    type NativeWorkShellCapabilities,
  } from './work-shell-capabilities';

  interface Props {
    invokeFn?: SyncInvokeFn;
    /** Tests shorten the first-paint bound so a hung fetch cannot stall. */
    bootTimeoutMs?: number;
    /** Backoff between failed workspace-roster fetches (tests shorten it). */
    rosterRetryDelaysMs?: readonly number[];
  }

  let {
    invokeFn = tauriInvoke as SyncInvokeFn,
    bootTimeoutMs,
    rosterRetryDelaysMs,
  }: Props = $props();

  const adapter = createSyncPlatformAdapter({
    invoke: (command, args) => invokeFn(command, args),
    primeMirrorQuarantineGate: true,
  });
  /**
   * US-005: wire SetupInstallGuide's four callbacks to real Tauri commands so
   * the #setup dead-end ("no coding tool signed in") becomes a guided Install +
   * sign-in flow. Works on macOS and Windows: the Rust `install_claude_code`
   * and `install_codex` commands branch on `#[cfg]` inside the command itself.
   */
  const setupInstallGuide = createSetupInstallGuideCallbacks({
    invoke: <T,>(command: string, args?: Record<string, unknown>) =>
      invokeFn(command, args as never) as Promise<T>,
    openUrl: (url: string) => openBrowserUrl(url),
  });
  /**
   * Live AiTools state for the shared InstallChoice panel used by BOTH the
   * setup assistant and the New bot wizard. Populated LAZILY: the probe is
   * expensive (shell probes for claude/codex/grok plus stats of thousands
   * of files under ~/.claude / ~/.codex / ~/.grok) and running it on every
   * app launch froze boot (#1152). The wizard/setup surfaces ask for it
   * on demand via `requestInstallChoiceAiTools` (wired to the shell as
   * `onrequestaitools`). Kept null until then; InstallChoice renders a
   * neutral "Checking…" line and stays interactive with a "Check again"
   * retry, so a slow or failing probe never blocks the UI.
   */
  let installChoiceAiTools = $state<
    import('@hq/ui').AiTools | null
  >(null);
  let installChoiceAiToolsProbing = $state(false);
  async function refreshInstallChoiceAiTools(): Promise<void> {
    if (installChoiceAiToolsProbing) return;
    installChoiceAiToolsProbing = true;
    try {
      const res = await adapter.shell.detectAiTools();
      installChoiceAiTools = res.ok
        ? (res.value as unknown as import('@hq/ui').AiTools)
        : null;
    } catch {
      installChoiceAiTools = null;
    } finally {
      installChoiceAiToolsProbing = false;
    }
  }
  /**
   * Called by shell consumers (New bot wizard's HomeStep on mount, the
   * setup assistant's install guide) when they actually need the probe.
   * Idempotent — running twice while a probe is in flight is a no-op.
   */
  function requestInstallChoiceAiTools(): void {
    void refreshInstallChoiceAiTools();
  }
  onDestroy(() => {
    void adapter.dispose?.();
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
  // Use the same persisted marker that admits post-ready telemetry. The work
  // window normally opens after onboarding, but refresh once on mount for a
  // late handoff.
  let postReadyActionReady = $state(isPostReadyActionReady());
  let uiVersion = $state<string | null>(null);
  type Lifecycle =
    | 'loading'
    | 'ready'
    | 'signed-out'
    | 'recovery'
    | 'identity-error';
  type AuthSessionStatus =
    | 'active'
    | 'credentials_absent'
    | 'credentials_read_error'
    | 'credentials_invalid'
    | 'refresh_temporarily_unavailable'
    | 'non_human_principal';
  interface AuthSessionEnvelope {
    accountId: string | null;
    generation: number;
    status: AuthSessionStatus;
    reason: string | null;
  }
  let lifecycle = $state<Lifecycle>('loading');
  let signedOutReason = $state<'signed-out' | 'expired' | 'invalid' | 'non-human'>(
    'signed-out',
  );
  let identityError = $state<string | null>(null);
  let workspaceError = $state<string | null>(null);
  let signOutError = $state<string | null>(null);
  let signingOut = $state(false);
  interface PlanLimitNotice {
    company: string;
    companyUid: string | null;
    exposureId: string;
    /** Approved, attributed upgrade link; null → no upgrade action. */
    upgradeUrl: string | null;
    /** Notice inferred from hq-pro usage status rather than a native sync event. */
    statusPush?: boolean;
  }
  let planLimitNotices = $state<PlanLimitNotice[]>([]);
  // Notices the person dismissed while the pause is still in effect. A
  // dismissal lasts until the company's uploads resume (it leaves the native
  // snapshot), so a pause that comes back later is shown again.
  const dismissedPlanLimitKeys = new Set<string>();

  function planLimitKey(notice: PlanLimitNotice): string {
    return `${notice.company}\n${notice.upgradeUrl ?? ''}`;
  }

  /** Server link → desktop-attributed, approved link (or null). */
  function planLimitUpgradeLink(raw: unknown): string | null {
    const approved = approvedPlanUpgradeUrl(raw);
    if (!approved) return null;
    return approvedPlanUpgradeUrl(withDesktopLimitEntrySurface(approved));
  }

  /**
   * hard-stop-readiness US-019: the native registry's authoritative list of
   * companies whose uploads a plan limit paused. Seeded from `get_sync_status`
   * on mount (so a window opened after the sync pass still shows it) and
   * replaced on every `sync:uploads-paused` change.
   */
  function applyUploadsPausedSnapshot(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    const next: PlanLimitNotice[] = planLimitNotices.filter((notice) => notice.statusPush);
    const seen = new Set<string>();
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as { company?: unknown; upgradeUrl?: unknown };
      const company = typeof rec.company === 'string' ? rec.company.trim() : '';
      if (!company || seen.has(company)) continue;
      seen.add(company);
      for (let index = next.length - 1; index >= 0; index -= 1) {
        if (next[index].company === company) next.splice(index, 1);
      }
      next.push({
        company,
        companyUid: resolvePlanLimitCompanyUid(company),
        exposureId: `exposure:${crypto.randomUUID()}`,
        upgradeUrl: planLimitUpgradeLink(rec.upgradeUrl),
      });
    }
    const live = new Set(next.map(planLimitKey));
    for (const key of [...dismissedPlanLimitKeys]) {
      if (!live.has(key)) dismissedPlanLimitKeys.delete(key);
    }
    planLimitNotices = next.filter((notice) => !dismissedPlanLimitKeys.has(planLimitKey(notice)));
  }
  let planLimitOpenError = $state<string | null>(null);
  let notificationWakeSeq = $state(0);
  let hydration = $state(0);
  let authGeneration = $state(0);
  // Diagnostic bridge for the shared shell: writes to ~/.hq/logs/hq-sync.log.
  (globalThis as { __hqLog?: (tag: string, message: string) => void }).__hqLog = (tag, message) => {
    void invokeFn('frontend_log', { tag, message }).catch(() => undefined);
  };
  let authAccountId = $state<string | null>(null);
  let revalidationPending = false;
  let detachNavigation: (() => void) | null = null;
  let updateWakeSeq = $state(0);
  type HostExtraPages = NonNullable<ComponentProps<typeof WorkShell>['extraPages']>;
  const extraPages = $derived<HostExtraPages>({});

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
      value === 'credentials_read_error' ||
      value === 'credentials_invalid' ||
      value === 'refresh_temporarily_unavailable' ||
      value === 'non_human_principal'
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
    planLimitNotices = [];
    dismissedPlanLimitKeys.clear();
    planLimitOpenError = null;
    authGeneration = next.generation;
    authAccountId = next.accountId;
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

    if (
      next.status === 'credentials_absent' ||
      next.status === 'credentials_read_error'
    ) {
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
    // Usable credentials that are not a person's. Kept distinct from
    // 'invalid' so the screen can explain the actual situation — retrying or
    // signing out will not change anything while the machine credential is
    // still the one on disk.
    if (next.status === 'non_human_principal') {
      signedOutReason = 'non-human';
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

  /**
   * Resolves `true` when the roster applied (or the session moved on — nothing
   * left to retry) and `false` when the fetch failed for the session that asked.
   */
  let workspaceRequest = 0;
  const PLAN_LIMIT_WARNING_PCT = 80;
  const PLAN_LIMIT_STATUS_RESOURCES = [
    'users',
    'secrets',
    'deployments',
    'storageBytes',
    'integrations',
    'agents',
  ] as const;

  function removeStatusPushNotice(company: string): void {
    const existing = planLimitNotices.filter(
      (notice) => notice.company === company && notice.statusPush,
    );
    for (const notice of existing) dismissedPlanLimitKeys.delete(planLimitKey(notice));
    planLimitNotices = planLimitNotices.filter(
      (notice) => notice.company !== company || !notice.statusPush,
    );
  }

  function applyStatusPlanLimitNotice(company: string, upgradeUrl: string | null): void {
    const currentNotice = planLimitNotices.find(
      (notice) => notice.company === company && notice.upgradeUrl === upgradeUrl,
    );
    const notice: PlanLimitNotice = currentNotice
      ? { ...currentNotice, statusPush: true }
      : {
          company,
          companyUid: resolvePlanLimitCompanyUid(company),
          exposureId: `exposure:${crypto.randomUUID()}`,
          upgradeUrl,
          statusPush: true,
        };
    if (dismissedPlanLimitKeys.has(planLimitKey(notice))) return;
    planLimitNotices = [
      ...planLimitNotices.filter((current) => current.company !== company),
      notice,
    ];
    planLimitOpenError = null;
  }

  async function refreshPlanLimitStatus(
    workspaces: Workspace[],
    isCurrent: () => boolean,
  ): Promise<void> {
    try {
      const flag = await adapter.identity.hasFeature(DESKTOP_LIMIT_STATUS_PUSH_FLAG);
      if (!isCurrent()) return;
      if (!flag.ok || !flag.value || !capabilities?.fetch) {
        for (const notice of planLimitNotices.filter((item) => item.statusPush)) {
          removeStatusPushNotice(notice.company);
        }
        return;
      }

      const companyWorkspaces = workspaces.filter(
        (workspace) => workspace.kind === 'company' && /^cmp_[A-Za-z0-9_-]+$/.test(workspace.cloudUid ?? ''),
      );
      const present = new Set(companyWorkspaces.map((workspace) => workspace.slug));
      for (const notice of planLimitNotices.filter((item) => item.statusPush && !present.has(item.company))) {
        removeStatusPushNotice(notice.company);
      }

      for (const workspace of companyWorkspaces) {
        if (!isCurrent()) return;
        const companyUid = workspace.cloudUid!.trim();
        try {
          const response = await capabilities.fetch(
            `/v1/billing/usage-limits?companyUid=${encodeURIComponent(companyUid)}`,
            { method: 'GET' },
          );
          if (!response.ok) throw new Error(`usage-limits returned HTTP ${response.status}`);
          const status = (await response.json()) as Record<string, unknown>;
          if (!isCurrent()) return;
          const plan = status.planLimits && typeof status.planLimits === 'object'
            ? (status.planLimits as Record<string, unknown>)
            : status;
          if (
            plan.plan !== 'free' ||
            plan.cohort !== 'enforceable' ||
            plan.planLimitsExempt === true
          ) {
            removeStatusPushNotice(workspace.slug);
            continue;
          }
          const hasWarning = PLAN_LIMIT_STATUS_RESOURCES.some((resource) => {
            if (resource === 'agents' && plan.agentsGrandfathered === true) return false;
            const value = plan[resource];
            if (!value || typeof value !== 'object') return false;
            const row = value as Record<string, unknown>;
            return row.over === true || (
              typeof row.pctUsed === 'number' &&
              Number.isFinite(row.pctUsed) &&
              row.pctUsed >= PLAN_LIMIT_WARNING_PCT
            );
          });
          if (!hasWarning) {
            removeStatusPushNotice(workspace.slug);
            continue;
          }
          const upgradeUrl = planLimitUpgradeLink(plan.upgradeUrl ?? status.upgradeUrl);
          applyStatusPlanLimitNotice(workspace.slug, upgradeUrl);
        } catch (error) {
          console.error(`Could not refresh plan-limit status for ${workspace.slug}.`, error);
        }
      }
    } catch (error) {
      console.error('Could not resolve the desktop plan-limit status flag.', error);
    }
  }
  async function refreshWorkspaces(request: number, generation = authGeneration): Promise<boolean> {
    const sequence = ++workspaceRequest;
    const isCurrent = () => sequence === workspaceRequest && request === hydration && generation === authGeneration && lifecycle === 'ready';
    let planLimitStatusStarted = false;
    const startPlanLimitStatusRefresh = () => {
      if (planLimitStatusStarted || !companies) return;
      planLimitStatusStarted = true;
      void refreshPlanLimitStatus(companies, isCurrent);
    };
    try {
      // The native request keeps running after the UI deadline. Accept a late
      // success while it still belongs to this account and newest request.
      const pending = adapter.identity.listWorkspaces().then((result) => {
        if (isCurrent() && result.ok) {
          companies = workspacesFromMembershipRows(result.value);
          resolvePendingPlanLimitNoticeCompanies();
          startPlanLimitStatusRefresh();
          workspaceError = null;
        }
        return result;
      });
      const result = await bounded(
        pending,
        'Workspace lookup',
      );
      if (!isCurrent()) return true;
      if (!result.ok) {
        // Keep a previously good roster on screen; the refresher retries.
        workspaceError = result.message ?? 'Couldn’t load company workspaces.';
        return false;
      }
      companies = workspacesFromMembershipRows(result.value);
      resolvePendingPlanLimitNoticeCompanies();
      startPlanLimitStatusRefresh();
      workspaceError = null;
      return true;
    } catch (error) {
      if (!isCurrent()) return true;
      workspaceError = readableError(error, 'Couldn’t load company workspaces.');
      return false;
    }
  }

  // One bounded refresher serves the first fetch, its backoff retries, the
  // manual Retry button, and the sync runner's company events. Before this,
  // a failed first fetch left the roster empty until the user retried by hand.
  const rosterRefresher = createRosterRefresher({
    load: () => {
      if (lifecycle !== 'ready') return Promise.resolve(true);
      return refreshWorkspaces(hydration, authGeneration);
    },
    delaysMs: rosterRetryDelaysMs,
  });

  async function hydrateSession(expectedGeneration = authGeneration): Promise<void> {
    const request = ++hydration;
    rosterRefresher.cancel();
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
      void rosterRefresher.refresh();
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
    void readUiHotStatus(tauriInvoke).then((status) => {
      uiVersion = status?.source === 'hot' ? status.uiVersion : null;
    });
  }

  async function retryWorkspaces(): Promise<void> {
    if (lifecycle !== 'ready') return;
    workspaceError = null;
    await rosterRefresher.refresh();
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
      rosterRefresher.cancel();
      authGeneration += 1;
      authAccountId = null;
      planLimitNotices = [];
      dismissedPlanLimitKeys.clear();
      planLimitOpenError = null;
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
      listContacts: async () => {
        const result = await adapter.messaging.listContacts();
        return result.ok
          ? (result.value as unknown as DmRequestContact[])
          : [];
      },
    });
    return () => {
      closed = true;
      void subscribed.then((unsubscribe) => unsubscribe());
    };
  });

  $effect(() => {
    // Recreate on auth-generation changes, even when the account id is reused.
    const generation = authGeneration;
    if (lifecycle !== 'ready' || !self?.uid || !generation) return;
    return untrack(() => startMeetingRecordingBridge());
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
    postReadyActionReady = isPostReadyActionReady();
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
    const unlistenPlanLimitPromise = listen<{
      company?: unknown;
      upgradeUrl?: unknown;
    }>('sync:plan-limit', (event) => {
      if (cancelled) return;
      const company =
        typeof event.payload?.company === 'string' ? event.payload.company.trim() : '';
      if (!company) {
        console.error('Sync plan-limit notice is missing its company.');
        return;
      }
      // The plan URL is server-selected. Only a link on a host hq-pro returns
      // becomes an action; the notice itself still shows without one.
      const upgradeUrl = planLimitUpgradeLink(event.payload?.upgradeUrl);
      const currentNotice = planLimitNotices.find(
        (notice) => notice.company === company && notice.upgradeUrl === upgradeUrl,
      );
      const notice: PlanLimitNotice = currentNotice
        ? { ...currentNotice, statusPush: false }
        : {
        company,
        companyUid: resolvePlanLimitCompanyUid(company),
        exposureId: `exposure:${crypto.randomUUID()}`,
        upgradeUrl,
        };
      if (dismissedPlanLimitKeys.has(planLimitKey(notice))) return;
      planLimitNotices = [
        ...planLimitNotices.filter((current) => current.company !== company),
        notice,
      ];
      planLimitOpenError = null;
    }).catch((error) => {
      console.error('Could not subscribe to sync plan-limit notices.', error);
      return () => {};
    });
    const unlistenUploadsPausedPromise = listen<{ companies?: unknown }>(
      'sync:uploads-paused',
      (event) => {
        if (!cancelled) applyUploadsPausedSnapshot(event.payload?.companies);
      },
    ).catch((error) => {
      console.error('Could not subscribe to paused-upload updates.', error);
      return () => {};
    });
    void Promise.resolve()
      .then(() => invokeFn('get_sync_status'))
      .then((status) => {
        if (cancelled || !status || typeof status !== 'object') return;
        applyUploadsPausedSnapshot((status as { uploadsPaused?: unknown }).uploadsPaused);
      })
      .catch(() => {
        // The live events still arrive; a missing journal is not an error.
      });
    // Website-created companies are provisioned by the sync runner after
    // sign-in; re-read the roster when it says so instead of after a restart.
    const unsubscribeRosterEvents = subscribeRosterRefreshEvents(listen, () => {
      if (!cancelled && lifecycle === 'ready') void rosterRefresher.refresh();
    });
    const unlistenWorkPushes = WORK_PUSH_EVENTS.map((eventName) =>
      listen(eventName, (event) => {
        if (!cancelled) dispatchWorkPush(eventName, event.payload);
      }).catch(() => () => {}),
    );

    // Native View-menu accelerators (⌘⇧]/⌘⇧[/⌘N/⌘/) are consumed by AppKit
    // before the webview sees the keydown; the menu handler emits the binding
    // id and we run it through the same registry the keyboard path uses.
    const unlistenShortcutPromise = listen<{ id?: unknown }>('shortcut:invoke', (event) => {
      if (cancelled) return;
      const id = event.payload?.id;
      if (typeof id === 'string' && id) common.runShortcut(id);
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
      unsubscribeRosterEvents();
      for (const pending of unlistenWorkPushes) {
        void pending.then((unlisten) => safeUnlisten(unlisten)());
      }
      rosterRefresher.dispose();
      detachNavigation?.();
      detachNavigation = null;
      void unlistenSetupPromise.then((unlisten) => safeUnlisten(unlisten)());
      void unlistenPromise.then((unlisten) => safeUnlisten(unlisten)());
      void unlistenMeetingFocusPromise.then((unlisten) => safeUnlisten(unlisten)());
      void unlistenAuthReadyPromise.then((unlisten) => safeUnlisten(unlisten)());
      void unlistenPlanLimitPromise.then((unlisten) => safeUnlisten(unlisten)());
      void unlistenUploadsPausedPromise.then((unlisten) => safeUnlisten(unlisten)());
      void unlistenShortcutPromise.then((unlisten) => safeUnlisten(unlisten)());
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
      window.removeEventListener('focus', revalidateOnRecovery);
      window.removeEventListener('online', revalidateOnRecovery);
      window.removeEventListener('pageshow', revalidateOnRecovery);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  });

  function dismissPlanLimitNotice(notice: PlanLimitNotice): void {
    dismissedPlanLimitKeys.add(planLimitKey(notice));
    planLimitNotices = planLimitNotices.filter(
      (current) => planLimitKey(current) !== planLimitKey(notice),
    );
  }

  function resolvePlanLimitCompanyUid(
    companyLabel: string,
    workspaces: Workspace[] | null = companies,
  ): string | null {
    const normalized = companyLabel.trim().toLowerCase();
    const scoped = (workspaces ?? []).filter((workspace) => workspace.kind === 'company');
    const slugMatches = scoped.filter((workspace) => workspace.slug.toLowerCase() === normalized);
    const matches = slugMatches.length > 0
      ? slugMatches
      : scoped.filter((workspace) => workspace.displayName.trim().toLowerCase() === normalized);
    if (matches.length !== 1) return null;
    const companyUid = matches[0].cloudUid?.trim() ?? '';
    return /^cmp_[A-Za-z0-9_-]+$/.test(companyUid) ? companyUid : null;
  }

  function resolvePendingPlanLimitNoticeCompanies(): void {
    if (!companies) return;
    planLimitNotices = planLimitNotices.map((notice) => {
      if (notice.companyUid) return notice;
      const companyUid = resolvePlanLimitCompanyUid(notice.company, companies);
      return companyUid ? { ...notice, companyUid } : notice;
    });
  }

  function trackPlanLimitNoticeExposure(
    node: HTMLElement,
    initialNotice: PlanLimitNotice,
  ) {
    let notice = initialNotice;
    let attempted = false;
    const emitWhenVisible = () => {
      if (document.visibilityState === 'visible') emitExposure();
    };
    const emitExposure = () => {
      void tick().then(() => {
        if (
          attempted ||
          !node.isConnected ||
          document.visibilityState !== 'visible' ||
          !notice.companyUid ||
          !capabilities?.fetch
        ) return;
        attempted = true;
        void emitPlanLimitPromptTelemetry({
          fetch: capabilities.fetch,
          eventName: 'plan_limit_prompt_exposed',
          companyUid: notice.companyUid,
          exposureId: notice.exposureId,
        });
      });
    };
    emitExposure();
    document.addEventListener('visibilitychange', emitWhenVisible);
    window.addEventListener('focus', emitWhenVisible);
    return {
      update(nextNotice: PlanLimitNotice) {
        notice = nextNotice;
        emitExposure();
      },
      destroy() {
        document.removeEventListener('visibilitychange', emitWhenVisible);
        window.removeEventListener('focus', emitWhenVisible);
      },
    };
  }


  function withDesktopLimitEntrySurface(value: string): string {
    const url = new URL(value);
    const callbackUrl = url.searchParams.get('callbackUrl');
    if (callbackUrl) {
      const callback = new URL(callbackUrl, url.origin);
      const callbackParts = callback.pathname.split('/').filter(Boolean);
      if (callbackParts.length === 5 && callbackParts[0] === 'api' && callbackParts[1] === 'companies' &&
        /^cmp_[A-Za-z0-9_-]+$/.test(callbackParts[2]) && callbackParts[3] === 'billing' && callbackParts[4] === 'upgrade') {
        callback.searchParams.set('entrySurface', 'desktop_limit');
        url.searchParams.set('callbackUrl', `${callback.pathname}${callback.search}${callback.hash}`);
        return url.toString();
      }
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 3 && parts[0] === 'companies' && parts[2] === 'billing') {
      url.searchParams.set('entrySurface', 'desktop_limit');
      return url.toString();
    }
    return value;
  }

  async function openPlanLimitUpgrade(url: string): Promise<void> {
    const notice = planLimitNotices.find((candidate) => candidate.upgradeUrl === url);
    if (notice?.companyUid && capabilities?.fetch) {
      void emitPlanLimitPromptTelemetry({
        fetch: capabilities.fetch,
        eventName: 'plan_limit_prompt_engaged',
        companyUid: notice.companyUid,
        exposureId: notice.exposureId,
        action: 'upgrade_clicked',
      });
    }
    try {
      await openApprovedExternalUrl(url);
      planLimitOpenError = null;
    } catch (error) {
      console.error('Could not open the sync plan upgrade page.', error);
      planLimitOpenError = 'Could not open the upgrade page. Try again.';
    }
  }
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
      <h1>
        {signedOutReason === 'expired'
          ? 'Your session expired'
          : signedOutReason === 'invalid'
            ? 'Your sign-in is no longer valid'
            : signedOutReason === 'non-human'
              ? 'These credentials belong to an agent'
              : 'You are signed out'}
      </h1>
      <p>
        {signedOutReason === 'expired'
          ? 'Sign in again to continue using HQ Work.'
          : signedOutReason === 'non-human'
            ? 'The HQ credentials saved on this device belong to a fleet agent, not to a person, so HQ Work will not open as that identity. Sign in with your own HQ account to continue.'
            : 'This device no longer has an active HQ Work session.'}
      </p>
      <div class="workspace-signin">
        <SignInPrompt
          reauth={signedOutReason === 'expired' ||
            signedOutReason === 'invalid' ||
            signedOutReason === 'non-human'}
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
      <div class="workspace-warning" data-testid="hq-work-workspace-error" role="status">
        <span>Workspaces couldn’t refresh.</span>
        <button type="button" onclick={() => void retryWorkspaces()}>Retry</button>
      </div>
    {/if}
    {#if signOutError}
      <div class="workspace-warning" data-testid="hq-work-sign-out-error" role="alert">
        <span>{signOutError}</span>
      </div>
    {/if}
    {#if planLimitNotices.length > 0}
      <div class="plan-limit-notices" data-testid="sync-plan-limit-notice" role="status">
        {#each planLimitNotices as notice (planLimitKey(notice))}
          <div class="plan-limit-notice" use:trackPlanLimitNoticeExposure={notice}>
            <span>New files are paused for {notice.company}.</span>
            {#if notice.upgradeUrl}
              <PlanUpgradeAction
                upgradeUrl={notice.upgradeUrl}
                onUpgrade={openPlanLimitUpgrade}
                testId="sync-plan-limit-upgrade"
              />
            {/if}
            <button
              type="button"
              class="plan-limit-dismiss"
              aria-label={`Dismiss upgrade notice for ${notice.company}`}
              onclick={() => dismissPlanLimitNotice(notice)}
            >
              Dismiss
            </button>
          </div>
        {/each}
        {#if planLimitOpenError}
          <p class="plan-limit-open-error" role="alert">{planLimitOpenError}</p>
        {/if}
      </div>
    {/if}
    <div class="work-shell-frame">
    {#key authGeneration}
      <WorkShell
        data={{ user: capabilities.hostIdentity }}
        runtimeKind={capabilities.runtimeKind}
        fetch={capabilities.fetch}
        onUnauthorized={capabilities.onUnauthorized}
        loadFilePreview={capabilities.loadFilePreview}
        callsHost={capabilities.calls}
        hostIdentity={capabilities.hostIdentity}
        hostTenantAccountId={authAccountId}
        hostTenantGeneration={authGeneration}
        invoke={invokeFn}
        {listen}
        {wakes}
        {version}
        {updateWakeSeq}
        refreshAppVersion={getVersion}
        {uiVersion}
        {packagesEvents}
        onOpenConsole={openApprovedExternalUrl}
        onopenurl={openBrowserUrl}
        {notificationWakeSeq}
        onactivethreadchange={setActiveReplyThread}
        {extraPages}
        {postReadyActionReady}
        {setupInstallGuide}
        aiTools={installChoiceAiTools}
        onrequestaitools={requestInstallChoiceAiTools}
        onopenassistant={setupInstallGuide.onopenassistant}
        onassistedinstall={async (tool) => {
          const outcome = await setupInstallGuide.oninstall(tool);
          if (outcome.ok) await refreshInstallChoiceAiTools();
          return outcome;
        }}
        bootTimeoutMs={bootTimeoutMs}
        onShellReady={() => {
          void invokeFn('shell_ready');
        }}
        onembeddednavigationready={() => {
          detachNavigation?.();
          // Pending-route bridge only: the shared shell converts `target`
          // through destinationFromEmbeddedTarget and commits via navigate().
          const detach = navigation.attach((target) => {
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
    /* The document owns WebKit's viewport scrolling. Clipping only the
       embedded shell leaves native rubber-banding free to move all chrome. */
    overflow: hidden;
    overscroll-behavior: none;
  }

  .hq-work-embedded {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  /* No window backing here. The shell's own ground (`--v4-ground` on
     .desktop-shell) is the single layer that scales with the Appearance
     window-opacity setting. A second full-window fill at this level (PR #772's
     staged backing, alpha floor .72/.78) stacked under that ground and made
     the window read as solid at every slider value. */
  .hq-work-embedded {
    background: transparent;
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

  .lifecycle-state > button {
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
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    box-sizing: border-box;
    padding: 3px 10px;
    border-bottom: 1px solid var(--v4-hairline, #414141);
    font-family: var(--font-sans, system-ui, sans-serif);
    font-size: 13px;
    line-height: 1.4;
    color: var(--v4-text-2, #b0b0b0);
    background: var(--v4-surface-solid, #282828);
  }

  .plan-limit-notices {
    flex: 0 0 auto;
    display: grid;
    gap: 4px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--v4-divider, var(--c-divider));
    color: var(--v4-text-1, var(--c-text, currentColor));
    font-size: 13px;
    line-height: 18px;
  }

  .plan-limit-notice {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .plan-limit-dismiss {
    border: 0;
    padding: 4px 6px;
    background: transparent;
    color: var(--v4-text-2, var(--c-muted, currentColor));
    font: inherit;
    cursor: pointer;
    text-decoration: underline;
  }

  .plan-limit-open-error {
    margin: 0;
    color: var(--v4-warn, #b45309);
  }

  .work-shell-frame {
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }

  .workspace-warning button {
    flex-shrink: 0;
    padding: 4px 6px;
    border: 0;
    border-radius: 4px;
    font: inherit;
    color: var(--v4-text-1, #ededed);
    background: transparent;
    cursor: pointer;
  }

  .workspace-warning button:hover {
    background: var(--c-hover, rgb(128 128 128 / 15%));
  }

  .workspace-warning button:focus-visible {
    outline: 2px solid var(--v4-text-1, #ededed);
    outline-offset: 2px;
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
