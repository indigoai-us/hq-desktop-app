<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { safeUnlisten } from '../../lib/listener-registry';
  import { open as openExternal } from '@tauri-apps/plugin-shell';
  import { onDestroy, onMount, tick } from 'svelte';
  import onboardingBg from '../../assets/onboarding/onboarding-bg.jpg';
  import folderIcon from '../../assets/onboarding/folder-icon.png';
  import '../../styles/design-system.css';
  import { buildClaudeCodeUrl } from '../../lib/claude-code-link';
  import { friendlyPath, homeDirFromDefaultHqPath } from '../../lib/onboarding-path';
  import { mapSignInError, type SignInProvider } from '../../lib/onboarding-signin';
  import {
    NO_AI_TOOLS,
    markToolUnavailable,
    readyCommandFor,
    selectPrimaryLaunch,
    type AiTools,
    type PrimaryLaunch,
  } from '../../lib/onboarding-summary';
  import {
    allSettled,
    buildInitialStages,
    buildStagesFromManifest,
    friendlySetupBands,
    resumeStartStageFromManifest,
    setStageStatus,
    setupCompletionResult,
    setupProgressPercent,
    setupStageRecoveryAction,
    stageCommandInvocations,
    stageTimeoutMs,
    StageTimeoutError,
    STAGE_ORDER,
    withTimeout,
    type FailedStageDetail,
    type InstallManifest,
    type StageId,
    type StageState,
  } from '../../lib/onboarding-setup';
  import { postOptIn, markConsentRepromptShown } from '../../lib/onboarding-telemetry';
  import { emitDesktopTelemetry } from '../../lib/desktop-telemetry';
  import {
    CONSENT_STEP_INDEX,
    createWizardRouter,
    markSetupStepCompleted,
    WIZARD_STEPS,
  } from '../../lib/onboarding-wizard';
  import { TELEMETRY_CONSENT_VERSION } from '../../lib/consent-version';

  interface Props {
    initialStep: number;
    onfinish?: () => void | Promise<void>;
    /**
     * `'onboarding'` (default) is the full first-run wizard. `'reprompt'` is the
     * US-005 launch-time re-ask for a person whose recorded consent is stale,
     * administrative, or pre-versioned: it shows ONLY the consent step, reusing
     * the exact same blocking, unbiased UI and awaited write as onboarding, and
     * finishes (via `onfinish`) the moment the answer is confirmed — there is no
     * setup and no ready screen. The `personUid` the guard is keyed to is passed
     * so the answer can mark the re-prompt "shown" for exactly this person.
     */
    mode?: 'onboarding' | 'reprompt';
    /** The `prs_*` the re-prompt is keyed to (reprompt mode only). */
    repromptPersonUid?: string | null;
  }

  interface DetectHqResult {
    exists?: boolean;
    looksLikeHq?: boolean;
    looks_like_hq?: boolean;
    isHq?: boolean;
    is_hq?: boolean;
    nonEmpty?: boolean;
    non_empty?: boolean;
  }

  type Notice = {
    tone: 'error' | 'warning';
    text: string;
  };

  type InstallProgressPayload = {
    handle?: string;
    finished?: boolean;
  };

  type ContentProgressPayload = {
    handle?: string;
    phase?: 'download' | 'extract' | 'complete';
    receivedBytes?: number | null;
    totalBytes?: number | null;
    percent?: number | null;
    slow?: boolean;
    stalled?: boolean;
    message?: string;
  };
  type ClaudeReady = {
    installed: boolean;
    desktop_installed: boolean;
    logged_in: boolean;
  };

  const RING_CIRCUMFERENCE = 2 * Math.PI * 52;
  const FADE_OUT_MS = 320;
  const CLAUDE_WATCH_MAX_CONSECUTIVE_FAILURES = 3;
  const CLAUDE_DESKTOP_READY_FALLBACK_MS = 30_000;
  const DEFAULT_STEP = WIZARD_STEPS[0].index;
  const READY_STEP_INDEX =
    WIZARD_STEPS.find((step) => step.id === 'ready')?.index ?? 4;

  let {
    initialStep,
    onfinish,
    mode = 'onboarding',
    repromptPersonUid = null,
  }: Props = $props();

  const isReprompt = $derived(mode === 'reprompt');

  let activeInitialStep = $state<number | null>(null);
  let router = $state(createWizardRouter());
  let currentStep = $state(DEFAULT_STEP);
  let panelStep = $state(DEFAULT_STEP);
  let graphicStep = $state(DEFAULT_STEP);
  let furthestStep = $state(DEFAULT_STEP);
  let panelOn = $state(true);
  let graphicOn = $state(true);
  let outgoingGraphicStep = $state<number | null>(null);
  let outgoingGraphicDirection = $state<'left' | 'right' | null>(null);
  let incomingGraphicDirection = $state<'left' | 'right' | null>(null);
  let reducedMotion = $state(false);
  let morphMode = $state<'forward' | 'back' | null>(null);
  let transitionToken = 0;
  const transitionTimers = new Set<number>();

  let logoEl: HTMLDivElement | null = null;
  let folderLargeEl: HTMLImageElement | null = null;
  let folderLabelEl: HTMLSpanElement | null = null;

  // The telemetry consent answer is a genuine tri-state: `null` means the
  // person has NOT answered yet. No option is pre-selected, so the consent
  // step's continue action stays disabled until they choose. (It used to be a
  // pre-ticked boolean on the sign-in panel, which biased the choice AND posted
  // the answer before the person entity existed — so the write 404'd and the
  // answer was dropped. Consent is now its own step after setup.)
  let telemetryChoice = $state<'share' | 'decline' | null>(null);
  let consentSubmitting = $state(false);
  let privacyOpening = $state(false);
  let privacyOpenError = $state(false);
  // The outcome of the last consent attempt. `null` while unattempted or after
  // a clean success. When the remote write fails we DO NOT advance — we surface
  // this so the person sees a retry (server error) or an honest "saved on this
  // machine, will send when you reconnect" (offline) instead of the failure
  // being swallowed to the console.
  type ConsentFailure = { kind: 'server' | 'offline'; message: string };
  let consentFailure = $state<ConsentFailure | null>(null);
  let loadingProvider = $state<SignInProvider | null>(null);
  let signInError = $state('');
  let currentSignInCall = 0;
  let mounted = true;

  let installPath = $state<string | null>(null);
  let resolvedPath = $state<string | null>(null);
  let homeDir = $state<string | null>(null);
  let directoryNotice = $state<Notice | null>(null);
  let directoryBusy = $state(false);
  let directoryCancelled = false;

  let stages = $state<StageState[]>(buildInitialStages());
  let setupCompleted = $state(false);
  let setupStarted = $state(false);
  let stageCreep = $state(0);
  let effectiveInstallPath = $state<string | null>(null);
  let currentRunId = 0;
  let setupCancelled = false;
  let unlistenInstallProgress: UnlistenFn | null = null;
  let unlistenContentProgress: UnlistenFn | null = null;
  let setupFailures = $state<FailedStageDetail[]>([]);
  const activeInstallHandles = new Set<string>();
  const activeContentHandles = new Set<string>();

  let aiTools = $state<AiTools | null>(null);
  let detectionFailed = $state(false);
  let probeInFlight = false;
  let detectorMounted = false;
  let launching = $state<
    'claude' | 'codex' | 'grok' | 'download' | 'watching' | null
  >(null);
  let claudeWatchInterval: number | null = null;
  let claudeWatchStartedAt = 0;
  let claudeWatchConsecutiveFailures = 0;
  let claudeWatchExpired = $state(false);
  let launchError = $state<string | null>(null);
  let revealError = $state<string | null>(null);
  let showManualTools = $state(false);
  let revealingFolder = $state(false);
  let commandCopied = $state(false);
  let pathCopied = $state(false);
  let importPromptCopied = $state(false);
  type CopyAction = 'path' | 'command' | 'import';
  let copyingAction = $state<CopyAction | null>(null);
  let copyFailure = $state<CopyAction | null>(null);
  let finishing = $state(false);
  let finishError = $state(false);

  const displayPath = $derived(
    resolvedPath ? friendlyPath(resolvedPath, homeDir) : 'Resolving ~/hq...',
  );
  const installDisplayPath = $derived(
    installPath ? friendlyPath(installPath, homeDirFromDefaultHqPath(installPath)) : '~/hq',
  );
  const directoryButtonLabel = $derived(directoryBusy ? 'Checking…' : 'Choose…');
  const topHeight = $derived(currentStep >= 5 ? '240px' : '200px');
  const settledCount = $derived(
    stages.filter((stage) => stage.status === 'ok' || stage.status === 'failed')
      .length,
  );
  const currentStageId = $derived(
    stages.find((stage) => stage.status === 'running')?.id ?? null,
  );
  const setupDone = $derived(allSettled(stages));
  const overallPercent = $derived(
    setupProgressPercent({
      settledCount,
      totalStages: STAGE_ORDER.length,
      hasRunningStage: currentStageId !== null,
      stageCreep,
      allDone: setupDone,
    }),
  );
  const ringOffset = $derived(
    RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(100, overallPercent)) / 100),
  );
  const setupBands = $derived(friendlySetupBands(overallPercent));
  const needsAttention = $derived(setupFailures.length > 0);
  const manualCommand = $derived(readyCommandFor(installPath, aiTools));
  const primaryLaunch = $derived<PrimaryLaunch>(selectPrimaryLaunch(aiTools));
  const manualToolsVisible = $derived(
    showManualTools || Boolean(launchError || revealError || detectionFailed),
  );

  $effect(() => {
    if (activeInitialStep === initialStep) return;
    activeInitialStep = initialStep;
    router = createWizardRouter({ start: initialStep });
    currentStep = router.currentStep;
    panelStep = router.currentStep;
    graphicStep = router.currentStep;
    furthestStep = Math.max(furthestStep, router.currentStep);
    panelOn = true;
    graphicOn = true;
  });

  $effect(() => {
    if (installPath) effectiveInstallPath = installPath;
  });

  $effect(() => {
    // In re-prompt mode there is no install/setup — only the consent step — so
    // the setup run must never start even if the step index momentarily reads 2.
    if (isReprompt || currentStep !== 2 || setupStarted) return;
    setupStarted = true;
    void startSetupRun();
  });

  $effect(() => {
    if (aiTools?.any !== false || currentStep < 4) return;
    const intervalId = window.setInterval(() => {
      void probeAiTools();
    }, 3000);
    return () => window.clearInterval(intervalId);
  });

  $effect(() => {
    const activeId = currentStageId;
    const done = setupDone;
    let creep = 0;
    stageCreep = creep;

    if (done || activeId === null) return;

    const interval = window.setInterval(() => {
      creep += (0.92 - creep) * 0.14;
      stageCreep = creep;
    }, 1200);

    return () => {
      window.clearInterval(interval);
    };
  });

  onMount(() => {
    mounted = true;
    detectorMounted = true;
    directoryCancelled = false;

    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => {
      reducedMotion = media.matches;
    };
    updateMotion();
    media.addEventListener('change', updateMotion);

    void resolveDefaultPath();
    void probeAiTools();

    return () => {
      mounted = false;
      detectorMounted = false;
      directoryCancelled = true;
      media.removeEventListener('change', updateMotion);
    };
  });

  onDestroy(() => {
    mounted = false;
    currentSignInCall += 1;
    clearTransitionTimers();
    stopClaudeWatch();
    cancelSetupRun();
  });

  function setTransitionTimer(callback: () => void, ms: number): number {
    const timer = window.setTimeout(() => {
      transitionTimers.delete(timer);
      callback();
    }, ms);
    transitionTimers.add(timer);
    return timer;
  }

  function clearTransitionTimers() {
    for (const timer of transitionTimers) {
      window.clearTimeout(timer);
    }
    transitionTimers.clear();
  }

  function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }

  async function invokeCommand<T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> {
    if (typeof invoke !== 'function') {
      throw new Error('The desktop bridge is not available in this environment.');
    }
    return invoke<T>(command, args);
  }

  function isCurrentSignInCall(call: number): boolean {
    return mounted && call === currentSignInCall;
  }

  async function refocusWindow(): Promise<void> {
    try {
      // macOS/Windows ignore JS setFocus after browser OAuth; Rust raises via
      // AppKit activateIgnoringOtherApps / Win32 SetForegroundWindow.
      await invokeCommand('bring_main_window_to_front');
    } catch (err) {
      console.warn('[onboarding-signin] failed to refocus window:', err);
    }
  }

  async function handleOpenPrivacy(): Promise<void> {
    if (privacyOpening) return;
    privacyOpening = true;
    privacyOpenError = false;
    try {
      await openExternal('https://hq.computer/privacy');
    } catch (err) {
      console.error('onboarding: privacy page failed to open', err);
      privacyOpenError = true;
    } finally {
      privacyOpening = false;
    }
  }

  async function handleSignIn(provider: SignInProvider) {
    const call = ++currentSignInCall;
    loadingProvider = provider;
    signInError = '';

    try {
      const { authorizeUrl, state } = await invokeCommand<{
        authorizeUrl: string;
        state: string;
      }>('start_oauth_login', { provider });
      if (!isCurrentSignInCall(call)) return;

      if (typeof openExternal !== 'function') {
        throw new Error('The desktop shell cannot open a browser in this environment.');
      }
      await openExternal(authorizeUrl);
      if (!isCurrentSignInCall(call)) return;

      const { code } = await invokeCommand<{ code: string }>(
        'oauth_listen_for_code',
        { state },
      );
      if (!isCurrentSignInCall(call)) return;

      const result = await invokeCommand<{
        authenticated: boolean;
        expiresAt?: string;
      }>('oauth_exchange_code', { code });
      if (!isCurrentSignInCall(call)) return;

      if (result.authenticated) {
        await refocusWindow();
        if (!isCurrentSignInCall(call)) return;
        // No telemetry is written here. The consent question is asked later, as
        // its own step after setup — before an answer exists we must not opt the
        // person in NOR emit any usage event (a person who later declines must
        // have produced zero events).
        advanceTo(1);
      } else {
        signInError = 'Authentication failed. Please try again.';
      }
    } catch (err) {
      if (!isCurrentSignInCall(call)) return;
      console.error('[onboarding-signin] sign-in failed:', err);
      signInError = mapSignInError(errorMessage(err), provider);
    } finally {
      if (isCurrentSignInCall(call)) {
        loadingProvider = null;
      }
    }
  }

  function detectLooksLikeHq(result: DetectHqResult): boolean {
    return Boolean(result.looksLikeHq ?? result.looks_like_hq ?? result.isHq ?? result.is_hq);
  }

  function detectNonEmpty(result: DetectHqResult): boolean {
    return Boolean(result.nonEmpty ?? result.non_empty);
  }

  function acceptPath(path: string) {
    resolvedPath = path;
    homeDir = homeDir ?? homeDirFromDefaultHqPath(path);
    directoryNotice = null;
    installPath = path;
    if (typeof invoke === 'function') {
      void invoke('set_hq_install_path', { path }).catch(() => {});
    }
  }

  function rejectPath(text: string, tone: Notice['tone'] = 'error') {
    directoryNotice = { tone, text };
  }

  async function resolveDefaultPath() {
    directoryBusy = true;
    directoryNotice = null;
    try {
      const path = await invokeCommand<string>('resolve_hq_path');
      if (directoryCancelled) return;
      homeDir = homeDirFromDefaultHqPath(path);
      acceptPath(path);
    } catch (err) {
      if (directoryCancelled) return;
      resolvedPath = null;
      installPath = null;
      rejectPath(`HQ could not prepare ~/hq. ${errorMessage(err)}`);
    } finally {
      if (!directoryCancelled) directoryBusy = false;
    }
  }

  async function chooseFolder() {
    directoryBusy = true;
    directoryNotice = null;

    try {
      const picked = await invokeCommand<string | null>('pick_folder');
      if (!picked) return;

      const [detection, writable] = await Promise.all([
        invokeCommand<DetectHqResult>('detect_hq', { path: picked }),
        invokeCommand<boolean>('check_writable', { path: picked }),
      ]);

      if (!writable) {
        rejectPath(`${friendlyPath(picked, homeDir)} is not writable. Choose another folder.`);
        return;
      }

      if (detection.exists && !detectLooksLikeHq(detection) && detectNonEmpty(detection)) {
        rejectPath(
          `${friendlyPath(picked, homeDir)} already has files and does not look like an HQ folder.`,
          'warning',
        );
        return;
      }

      acceptPath(picked);
    } catch (err) {
      rejectPath(`The folder could not be checked. ${errorMessage(err)}`);
    } finally {
      directoryBusy = false;
    }
  }

  function handleInstall() {
    if (!installPath || directoryBusy) return;
    advanceTo(2);
  }

  function beginSetupRun(): number {
    currentRunId += 1;
    setupCancelled = false;
    activeInstallHandles.clear();
    activeContentHandles.clear();
    return currentRunId;
  }

  function isCurrentRun(runId: number): boolean {
    return runId === currentRunId && !setupCancelled;
  }

  async function cancelActiveInstallHandles(runId: number): Promise<void> {
    if (runId !== currentRunId) return;
    const handles = [...activeInstallHandles];
    activeInstallHandles.clear();
    await Promise.allSettled(
      handles.map((handle) => invoke('cancel_install', { handle })),
    );
  }

  async function cancelActiveContentHandles(runId: number): Promise<void> {
    if (runId !== currentRunId) return;
    const handles = [...activeContentHandles];
    activeContentHandles.clear();
    await Promise.allSettled(
      handles.map((handle) => invoke('cancel_content_download', { handle })),
    );
  }

  async function cancelForegroundWork(runId: number): Promise<void> {
    await Promise.allSettled([
      cancelActiveInstallHandles(runId),
      cancelActiveContentHandles(runId),
    ]);
  }

  function trackInstallProgress(runId: number, payload: InstallProgressPayload): void {
    if (!isCurrentRun(runId)) return;
    const handle = payload.handle;
    if (!handle || handle === 'preflight') return;

    if (payload.finished) {
      activeInstallHandles.delete(handle);
      return;
    }
    activeInstallHandles.add(handle);
  }

  function trackContentProgress(runId: number, payload: ContentProgressPayload): void {
    if (!isCurrentRun(runId)) return;
    const handle = payload.handle;
    if (
      handle &&
      activeContentHandles.size > 0 &&
      !activeContentHandles.has(handle)
    ) {
      return;
    }

    if (handle && payload.phase === 'complete') {
      activeContentHandles.delete(handle);
    }
  }

  async function listenForProgress(runId: number): Promise<void> {
    const unlisten = safeUnlisten(await listen<InstallProgressPayload>(
      'install:progress',
      (event) => trackInstallProgress(runId, event.payload),
    ));
    if (!isCurrentRun(runId)) {
      unlisten();
      return;
    }
    unlistenInstallProgress = unlisten;

    const unlistenContent = safeUnlisten(await listen<ContentProgressPayload>(
      'content:progress',
      (event) => trackContentProgress(runId, event.payload),
    ));
    if (!isCurrentRun(runId)) {
      unlistenContent();
      return;
    }
    unlistenContentProgress = unlistenContent;
  }

  function invokeDesktopCommand(command: string, args?: Record<string, unknown>) {
    return args === undefined ? invoke(command) : invoke(command, args);
  }

  function contentHandle(runId: number): string {
    return `content-${runId}-${Date.now().toString(36)}`;
  }

  async function journalStageStart(id: StageId): Promise<void> {
    try {
      await invoke('record_step_start', { stepId: id });
    } catch {
      // Resume journaling is best-effort; setup itself remains authoritative.
    }
  }

  async function journalStageOk(id: StageId): Promise<void> {
    try {
      await invoke('record_step_ok', { stepId: id });
    } catch {
      // non-fatal
    }
  }

  async function journalStageFailure(id: StageId, message: string): Promise<void> {
    try {
      await invoke('record_step_failure', { stepId: id, error: message });
    } catch {
      // non-fatal
    }
  }

  async function journalInstallComplete(): Promise<void> {
    try {
      await invoke('record_install_complete');
    } catch {
      // non-fatal
    }
  }

  async function invokeStageCommand(id: StageId, runId: number): Promise<void> {
    const invocations = stageCommandInvocations(id, { installPath: effectiveInstallPath });
    if (invocations.length === 0) return;
    if (typeof invoke !== 'function') {
      throw new Error('The desktop bridge is not available in this environment.');
    }

    const ms = stageTimeoutMs(id);
    for (const invocation of invocations) {
      let args = invocation.args;
      let handle: string | null = null;
      if (invocation.command === 'fetch_and_extract_template') {
        handle = contentHandle(runId);
        activeContentHandles.add(handle);
        args = { ...args, handle };
      }
      try {
        await withTimeout(
          Promise.resolve(invokeDesktopCommand(invocation.command, args)),
          ms,
          () => new StageTimeoutError(id, ms),
          () => {
            void cancelForegroundWork(runId);
          },
        );
      } catch (err) {
        if (invocation.required) throw err;
      } finally {
        if (handle) {
          activeContentHandles.delete(handle);
        }
      }
    }
  }

  type StageRunOutcome = 'ok' | 'failed' | 'cancelled';

  async function runStage(id: StageId, runId: number): Promise<StageRunOutcome> {
    if (!isCurrentRun(runId)) return 'cancelled';
    stages = setStageStatus(stages, id, 'running');
    await journalStageStart(id);

    const result = await invokeStageCommand(id, runId).then(
      () => ({ kind: 'done' as const }),
      (err) => ({ kind: 'failed' as const, err }),
    );

    if (!isCurrentRun(runId)) return 'cancelled';

    if (result.kind === 'done') {
      stages = setStageStatus(stages, id, 'ok');
      await journalStageOk(id);
      return 'ok';
    }
    if (result.kind === 'failed') {
      const message = errorMessage(result.err);
      stages = setStageStatus(stages, id, 'failed', message);
      await journalStageFailure(id, message);
      return 'failed';
    }
    return 'cancelled';
  }

  function stageFailureMessage(id: StageId): string {
    return (
      stages.find((stage) => stage.id === id)?.error?.trim() ||
      'Stage failed with no detail recorded.'
    );
  }

  function waitForAutoRetry(ms: number): Promise<void> {
    if (!(ms > 0)) return Promise.resolve();
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  async function runSetup(runId: number, startStage: StageId = STAGE_ORDER[0]) {
    const startIndex = Math.max(0, STAGE_ORDER.indexOf(startStage));
    const retryCounts = new Map<StageId, number>();
    for (const id of STAGE_ORDER.slice(startIndex)) {
      if (!isCurrentRun(runId)) return;
      while (isCurrentRun(runId)) {
        const outcome = await runStage(id, runId);
        if (outcome === 'cancelled') return;
        if (outcome === 'ok') break;

        const action = setupStageRecoveryAction({
          stageId: id,
          message: stageFailureMessage(id),
          retryCount: retryCounts.get(id) ?? 0,
        });
        if (action.kind !== 'retry') break;

        retryCounts.set(id, action.nextRetryCount);
        stages = setStageStatus(stages, id, 'pending');
        await waitForAutoRetry(action.delayMs);
      }
    }

    if (isCurrentRun(runId) && !setupCompleted && allSettled(stages)) {
      setupCompleted = true;
      const result = setupCompletionResult(stages);
      setupFailures = result.failedStages;
      markSetupStepCompleted();
      await journalInstallComplete();
      // Capture the setup metrics now, but DON'T emit the completion event yet:
      // consent hasn't been asked. The event is emitted from the consent step,
      // and only when the person opts in — a decline must produce no events.
      setupCompletionMetrics = {
        stageCount: stages.length,
        failedStageCount: setupFailures.length,
        detectedToolCount: aiTools
          ? [
              aiTools.claude_cli,
              aiTools.claude_desktop,
              aiTools.codex_cli,
              aiTools.codex_desktop,
              aiTools.grok_cli,
            ].filter(Boolean).length
          : 0,
      };
      // Advance to the consent step (index 3), which now sits between setup and
      // the ready screen.
      advanceTo(CONSENT_STEP_INDEX);
    }
  }

  interface SetupCompletionMetrics {
    stageCount: number;
    failedStageCount: number;
    detectedToolCount: number;
  }
  let setupCompletionMetrics = $state<SetupCompletionMetrics | null>(null);

  /**
   * A best-effort guess at whether an upload failure is "you are offline"
   * versus "the server errored". Offline steers the user toward finishing setup
   * now (the answer is cached and reconciled later); a server error steers them
   * toward Retry. The classes only change the copy — either way we never report
   * a failed write as a success.
   */
  function looksOffline(message: string): boolean {
    return /offline|network|connection|unreachable|timed out|timeout|dns|failed to connect|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(
      message,
    );
  }

  /**
   * Record the telemetry answer and, only when the SERVER confirms the write,
   * leave the consent step for the ready screen. Called from either option's
   * Continue. Declining is first-class: it records the answer, emits nothing,
   * withholds nothing, and finishes setup exactly like sharing does.
   *
   * US-002: the remote write is foreground and its failure is visible.
   *   - AC1: the caller's person entity is guaranteed to exist first, so the
   *     POST cannot 404 into the void. Setup provisions it, but that runs in the
   *     background, so we await it here rather than trusting step ordering.
   *   - AC2/AC3: a failed remote write does NOT advance; it surfaces a retry.
   *   - AC4: an OFFLINE person can still finish — the answer is already cached
   *     with provenance and reconciled by the consent repair on reconnect. We
   *     say so honestly and never call it a successful server write.
   */
  async function submitConsent(): Promise<void> {
    if (telemetryChoice === null || consentSubmitting) return;
    consentSubmitting = true;
    consentFailure = null;
    const enabled = telemetryChoice === 'share';
    try {
      // AC1 — make the ordering explicit. Ensure the person entity exists
      // before the opt-in POST fires. This resolves from cache instantly on the
      // common path; only a fresh install with in-flight provisioning waits.
      // In re-prompt mode the entity already exists (the person has been running
      // HQ), so this is a fast confirmation, not a bootstrap.
      try {
        await invokeCommand<boolean>('ensure_person_entity');
      } catch (err) {
        // Could not confirm the entity (no token / vault unreachable). Fall
        // through to postOptIn: the local cache still records the answer, and
        // the failure surfaces below just like an upload failure.
        console.warn('[onboarding-consent] ensure_person_entity failed:', err);
      }

      // Provenance travels with the answer so the server can tell a genuine
      // onboarding answer from an administrative backfill and re-ask when the
      // wording changes. surface=onboarding + the current version, and NEVER
      // onlyIfUnset — a re-prompt DELIBERATELY replaces the stale record, so the
      // write must be unconditional (US-005).
      const result = await postOptIn({
        enabled,
        surface: 'onboarding',
        consentVersion: TELEMETRY_CONSENT_VERSION,
      });

      if (!result.uploaded) {
        // Do not advance on a failed remote write — that is exactly the
        // swallowed-failure US-002 forbids. Show the person what happened.
        //
        // Finding #5: "finish offline" is only honest when the answer is safely
        // CACHED — that cached record is what the consent repair reconciles
        // later. If the LOCAL write ALSO failed (`cached === false`), there is no
        // answer to reconcile, so offering the offline path would let the person
        // complete setup with their choice lost entirely. In that case force the
        // retry-only "server" affordance regardless of whether it looks offline.
        const message = result.error ?? 'The server did not confirm your choice.';
        const offlineButCached = result.cached && looksOffline(message);
        consentFailure = {
          kind: offlineButCached ? 'offline' : 'server',
          message,
        };
        return;
      }

      if (isReprompt) {
        // The stale record is now replaced with a fully versioned one. Record
        // that the re-prompt was answered for this person+version (idempotent
        // with the dismissal guard) and close — there is no ready screen.
        if (repromptPersonUid) {
          await markConsentRepromptShown(TELEMETRY_CONSENT_VERSION, repromptPersonUid);
        }
        await finishWithRecovery();
        return;
      }

      if (enabled && setupCompletionMetrics) {
        void emitDesktopTelemetry({
          eventName: 'desktop_setup_completed',
          properties: { ...setupCompletionMetrics },
        });
      }
      advanceTo(READY_STEP_INDEX);
    } finally {
      consentSubmitting = false;
    }
  }

  /**
   * US-005: dismiss the re-prompt WITHOUT answering. This marks the prompt
   * "shown" for this person+version so it is not shown again this version — but
   * it posts NOTHING, so a dismissal never counts as an answer and the record
   * stays stale (the person keeps collecting under the previous default until
   * they actually answer). Reprompt mode only.
   */
  async function dismissReprompt(): Promise<void> {
    if (consentSubmitting || finishing) return;
    if (repromptPersonUid) {
      await markConsentRepromptShown(TELEMETRY_CONSENT_VERSION, repromptPersonUid);
    }
    await finishWithRecovery();
  }

  /**
   * AC4 — an offline person is not trapped. Their answer is already cached with
   * provenance; the consent repair reconciles it on the next successful
   * connection. Finishing here is honest: it does NOT emit the completion event
   * (the server never confirmed the write) and does NOT claim the upload
   * succeeded — it just stops blocking setup on a connection the person doesn't
   * have.
   */
  async function finishOffline(): Promise<void> {
    if (consentSubmitting || finishing) return;
    if (isReprompt) {
      // Reprompt has no ready screen. The answer is cached with provenance and
      // reconciled by the consent repair on reconnect; mark the prompt shown so
      // it does not nag again this version, then close.
      if (repromptPersonUid) {
        await markConsentRepromptShown(TELEMETRY_CONSENT_VERSION, repromptPersonUid);
      }
      await finishWithRecovery();
      return;
    }
    advanceTo(READY_STEP_INDEX);
  }

  async function startSetupRun() {
    const runId = beginSetupRun();
    if (installPath) effectiveInstallPath = installPath;
    await listenForProgress(runId);
    let startStage: StageId = STAGE_ORDER[0];
    try {
      const manifest = await invoke<InstallManifest>('read_install_manifest');
      effectiveInstallPath = manifest.installPath || effectiveInstallPath;
      if (manifest.installPath) installPath = manifest.installPath;
      startStage = resumeStartStageFromManifest(manifest);
      stages = buildStagesFromManifest(manifest, startStage);
    } catch {
      // Missing/corrupt manifests fall back to a fresh run.
    }
    if (!isCurrentRun(runId)) return;
    await runSetup(runId, startStage);
  }

  function cancelSetupRun() {
    setupCancelled = true;
    unlistenInstallProgress?.();
    unlistenInstallProgress = null;
    unlistenContentProgress?.();
    unlistenContentProgress = null;
    void cancelForegroundWork(currentRunId);
  }

  async function probeAiTools() {
    if (probeInFlight) return;
    probeInFlight = true;
    try {
      const tools = await invoke<AiTools>('detect_ai_tools');
      if (detectorMounted) {
        detectionFailed = false;
        aiTools = tools;
      }
    } catch {
      if (detectorMounted) {
        detectionFailed = true;
        aiTools = NO_AI_TOOLS;
      }
    } finally {
      probeInFlight = false;
    }
  }

  async function ensureAiTools(): Promise<AiTools> {
    if (aiTools) return aiTools;
    await probeAiTools();
    return aiTools ?? NO_AI_TOOLS;
  }

  async function copyText(text: string, setCopied: (value: boolean) => void) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  async function runCopyAction(
    action: CopyAction,
    text: string,
    setCopied: (value: boolean) => void,
  ) {
    if (copyingAction) return;
    copyFailure = null;
    copyingAction = action;
    try {
      await copyText(text, setCopied);
    } catch (err) {
      console.error(`onboarding: copy ${action} failed`, err);
      copyFailure = action;
    } finally {
      copyingAction = null;
    }
  }

  async function handleCopyCommand() {
    await runCopyAction('command', manualCommand, (value) => (commandCopied = value));
  }

  async function handleCopyPath() {
    await runCopyAction('path', installPath ?? '~/hq', (value) => (pathCopied = value));
  }

  async function handleCopyImportPrompt() {
    await runCopyAction('import', '/import-claude', (value) => (importPromptCopied = value));
  }

  async function retryCopyAction() {
    if (copyFailure === 'path') {
      await handleCopyPath();
    } else if (copyFailure === 'command') {
      await handleCopyCommand();
    } else if (copyFailure === 'import') {
      await handleCopyImportPrompt();
    }
  }

  async function finishWithRecovery(): Promise<boolean> {
    if (finishing) return false;
    finishing = true;
    finishError = false;
    try {
      await onfinish?.();
      return true;
    } catch (err) {
      console.error('onboarding: finish failed', err);
      finishError = true;
      return false;
    } finally {
      finishing = false;
    }
  }

  async function handleFinish(): Promise<void> {
    await finishWithRecovery();
  }

  async function handleRevealFolder() {
    launchError = null;
    revealError = null;
    revealingFolder = true;
    try {
      await invoke('reveal_folder', { path: installPath ?? '~/hq' });
    } catch (err) {
      revealError = `Could not reveal HQ folder: ${errorMessage(err)}`;
      showManualTools = true;
    } finally {
      revealingFolder = false;
    }
  }

  async function handleLaunchClaudeCode() {
    launchError = null;
    revealError = null;
    launching = 'claude';
    let launched = false;
    try {
      const tools = await ensureAiTools();
      if (tools.claude_desktop) {
        const url = buildClaudeCodeUrl({
          folder: installPath ?? '',
          prompt: '/setup',
        });
        await invoke('open_claude_code_link', { url });
        launched = true;
      } else if (tools.claude_cli && installPath) {
        await invoke('launch_claude_code', { path: installPath });
        launched = true;
      } else {
        launchError =
          'Claude Code was not detected. Use the folder and /setup prompt shown here.';
        showManualTools = true;
      }
    } catch (err) {
      const msg = errorMessage(err);
      launchError = `Could not open Claude Code: ${msg}`;
      showManualTools = true;
      if (/Unable to find application|not installed|not found|missing/i.test(msg)) {
        aiTools = markToolUnavailable(aiTools, 'claude_desktop');
      }
    } finally {
      launching = null;
    }
    if (launched) await finishWithRecovery();
  }

  async function handleLaunchCodex() {
    launchError = null;
    revealError = null;
    launching = 'codex';
    let launched = false;
    try {
      const tools = await ensureAiTools();
      if (tools.codex_cli && installPath) {
        await invoke('launch_cli_in_terminal', {
          path: installPath,
          tool: 'codex',
        });
        launched = true;
      } else {
        launchError =
          'Codex CLI was not detected. Open this HQ folder manually from Codex.';
        showManualTools = true;
      }
    } catch (err) {
      const msg = errorMessage(err);
      launchError = `Could not open Codex: ${msg}`;
      showManualTools = true;
      aiTools = markToolUnavailable(aiTools, 'codex_cli');
    } finally {
      launching = null;
    }
    if (launched) await finishWithRecovery();
  }

  async function handleLaunchGrok() {
    launchError = null;
    revealError = null;
    launching = 'grok';
    let launched = false;
    try {
      const tools = await ensureAiTools();
      if (tools.grok_cli && installPath) {
        await invoke('launch_cli_in_terminal', {
          path: installPath,
          tool: 'grok',
        });
        launched = true;
      } else {
        launchError =
          'Grok CLI was not detected. Open this HQ folder manually from Grok.';
        showManualTools = true;
      }
    } catch (err) {
      launchError = `Could not open Grok: ${errorMessage(err)}`;
      showManualTools = true;
      aiTools = markToolUnavailable(aiTools, 'grok_cli');
    } finally {
      launching = null;
    }
    if (launched) await finishWithRecovery();
  }

  function stopClaudeWatch() {
    if (claudeWatchInterval !== null) {
      window.clearInterval(claudeWatchInterval);
    }
    claudeWatchInterval = null;
    if (launching === 'watching') {
      launching = null;
    }
  }

  function stopClaudeWatchWithError(err: unknown) {
    stopClaudeWatch();
    launchError = `Could not open Claude Code: ${errorMessage(err)}`;
    showManualTools = true;
  }

  async function pollClaudeReady() {
    if (Date.now() - claudeWatchStartedAt >= 15 * 60 * 1000) {
      stopClaudeWatch();
      claudeWatchExpired = true;
      return;
    }

    let ready: ClaudeReady;
    try {
      ready = await invoke<ClaudeReady>('detect_claude_ready');
      claudeWatchConsecutiveFailures = 0;
    } catch (err) {
      claudeWatchConsecutiveFailures += 1;
      if (
        claudeWatchConsecutiveFailures >=
        CLAUDE_WATCH_MAX_CONSECUTIVE_FAILURES
      ) {
        stopClaudeWatchWithError(err);
      }
      return;
    }

    const desktopFallbackReady =
      ready.desktop_installed &&
      Date.now() - claudeWatchStartedAt >= CLAUDE_DESKTOP_READY_FALLBACK_MS;
    if (!ready.installed || (!ready.logged_in && !desktopFallbackReady)) {
      return;
    }

    stopClaudeWatch();
    launching = 'claude';
    let launched = false;
    try {
      const url = buildClaudeCodeUrl({
        folder: installPath ?? '',
        prompt: '/setup',
      });
      await invoke('open_claude_code_link', { url });
      launched = true;
    } catch (err) {
      stopClaudeWatchWithError(err);
    } finally {
      launching = null;
    }
    if (launched) await finishWithRecovery();
  }

  function startClaudeWatch() {
    if (claudeWatchInterval !== null) {
      return;
    }
    claudeWatchExpired = false;
    claudeWatchConsecutiveFailures = 0;
    claudeWatchStartedAt = Date.now();
    launching = 'watching';
    claudeWatchInterval = window.setInterval(() => {
      void pollClaudeReady();
    }, 3000);
  }

  async function handleDownloadClaude() {
    launchError = null;
    revealError = null;
    const watching = claudeWatchInterval !== null;
    if (!watching) {
      launching = 'download';
    }
    try {
      await openExternal('https://claude.ai/download');
      if (!watching) {
        startClaudeWatch();
      }
    } catch (err) {
      launchError = `Could not open Claude download page: ${errorMessage(err)}`;
      showManualTools = true;
    } finally {
      if (launching === 'download') {
        launching = null;
      }
    }
  }

  async function handlePrimaryLaunch() {
    if (launching === 'watching' || primaryLaunch.kind === 'download') {
      return handleDownloadClaude();
    }
    if (primaryLaunch.kind === 'claude') {
      return handleLaunchClaudeCode();
    }
    if (primaryLaunch.kind === 'codex') {
      return handleLaunchCodex();
    }
    return handleLaunchGrok();
  }

  function advanceTo(step: number) {
    router.goTo(step);
    transitionTo(router.currentStep);
  }

  function goBackTo(step: number) {
    router.goTo(step);
    transitionTo(router.currentStep);
  }

  function resetMorphArtifacts() {
    if (logoEl) {
      logoEl.style.transition = '';
      logoEl.style.transform = '';
      logoEl.style.opacity = '';
    }
    if (folderLargeEl) {
      folderLargeEl.style.transition = '';
      folderLargeEl.style.opacity = '';
    }
    if (folderLabelEl) {
      folderLabelEl.style.transition = '';
      folderLabelEl.style.opacity = '';
    }
  }

  function flipTo(logo: HTMLElement, label: HTMLElement): string {
    const source = logo.getBoundingClientRect();
    const destination = label.getBoundingClientRect();
    const scale = destination.width / source.width;
    const tx =
      destination.left + destination.width / 2 - (source.left + source.width / 2);
    const ty =
      destination.top + destination.height / 2 - (source.top + source.height / 2);
    return `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  async function runMorph(prev: number, next: number, token: number) {
    if (reducedMotion || !logoEl || !folderLabelEl || !folderLargeEl) return false;
    if (!((prev === 0 && next === 1) || (prev === 1 && next === 0))) return false;

    morphMode = prev === 0 ? 'forward' : 'back';
    graphicStep = next;
    graphicOn = true;
    await tick();
    if (token !== transitionToken || !logoEl || !folderLabelEl || !folderLargeEl) {
      return true;
    }

    if (prev === 0) {
      folderLargeEl.style.transition = 'none';
      folderLargeEl.style.opacity = '0';
      folderLabelEl.style.transition = 'none';
      folderLabelEl.style.opacity = '0';
      await tick();
      const transform = flipTo(logoEl, folderLabelEl);
      folderLargeEl.style.transition = 'opacity .5s ease';
      folderLargeEl.style.opacity = '1';
      logoEl.style.transformOrigin = 'center center';
      logoEl.style.transition = 'transform .55s cubic-bezier(.4,0,.2,1)';
      logoEl.style.transform = transform;
      setTransitionTimer(() => {
        if (token !== transitionToken || !logoEl || !folderLabelEl) return;
        logoEl.style.transition = 'opacity .22s ease';
        logoEl.style.opacity = '0';
        folderLabelEl.style.transition = 'opacity .22s ease';
        folderLabelEl.style.opacity = '1';
        setTransitionTimer(() => {
          if (token !== transitionToken) return;
          morphMode = null;
          resetMorphArtifacts();
        }, 240);
      }, 540);
      return true;
    }

    const transform = flipTo(logoEl, folderLabelEl);
    logoEl.style.transformOrigin = 'center center';
    logoEl.style.transition = 'none';
    logoEl.style.transform = transform;
    logoEl.style.opacity = '0';
    await tick();
    if (token !== transitionToken || !logoEl) return true;
    logoEl.style.transition = 'transform .5s cubic-bezier(.4,0,.2,1), opacity .28s ease';
    logoEl.style.transform = '';
    logoEl.style.opacity = '1';
    setTransitionTimer(() => {
      if (token !== transitionToken) return;
      morphMode = null;
      resetMorphArtifacts();
    }, 520);
    return true;
  }

  function transitionTo(next: number) {
    if (next === currentStep) return;
    const previous = currentStep;
    currentStep = next;
    furthestStep = Math.max(furthestStep, next);
    const token = ++transitionToken;
    clearTransitionTimers();
    resetMorphArtifacts();

    if (previous === 2 && next !== 2 && !setupCompleted) {
      cancelSetupRun();
      setupStarted = false;
      stages = buildInitialStages();
    }
    if (previous === 3 && next !== 3) {
      stopClaudeWatch();
    }

    panelOn = false;
    const delay = reducedMotion ? 120 : FADE_OUT_MS;

    void runMorph(previous, next, token).then((handled) => {
      if (handled) return;
      const slide = previous >= 5 && next >= 5 && !reducedMotion;
      if (slide) {
        outgoingGraphicStep = graphicStep;
        outgoingGraphicDirection = next > previous ? 'left' : 'right';
        incomingGraphicDirection = next > previous ? 'right' : 'left';
        graphicStep = next;
        graphicOn = false;
        void tick().then(() => {
          if (token !== transitionToken) return;
          graphicOn = true;
          incomingGraphicDirection = null;
          setTransitionTimer(() => {
            if (token !== transitionToken) return;
            outgoingGraphicStep = null;
            outgoingGraphicDirection = null;
          }, 460);
        });
        return;
      }

      graphicOn = false;
      setTransitionTimer(() => {
        if (token !== transitionToken) return;
        graphicStep = next;
        void tick().then(() => {
          if (token !== transitionToken) return;
          graphicOn = true;
        });
      }, delay);
    });

    setTransitionTimer(() => {
      if (token !== transitionToken) return;
      panelStep = next;
      panelOn = true;
    }, delay);
  }

  function graphicIsOn(step: number): boolean {
    return (
      (graphicStep === step && graphicOn) ||
      (morphMode === 'forward' && (step === 0 || step === 1)) ||
      (morphMode === 'back' && (step === 0 || step === 1)) ||
      outgoingGraphicStep === step
    );
  }
</script>

<div
  class="onboarding-page"
  data-testid="onboarding-wizard"
  style={`--onboarding-bg-url: url("${onboardingBg}");`}
>
  <h1 class="sr-only">HQ desktop onboarding</h1>

  <div class="scaler">
    <div class="window" style={`--toph: ${topHeight};`}>
      <div class="drag-strip" data-tauri-drag-region></div>
      <div class="grad"></div>

      <div class="gfxwrap" aria-hidden="true">
        <div
          class="gfx"
          class:on={graphicIsOn(0)}
          class:enter-left={graphicStep === 0 && incomingGraphicDirection === 'left'}
          class:enter-right={graphicStep === 0 && incomingGraphicDirection === 'right'}
          class:out-left={outgoingGraphicStep === 0 && outgoingGraphicDirection === 'left'}
          class:out-right={outgoingGraphicStep === 0 && outgoingGraphicDirection === 'right'}
          data-g="0"
        >
          <div class="logo" bind:this={logoEl}>{@render HqLogo()}</div>
        </div>

        <div
          class="gfx"
          class:on={graphicIsOn(1)}
          class:enter-left={graphicStep === 1 && incomingGraphicDirection === 'left'}
          class:enter-right={graphicStep === 1 && incomingGraphicDirection === 'right'}
          class:out-left={outgoingGraphicStep === 1 && outgoingGraphicDirection === 'left'}
          class:out-right={outgoingGraphicStep === 1 && outgoingGraphicDirection === 'right'}
          data-g="1"
        >
          <div class="finder-item">
            <img class="macfolder-lg" src={folderIcon} alt="" bind:this={folderLargeEl} />
            <span class="flabel" bind:this={folderLabelEl}>HQ</span>
          </div>
        </div>

        <div
          class="gfx"
          class:on={graphicIsOn(2)}
          class:enter-left={graphicStep === 2 && incomingGraphicDirection === 'left'}
          class:enter-right={graphicStep === 2 && incomingGraphicDirection === 'right'}
          class:out-left={outgoingGraphicStep === 2 && outgoingGraphicDirection === 'left'}
          class:out-right={outgoingGraphicStep === 2 && outgoingGraphicDirection === 'right'}
          data-g="2"
        >
          <div
            class="prog"
            role="progressbar"
            aria-label="Setup progress"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={overallPercent}
          >
            <svg viewBox="0 0 120 120">
              <circle class="ptrack" cx="60" cy="60" r="52" />
              <circle
                class="pbar"
                cx="60"
                cy="60"
                r="52"
                style={`stroke-dasharray: ${RING_CIRCUMFERENCE}; stroke-dashoffset: ${ringOffset};`}
              />
            </svg>
            <span class="ppct">{overallPercent}%</span>
          </div>
        </div>

        <div class="gfx" class:on={graphicIsOn(3)} data-g="3">
          {@render ConsentShield()}
        </div>

        <div class="gfx" class:on={graphicIsOn(4)} data-g="4">
          {@render BigCheck()}
        </div>

        <div
          class="gfx gtop"
          class:on={graphicIsOn(5)}
          class:enter-left={graphicStep === 5 && incomingGraphicDirection === 'left'}
          class:enter-right={graphicStep === 5 && incomingGraphicDirection === 'right'}
          class:out-left={outgoingGraphicStep === 5 && outgoingGraphicDirection === 'left'}
          class:out-right={outgoingGraphicStep === 5 && outgoingGraphicDirection === 'right'}
          data-g="5"
        >
          {@render TrustMock()}
        </div>

        <div
          class="gfx"
          class:on={graphicIsOn(6)}
          class:enter-left={graphicStep === 6 && incomingGraphicDirection === 'left'}
          class:enter-right={graphicStep === 6 && incomingGraphicDirection === 'right'}
          class:out-left={outgoingGraphicStep === 6 && outgoingGraphicDirection === 'left'}
          class:out-right={outgoingGraphicStep === 6 && outgoingGraphicDirection === 'right'}
          data-g="6"
        >
          {@render SettingsMock()}
        </div>

        <div
          class="gfx"
          class:on={graphicIsOn(7)}
          class:enter-left={graphicStep === 7 && incomingGraphicDirection === 'left'}
          class:enter-right={graphicStep === 7 && incomingGraphicDirection === 'right'}
          class:out-left={outgoingGraphicStep === 7 && outgoingGraphicDirection === 'left'}
          class:out-right={outgoingGraphicStep === 7 && outgoingGraphicDirection === 'right'}
          data-g="7"
        >
          {@render SetupPromptMock()}
        </div>

        <div
          class="gfx gtop"
          class:on={graphicIsOn(8)}
          class:enter-left={graphicStep === 8 && incomingGraphicDirection === 'left'}
          class:enter-right={graphicStep === 8 && incomingGraphicDirection === 'right'}
          class:out-left={outgoingGraphicStep === 8 && outgoingGraphicDirection === 'left'}
          class:out-right={outgoingGraphicStep === 8 && outgoingGraphicDirection === 'right'}
          data-g="8"
        >
          {@render HandoffMock()}
        </div>

        <div
          class="gfx gtop"
          class:on={graphicIsOn(9)}
          class:enter-left={graphicStep === 9 && incomingGraphicDirection === 'left'}
          class:enter-right={graphicStep === 9 && incomingGraphicDirection === 'right'}
          class:out-left={outgoingGraphicStep === 9 && outgoingGraphicDirection === 'left'}
          class:out-right={outgoingGraphicStep === 9 && outgoingGraphicDirection === 'right'}
          data-g="9"
        >
          {@render BuildMock()}
        </div>
      </div>

      <div class="panelwrap">
        <section
          class="panel"
          class:on={panelStep === 0 && panelOn}
          data-p="0"
          data-testid="onboarding-signin"
          aria-labelledby="onboarding-title-signin"
        >
          <h2 class="h" id="onboarding-title-signin">Welcome to HQ</h2>
          <p class="body">One home for your whole team and every AI tool you use. Your knowledge, your best work, and your way of doing things all in one place, getting better over time.</p>
          <!-- The telemetry consent checkbox used to live here, pre-ticked. It is
               gone on purpose: a pre-ticked box is not a real choice, and posting
               the answer here (before setup provisions the person entity) meant the
               write had nowhere to land. Consent is now its own step after setup. -->
          {#if signInError}
            <p class="inline-note error" role="alert">{signInError}</p>
          {:else if loadingProvider}
            <p class="inline-note" role="status">
              A browser window opened for {loadingProvider} sign-in. Complete it there and you'll return here automatically.
            </p>
          {/if}
          <div class="btns">
            <button
              class="btn btn-primary"
              type="button"
              disabled={loadingProvider !== null}
              aria-busy={loadingProvider === 'Google'}
              onclick={() => handleSignIn('Google')}
            >
              Log in with Google
            </button>
            <button
              class="btn btn-secondary"
              type="button"
              disabled={loadingProvider !== null}
              aria-busy={loadingProvider === 'Microsoft'}
              onclick={() => handleSignIn('Microsoft')}
            >
              Log in with Microsoft
            </button>
          </div>
        </section>

        <section
          class="panel"
          class:on={panelStep === 1 && panelOn}
          data-p="1"
          data-testid="onboarding-directory"
          aria-labelledby="onboarding-title-directory"
        >
          <h2 class="h" id="onboarding-title-directory">Choose where HQ lives</h2>
          <p class="body">It’s just one folder. It sits on your machine and stays in sync everywhere you work.</p>
          <div class="loc">
            <img class="mf" src={folderIcon} alt="" />
            <div class="grow">
              <div class="lt">HQ</div>
              <div class="lb" title={resolvedPath ?? undefined}>{displayPath}</div>
            </div>
            <button class="choose" type="button" disabled={directoryBusy} onclick={chooseFolder}>
              {directoryButtonLabel}
            </button>
          </div>
          {#if directoryNotice}
            <p class:error={directoryNotice.tone === 'error'} class:warning={directoryNotice.tone === 'warning'} class="inline-note" role="status">
              {directoryNotice.text}
            </p>
          {/if}
          <div class="btns split">
            <button class="btn btn-secondary" type="button" onclick={() => goBackTo(0)}>Back</button>
            <button
              class="btn btn-primary"
              type="button"
              disabled={!installPath || directoryBusy}
              onclick={handleInstall}
            >
              Install
            </button>
          </div>
        </section>

        <section
          class="panel"
          class:on={panelStep === 2 && panelOn}
          data-p="2"
          data-testid="onboarding-setup"
          aria-labelledby="onboarding-title-setup"
        >
          <h2 class="h" id="onboarding-title-setup">Getting your HQ ready</h2>
          <div class="list" aria-label="Setup checklist">
            {#each setupBands as band}
              <div class:muted={band.status === 'pending'} class="li">
                {#if band.status === 'active'}
                  <span class="st spin" aria-hidden="true"></span>
                {:else if band.status === 'done'}
                  <span class="st dotmark" aria-hidden="true">{@render CheckTiny()}</span>
                {:else}
                  <span class="st dotpend" aria-hidden="true"></span>
                {/if}
                <span class="lt">{band.label}</span>
              </div>
            {/each}
          </div>
          <!-- The setup screen intentionally shows ONLY the friendly checklist (matching
               the design). Recovery — retry on stall, skip on hard timeout, transient-
               failure retries — runs AUTOMATICALLY in the setup engine; any stage that
               still fails is surfaced on the "HQ is ready" screen's needs-attention note,
               not here. No percentages, stage counts, staging toggle, or manual controls. -->
          <div class="btns">
            <button class="btn btn-secondary" type="button" onclick={() => goBackTo(1)}>Back</button>
          </div>
        </section>

        <section
          class="panel"
          class:on={panelStep === 3 && panelOn}
          data-p="3"
          data-testid="onboarding-consent"
          aria-labelledby="onboarding-title-consent"
        >
          <h2 class="h" id="onboarding-title-consent">Help improve HQ?</h2>
          <p class="body">
            You choose whether HQ collects anonymous usage data. Nothing is decided
            for you — pick an option to continue. You can change this later in
            Settings, and either choice sets up HQ the same way.
          </p>
          <div class="consent-facts">
            <p class="consent-facts-line">
              <span class="consent-facts-label">What we collect:</span>
              which skills you run, the AI model, token and session counts, and the
              names of your repositories, branches, and connected MCP services.
            </p>
            <p class="consent-facts-line">
              <span class="consent-facts-label">What we never collect:</span>
              the words in your prompts, the contents of your files, or what you
              pass into and get back from your tools.
            </p>
            <p class="consent-facts-line">
              <!-- Points at the HQ telemetry/privacy documentation. TODO(consent):
                   confirm the canonical privacy URL before release. -->
              <button
                type="button"
                class="consent-link"
                disabled={privacyOpening}
                aria-busy={privacyOpening}
                onclick={() => void handleOpenPrivacy()}
              >{privacyOpening
                  ? 'Opening privacy details…'
                  : privacyOpenError
                    ? 'Retry opening the privacy details'
                    : "Read the full description of what's collected"}</button>
              {#if privacyOpenError}
                <span class="consent-link-error" role="alert">
                  Couldn’t open the page.
                </span>
              {/if}
            </p>
          </div>
          <fieldset class="consent-options">
            <legend class="sr-only">Share anonymous usage data</legend>
            <label class="consent-option" class:selected={telemetryChoice === 'share'}>
              <input
                type="radio"
                name="telemetry-consent"
                value="share"
                checked={telemetryChoice === 'share'}
                onchange={() => {
                  telemetryChoice = 'share';
                  consentFailure = null;
                }}
              />
              <span class="consent-option-copy">
                <span class="consent-option-title">Share usage data</span>
                <span class="consent-option-sub">Help make HQ better for everyone.</span>
              </span>
            </label>
            <label class="consent-option" class:selected={telemetryChoice === 'decline'}>
              <input
                type="radio"
                name="telemetry-consent"
                value="decline"
                checked={telemetryChoice === 'decline'}
                onchange={() => {
                  telemetryChoice = 'decline';
                  consentFailure = null;
                }}
              />
              <span class="consent-option-copy">
                <span class="consent-option-title">Don't share usage data</span>
                <span class="consent-option-sub">Everything still works exactly the same.</span>
              </span>
            </label>
          </fieldset>
          {#if consentFailure}
            <div
              class="consent-error"
              class:offline={consentFailure.kind === 'offline'}
              role="alert"
              data-testid="consent-error"
            >
              {#if consentFailure.kind === 'offline'}
                <p class="consent-error-text">
                  You appear to be offline, so your choice couldn't be sent yet.
                  It's saved on this machine and HQ will send it automatically the
                  next time you're connected. You can finish setting up now.
                </p>
              {:else}
                <p class="consent-error-text">
                  We couldn't save your choice to the server just now. Nothing was
                  lost — your answer is held on this machine. Try again in a
                  moment.
                </p>
              {/if}
            </div>
          {/if}
          {#if finishError}
            <div class="finish-action-error" role="alert" data-testid="consent-finish-error">
              <span>Couldn’t finish setup. Your progress is safe.</span>
              <button
                type="button"
                onclick={handleFinish}
                disabled={finishing}
                aria-busy={finishing}
              >
                {finishing ? 'Retrying…' : 'Retry'}
              </button>
            </div>
          {/if}
          <div class="btns">
            {#if consentFailure}
              <button
                class="btn btn-primary"
                type="button"
                disabled={consentSubmitting || finishing}
                data-testid="consent-retry"
                onclick={() => void submitConsent()}
              >{consentSubmitting ? 'Retrying…' : 'Retry'}</button>
              {#if consentFailure.kind === 'offline'}
                <button
                  class="btn btn-secondary"
                  type="button"
                  disabled={consentSubmitting || finishing}
                  data-testid="consent-finish-offline"
                  onclick={() => void finishOffline()}
                >Finish setup — send later</button>
              {/if}
            {:else}
              <button
                class="btn btn-primary"
                type="button"
                data-testid="consent-continue"
                disabled={telemetryChoice === null || consentSubmitting || finishing}
                onclick={() => void submitConsent()}
              >{consentSubmitting ? 'Saving…' : 'Continue'}</button>
              {#if isReprompt}
                <!-- US-005: dismissing is allowed but is NOT an answer. It marks
                     the prompt shown for this version so it stops nagging, posts
                     nothing, and leaves the record stale (collection continues
                     under the previous default until the person answers). -->
                <button
                  class="btn btn-secondary"
                  type="button"
                  data-testid="consent-dismiss"
                  disabled={consentSubmitting || finishing}
                  onclick={() => void dismissReprompt()}
                >Not now</button>
              {/if}
            {/if}
          </div>
        </section>

        <section
          class="panel"
          class:on={panelStep === 4 && panelOn}
          data-p="4"
          data-testid="onboarding-summary"
          aria-labelledby="onboarding-title-ready"
        >
          <h2 class="h" id="onboarding-title-ready">HQ is ready</h2>
          <p class="body">HQ now lives in your menubar and keeps everything in sync. Open it in your favorite AI tool to start working.</p>
          <div class="setup-caution" role="note" aria-label="Complete setup in your AI tool">
            <svg class="setup-caution-icon" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 2.4 18 17H2L10 2.4Z"></path>
              <path d="M10 7v4.5"></path>
              <circle cx="10" cy="14.2" r=".7"></circle>
            </svg>
            <div class="setup-caution-copy">
              <strong>Complete setup in your AI tool</strong>
              <span>Open the HQ folder and run <code>/setup</code>.</span>
            </div>
          </div>
          {#if needsAttention}
            <p class="inline-note warning" role="status">
              Setup finished, but {setupFailures.length} {setupFailures.length === 1 ? 'step needs' : 'steps need'} another pass inside HQ.
            </p>
          {/if}
          {#if launchError || revealError}
            <p class="inline-note error" role="alert">{launchError ?? revealError}</p>
          {:else if detectionFailed}
            <p class="inline-note" role="status">Tool detection failed. You can still continue and open {installDisplayPath} manually.</p>
          {/if}
          {#if claudeWatchExpired}
            <p class="inline-note" role="status">
              Claude is taking longer than expected. You can open this HQ folder from Claude manually.
            </p>
          {/if}
          {#if finishError}
            <div class="finish-action-error" role="alert" data-testid="launcher-finish-error">
              <span>The tool opened, but HQ couldn’t finish setup.</span>
              <button
                type="button"
                onclick={handleFinish}
                disabled={finishing}
                aria-busy={finishing}
              >
                {finishing ? 'Retrying…' : 'Retry'}
              </button>
            </div>
          {/if}
          {#if manualToolsVisible}
            <div class="manual-tools" aria-label="Manual setup options">
              <button
                type="button"
                onclick={handleRevealFolder}
                disabled={revealingFolder}
                aria-busy={revealingFolder}
              >
                {revealingFolder ? 'Revealing…' : 'Reveal folder'}
              </button>
              <button
                type="button"
                onclick={handleCopyPath}
                disabled={copyingAction !== null}
                aria-busy={copyingAction === 'path'}
              >
                {copyingAction === 'path' ? 'Copying…' : pathCopied ? 'Path copied' : 'Copy path'}
              </button>
              <button
                type="button"
                onclick={handleCopyCommand}
                disabled={copyingAction !== null}
                aria-busy={copyingAction === 'command'}
              >
                {copyingAction === 'command' ? 'Copying…' : commandCopied ? 'Command copied' : 'Copy command'}
              </button>
              <button
                type="button"
                onclick={handleCopyImportPrompt}
                disabled={copyingAction !== null}
                aria-busy={copyingAction === 'import'}
              >
                {copyingAction === 'import' ? 'Copying…' : importPromptCopied ? 'Import copied' : 'Copy /import-claude'}
              </button>
            </div>
            {#if copyFailure}
              <div class="copy-action-error" role="alert" data-testid="onboarding-copy-error">
                <span>Couldn’t copy to the clipboard.</span>
                <button
                  type="button"
                  onclick={() => void retryCopyAction()}
                  disabled={copyingAction !== null}
                  aria-busy={copyingAction !== null}
                >
                  {copyingAction ? 'Retrying…' : 'Retry'}
                </button>
              </div>
            {/if}
          {/if}
          <div class="btns">
            <button
              class="btn btn-primary"
              type="button"
              disabled={finishing || (launching !== null && launching !== 'watching')}
              aria-busy={finishing || (launching !== null && launching !== 'watching')}
              onclick={handlePrimaryLaunch}
            >
              {finishing
                ? 'Finishing…'
                : launching === 'watching'
                ? 'Waiting for Claude…'
                : launching === primaryLaunch.kind
                  ? 'Opening…'
                  : primaryLaunch.label}
            </button>
          </div>
        </section>

        <section
          class="panel"
          class:on={panelStep === 5 && panelOn}
          data-p="5"
          data-testid="onboarding-trust"
          aria-labelledby="onboarding-title-trust"
        >
          <h2 class="h" id="onboarding-title-trust">Trust your workspace</h2>
          <p class="body">Claude Code will open with your hq folder selected and /setup ready to run. Choose “Yes, trust this workspace.” Just check that hq is still the folder it’s pointing at.</p>
          <div class="btns split"><button class="btn btn-secondary" type="button" onclick={() => goBackTo(4)}>Back</button><button class="btn btn-primary" type="button" onclick={() => advanceTo(6)}>Continue</button></div>
        </section>

        <section
          class="panel"
          class:on={panelStep === 6 && panelOn}
          data-p="6"
          data-testid="onboarding-settings"
          aria-labelledby="onboarding-title-settings"
        >
          <h2 class="h" id="onboarding-title-settings">Dial in your settings</h2>
          <p class="body">For the best results, use the latest models (Opus 4.8 or GPT-5.5), set thinking to “High” or above, and turn on auto mode (bypass permissions). You might need to flip that last one on in settings.</p>
          <div class="btns split"><button class="btn btn-secondary" type="button" onclick={() => goBackTo(5)}>Back</button><button class="btn btn-primary" type="button" onclick={() => advanceTo(7)}>Continue</button></div>
        </section>

        <section
          class="panel"
          class:on={panelStep === 7 && panelOn}
          data-p="7"
          data-testid="onboarding-run-setup"
          aria-labelledby="onboarding-title-run-setup"
        >
          <h2 class="h" id="onboarding-title-run-setup">Press enter to run /setup</h2>
          <p class="body">Hit ⏎ in the message box to start setup.</p>
          <div class="btns split"><button class="btn btn-secondary" type="button" onclick={() => goBackTo(6)}>Back</button><button class="btn btn-primary" type="button" onclick={() => advanceTo(8)}>Continue</button></div>
        </section>

        <section
          class="panel"
          class:on={panelStep === 8 && panelOn}
          data-p="8"
          data-testid="onboarding-handoff"
          aria-labelledby="onboarding-title-handoff"
        >
          <h2 class="h" id="onboarding-title-handoff">Answer, then run /handoff</h2>
          <p class="body">Work through every question until it says setup is finished, then send “/handoff” to save everything to HQ’s memory. You’ll do this at the end of every session.</p>
          <div class="btns split"><button class="btn btn-secondary" type="button" onclick={() => goBackTo(7)}>Back</button><button class="btn btn-primary" type="button" onclick={() => advanceTo(9)}>Continue</button></div>
        </section>

        <section
          class="panel"
          class:on={panelStep === 9 && panelOn}
          data-p="9"
          data-testid="onboarding-build"
          aria-labelledby="onboarding-title-build"
        >
          <h2 class="h" id="onboarding-title-build">Open a fresh session and build</h2>
          <p class="body">Start with “/brainstorm” to get going. Working on a specific company? Send “/startwork acme” and describe what you want. Then it’s the same rhythm every time: start work, handoff, repeat.</p>
          {#if finishError}
            <p class="inline-note error" role="alert" data-testid="onboarding-finish-error">
              Couldn’t finish setup. Your progress is safe.
            </p>
          {/if}
          <div class="btns split"><button class="btn btn-secondary" type="button" onclick={() => goBackTo(8)}>Back</button><button class="btn btn-primary" type="button" onclick={handleFinish} disabled={finishing} aria-busy={finishing}>{finishing ? 'Finishing…' : finishError ? 'Retry' : 'Done'}</button></div>
        </section>
      </div>
    </div>
  </div>
</div>

{#snippet HqLogo()}
  <svg viewBox="0 0 280 161" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M85.7251 3.66162H118.034V154.434H85.7251V89.8175H32.3085V154.434H0V3.66162H32.3085V57.5091H85.7251V3.66162Z" fill="currentColor"/><path d="M257.169 160.035L241.014 144.096C235.343 147.973 229.096 150.988 222.276 153.142C215.527 155.296 208.419 156.373 200.952 156.373C190.757 156.373 181.172 154.363 172.197 150.342C163.223 146.25 155.325 140.65 148.505 133.542C141.684 126.362 136.335 118.07 132.458 108.664C128.581 99.187 126.642 89.0278 126.642 78.1865C126.642 67.417 128.581 57.3296 132.458 47.9242C136.335 38.4471 141.684 30.1187 148.505 22.939C155.325 15.7593 163.223 10.1592 172.197 6.1386C181.172 2.0462 190.757 0 200.952 0C211.219 0 220.84 2.0462 229.814 6.1386C238.789 10.1592 246.686 15.7593 253.507 22.939C260.328 30.1187 265.641 38.4471 269.446 47.9242C273.323 57.3296 275.261 67.417 275.261 78.1865C275.261 86.0123 274.184 93.5151 272.031 100.695C269.948 107.803 267.077 114.444 263.415 120.618L280 137.203L257.169 160.035ZM200.952 124.065C203.896 124.065 206.732 123.741 209.46 123.095C212.26 122.449 214.952 121.552 217.537 120.403L208.491 111.357L231.322 88.5252L239.291 96.4946C240.512 93.6946 241.409 90.7509 241.984 87.6637C242.63 84.5764 242.953 81.4173 242.953 78.1865C242.953 71.8684 241.84 65.9452 239.614 60.4168C237.461 54.8885 234.445 50.0422 230.568 45.878C226.691 41.642 222.204 38.3394 217.106 35.9701C212.08 33.529 206.696 32.3085 200.952 32.3085C195.208 32.3085 189.788 33.529 184.69 35.9701C179.664 38.3394 175.213 41.642 171.336 45.878C167.459 50.0422 164.407 54.8885 162.182 60.4168C160.028 65.9452 158.951 71.8684 158.951 78.1865C158.951 84.5046 160.028 90.4637 162.182 96.0638C164.407 101.592 167.459 106.474 171.336 110.71C175.213 114.875 179.664 118.141 184.69 120.511C189.788 122.88 195.208 124.065 200.952 124.065Z" fill="currentColor"/></svg>
{/snippet}

{#snippet CheckTiny()}
  <svg viewBox="0 0 12 12" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2.5,6.5 5,9 9.5,3.5"/></svg>
{/snippet}

{#snippet CheckSmall()}
  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5 6 10.5 11 4"/></svg>
{/snippet}

{#snippet LocalChipIcon()}
  <svg viewBox="0 0 14 14" width="11" height="11" fill="none"><rect x="1.5" y="2" width="11" height="7.5" rx="1" stroke="currentColor" stroke-width="1.1"/><path d="M5 12h4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>
{/snippet}

{#snippet FolderChipIcon()}
  <svg viewBox="0 0 14 14" width="11" height="11" fill="none"><path d="M1.5 3.6c0-.6.5-1 1-1H6l1.2 1.4H11.5c.6 0 1 .5 1 1v4.6c0 .6-.4 1-1 1h-9c-.5 0-1-.4-1-1V3.6Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>
{/snippet}

{#snippet GitChipIcon()}
  <svg viewBox="0 0 14 14" width="11" height="11" fill="none"><circle cx="4" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.1"/><circle cx="4" cy="10.5" r="1.6" stroke="currentColor" stroke-width="1.1"/><circle cx="10" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.1"/><path d="M4 5v4M10 5v1.5c0 1.5-1 2-2.5 2.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>
{/snippet}

{#snippet ReturnIcon()}
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none"><path d="M12.5 4.5V9H5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.5 6.5 5 9l2.5 2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
{/snippet}

{#snippet ReturnIconLarge()}
  <svg viewBox="0 0 16 16" width="22" height="22" fill="none"><path d="M12.5 4.5V9H5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.5 6.5 5 9l2.5 2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
{/snippet}

{#snippet PlusIcon()}
  <svg viewBox="0 0 14 14" width="12" height="12" fill="none"><path d="M7 3.5v7M3.5 7h7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
{/snippet}

{#snippet MicIcon()}
  <svg viewBox="0 0 14 14" width="12" height="12" fill="none"><rect x="5" y="1.5" width="4" height="7" rx="2" stroke="currentColor" stroke-width="1.1"/><path d="M3 7a4 4 0 0 0 8 0M7 11v1.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>
{/snippet}

{#snippet ConsentShield()}
  <svg class="bigcheck" viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M48 10 78 22V46c0 20-13 32-30 40C31 78 18 66 18 46V22L48 10Z" />
    <path d="M38 48l7 7 14-16" />
  </svg>
{/snippet}

{#snippet BigCheck()}
  <svg class="bigcheck" viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg">
    <defs><mask id="checkmask"><rect width="96" height="96" fill="white"/><path d="M35 49 L44.5 58.5 L63 38" fill="none" stroke="black" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></mask></defs>
    <circle cx="48" cy="48" r="45" fill="#ffffff" mask="url(#checkmask)"/>
  </svg>
{/snippet}

{#snippet TrustMock()}
  <div class="mockwin">
    <div class="mockbar"><i style="background:#ff5f56"></i><i style="background:#ffbd2e"></i><i style="background:#27c93f"></i><span class="tt">Claude Code</span></div>
    <div class="trust-body">
      <div class="trust-card">
        <div class="trust-copy">Do you trust the files in <span class="mn strong">~/hq</span>?</div>
        <div class="mn trust-options">
          <div class="selected">❯ 1. Yes, trust this workspace</div>
          <div>2. No, don't trust</div>
        </div>
      </div>
      <div class="chip-row">
        <span class="mchip">{@render LocalChipIcon()}Local</span>
        <span class="mchip">{@render FolderChipIcon()}hq</span>
        <span class="mchip">{@render GitChipIcon()}main<span class="mchip-sep">|</span><span class="worktree-dot"></span>worktree</span>
      </div>
      <div class="composer-preview"><span class="mn">/setup</span><span class="return-icon">{@render ReturnIcon()}</span></div>
      <div class="settings-preview"><span><span class="auto-pill">Auto</span>{@render PlusIcon()}{@render MicIcon()}</span><span><span>Opus 4.8</span><span>High</span></span></div>
    </div>
  </div>
{/snippet}

{#snippet SettingsMock()}
  <div class="mockwin settings-mock">
    <div class="settings-zoom">
      <span class="auto-pill big">Auto</span>
      <span>Opus 4.8</span>
      <span class="high-pill">High</span>
      <svg width="22" height="28" viewBox="0 0 17 22" fill="none" class="cursor"><path d="M2 1.5 2 16.8 6.1 12.9 8.8 19 11.2 17.9 8.5 11.9 13.8 11.6Z" fill="#1d1d1d" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>
    </div>
  </div>
{/snippet}

{#snippet SetupPromptMock()}
  <div class="mockwin setup-prompt-mock">
    <div class="prompt-box">
      <span class="mn prompt-command">/setup</span><span class="caret"></span><span class="return-icon large">{@render ReturnIconLarge()}</span>
    </div>
  </div>
{/snippet}

{#snippet HandoffMock()}
  <div class="mockwin chat">
    <div class="mockbar"><i style="background:#ff736a"></i><i style="background:#febc2e"></i><i style="background:#19c332"></i><span class="tt">Claude Code</span></div>
    <div class="mthread">
      <div class="mrow"><span class="mcheck">{@render CheckSmall()}</span><div class="mn"><span class="medium">Setup complete</span> <span class="l">7 questions · workspace configured</span></div></div>
      <div class="mbubble mn">/handoff</div>
      <div class="mrow"><span class="mspin2"><i></i></span><div class="mn"><span class="medium">/handoff</span> <span class="l">saving everything to HQ memory…</span></div></div>
    </div>
    <div class="composer-pad"><div class="mcomposer"><span>Type / for commands</span><span>↑</span></div></div>
  </div>
{/snippet}

{#snippet BuildMock()}
  <div class="mockwin chat">
    <div class="mockbar"><i style="background:#ff736a"></i><i style="background:#febc2e"></i><i style="background:#19c332"></i><span class="tt">Claude Code</span></div>
    <div class="mthread tight">
      <div class="mbubble mn">/brainstorm</div>
      <p>What are we building? Tell me the goal.</p>
      <div class="mbubble"><span class="mn">/startwork acme</span> Build the Q3 dashboard</div>
      <div class="mrow"><span class="mcheck">{@render CheckSmall()}</span><div class="mn"><span class="medium">/startwork</span> <span class="l">loaded acme context · on it</span></div></div>
    </div>
    <div class="composer-pad"><div class="mcomposer"><span>Type / for commands</span><span>↑</span></div></div>
  </div>
{/snippet}

<style>
  .onboarding-page {
    box-sizing: border-box;
    display:flex;
    flex-direction:column;
    align-items:center;
    justify-content:center;
    gap:26px;
    width:100vw;
    height:100dvh;
    min-height:0;
    padding:24px;
    overflow:auto;
    background: transparent;
    color:var(--c-text);
    font-family:var(--font-sans);
    -webkit-font-smoothing:antialiased;
  }

  .onboarding-page *,
  .onboarding-page *::before,
  .onboarding-page *::after {
    box-sizing:border-box;
  }

  .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }
  .scaler { width:min(640px, calc(100vw - 48px)); height:min(520px, calc(100dvh - 48px)); flex:0 0 auto; transform:scale(1); transform-origin:center; }
  /* The onboarding card floats in a transparent window with a small margin, so
     use a shadow tuned to fit that margin (tighter than the generic
     --shadow-window-* tokens, which would clip at the window edge). */
  .window { width:100%; height:100%; border-radius:var(--radius-card); overflow:hidden; background:var(--c-bg); box-shadow:0 18px 50px rgba(0,0,0,0.24), 0 2px 8px rgba(0,0,0,0.10); position:relative; --toph:200px; }

  @media (prefers-color-scheme: dark) {
    .window { box-shadow:0 24px 60px rgba(0,0,0,0.58), 0 0 0 0.5px rgba(255,255,255,0.14); }
  }

  :global(.dark) .window { box-shadow:0 24px 60px rgba(0,0,0,0.58), 0 0 0 0.5px rgba(255,255,255,0.14); }

  .drag-strip { position:absolute; top:0; left:0; right:0; height:28px; z-index:8; }
  .grad { position:absolute; top:0; left:0; right:0; height:var(--toph); background:#9c9c9c var(--onboarding-bg-url) center/cover no-repeat; filter:none; transition:height .55s cubic-bezier(.65,0,.35,1); z-index:0; }
  .gfxwrap { position:absolute; top:0; left:0; right:0; height:var(--toph); overflow:hidden; z-index:1; transition:height .55s cubic-bezier(.65,0,.35,1); }
  .gfx { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; opacity:0; pointer-events:none; transition:opacity .3s ease, transform .45s cubic-bezier(.4,0,.2,1); color:#fff; }
  .gfx.on { opacity:1; pointer-events:auto; transform:translateX(0); }
  .gfx.gtop { align-items:flex-start; padding-top:40px; }
  .gfx.gtop .mockwin { width:460px; }
  .gfx.enter-left { transform:translateX(-70px); }
  .gfx.enter-right { transform:translateX(70px); }
  .gfx.out-left { opacity:0; transform:translateX(-70px); }
  .gfx.out-right { opacity:0; transform:translateX(70px); }
  .panelwrap { position:absolute; left:0; right:0; bottom:0; top:var(--toph); background:var(--c-bg); border-top:1px solid rgba(0,0,0,0.05); overflow:hidden; transition:top .55s cubic-bezier(.65,0,.35,1); z-index:2; }
  .panel { position:absolute; inset:0; padding:24px; display:flex; flex-direction:column; overflow-y:auto; overscroll-behavior:contain; scrollbar-gutter:stable; opacity:0; pointer-events:none; transition:opacity .3s ease; }
  .panel.on { opacity:1; pointer-events:auto; }

  .h { color:var(--c-text); font-size:24px; font-weight:600; line-height:32px; margin:0; letter-spacing:-1px; }
  .body { color:var(--c-muted); font-size:14px; font-weight:400; line-height:20px; margin:4px 0 0; max-width:592px; }
  .consent-facts { margin-top:12px; display:flex; flex-direction:column; gap:6px; }
  .consent-facts-line { margin:0; color:var(--c-muted); font-size:12.5px; line-height:17px; }
  .consent-facts-label { color:var(--c-text); font-weight:600; }
  .consent-link { appearance:none; border:0; background:none; padding:0; margin:0; color:var(--c-text); font:inherit; font-size:12.5px; line-height:17px; text-decoration:underline; cursor:pointer; }
  .consent-link:hover { opacity:.8; }
  .consent-link:disabled { opacity:.55; cursor:wait; }
  .consent-link:focus-visible { outline:1.5px solid var(--c-focus-ring, var(--c-text)); outline-offset:2px; border-radius:3px; }
  .consent-link-error { margin-left:8px; color:#d04444; }

  .consent-error { margin:12px 0 0; padding:10px 13px; border:1px solid var(--c-danger, #d14343); border-radius:10px; background:color-mix(in srgb, var(--c-danger, #d14343) 8%, transparent); }
  .consent-error.offline { border-color:var(--c-warning, #c88a1e); background:color-mix(in srgb, var(--c-warning, #c88a1e) 8%, transparent); }
  .consent-error-text { margin:0; font-size:12.5px; line-height:17px; color:var(--c-text); }

  .consent-options { margin:14px 0 0; padding:0; border:0; display:flex; flex-direction:column; gap:8px; }
  .consent-option { display:flex; align-items:flex-start; gap:10px; padding:11px 13px; border:1px solid var(--c-field-border); border-radius:10px; cursor:pointer; transition:border-color .12s, background-color .12s; }
  .consent-option.selected { border-color:var(--check-bg); background:color-mix(in srgb, var(--check-bg) 8%, transparent); }
  .consent-option input { margin-top:2px; width:16px; height:16px; flex-shrink:0; accent-color:var(--check-bg); cursor:pointer; }
  .consent-option:has(input:focus-visible) { outline:1.5px solid var(--c-focus-ring, var(--c-text)); outline-offset:2px; }
  .consent-option-copy { display:flex; flex-direction:column; gap:1px; }
  .consent-option-title { color:var(--c-text); font-size:14px; font-weight:500; line-height:18px; }
  .consent-option-sub { color:var(--c-muted); font-size:12px; line-height:16px; }

  .btns { display:flex; gap:8px; margin-top:auto; }
  .btns.split { justify-content:space-between; }
  .btn { font-family:inherit; font-size:14px; font-weight:400; line-height:20px; padding:10px 16px; border-radius:8px; border:none; cursor:pointer; transition:opacity .15s, transform .1s; }
  .btn:active:not(:disabled) { transform:scale(.97); }
  .btn-primary { background:var(--c-btn-bg); color:var(--c-btn-fg); }
  .btn-secondary { background:var(--c-btn2-bg); color:var(--c-btn2-fg); }
  .btn:hover:not(:disabled) { opacity:.88; }
  .btn:focus-visible,
  .choose:focus-visible,
  .manual-tools button:focus-visible {
    outline:1.5px solid var(--c-focus-ring, var(--c-text));
    outline-offset:var(--c-focus-offset, 2px);
  }
  .btn:disabled { cursor:not-allowed; opacity:.48; }

  .inline-note { margin:10px 0 0; color:var(--c-muted); font-size:12px; line-height:16px; }
  .inline-note.error { color:#d04444; }
  .inline-note.warning { color:var(--c-text); }
  .finish-action-error { display:flex; align-items:baseline; justify-content:space-between; gap:10px; margin:10px 0 0; color:var(--c-danger, #d14343); font-size:12px; line-height:16px; }
  .finish-action-error button { flex:0 0 auto; padding:0; border:0; border-bottom:1px solid currentcolor; border-radius:0; background:transparent; color:inherit; font:inherit; font-weight:700; cursor:pointer; }
  .finish-action-error button:disabled { opacity:.58; cursor:wait; }
  .setup-caution {
    display:flex;
    align-items:flex-start;
    gap:9px;
    margin:12px 0 0;
    padding:10px 0 0;
    border:0;
    border-top:1px solid var(--c-divider);
    border-radius:0;
    background: transparent;
    color:var(--c-text);
    font-size:12px;
    line-height:16px;
  }
  .setup-caution-icon {
    width:17px;
    height:17px;
    flex:0 0 17px;
    margin-top:1px;
    fill:color-mix(in srgb, var(--c-muted) 18%, transparent);
    stroke:var(--c-muted);
    stroke-width:1.5;
    stroke-linecap:round;
    stroke-linejoin:round;
  }
  .setup-caution-icon circle { fill:var(--c-muted); stroke:none; }
  .setup-caution-copy { display:flex; flex-direction:column; gap:1px; }
  .setup-caution-copy strong { font-weight:600; }
  .setup-caution-copy span { color:var(--c-muted); }
  .setup-caution code {
    padding:0 3px;
    border-radius:4px;
    background:var(--c-btn2-bg);
    color:inherit;
    font-family:ui-monospace,"SF Mono",Menlo,Monaco,monospace;
    font-size:11px;
  }

  .list { margin-top:12px; display:flex; flex-direction:column; gap:5px; }
  .li { display:flex; align-items:center; gap:10px; color:var(--c-text); font-size:13px; line-height:18px; }
  .li.muted { color:var(--c-muted); }
  .dotmark { width:14px; height:14px; border-radius:50%; background:var(--check-bg); color:var(--check-fg); display:flex; align-items:center; justify-content:center; flex-shrink:0; }
  .dotmark svg { width:8px; height:8px; stroke:var(--check-fg); }
  .dotpend { width:14px; height:14px; border-radius:50%; border:1.4px solid var(--check-border); flex-shrink:0; }
  .spin { width:13px; height:13px; border:1.6px solid var(--check-border); border-top-color:var(--c-text); border-radius:50%; animation:sp .8s linear infinite; flex-shrink:0; }
  @keyframes sp { to{transform:rotate(360deg)} }

  .logo svg { width:120px; height:auto; display:block; color:#fff; }
  .finder-item { display:flex; flex-direction:column; align-items:center; gap:2px; }
  .finder-item .flabel { color:#fff; font-size:15px; font-weight:500; line-height:18px; padding:1.5px 7px; letter-spacing:-0.1px; text-shadow:0 1px 3px rgba(0,0,0,0.35); }
  .macfolder-lg { width:90px; height:90px; object-fit:contain; display:block; filter:drop-shadow(0 5px 11px rgba(0,0,0,0.22)); }
  .loc { display:flex; align-items:center; gap:12px; background:var(--c-field-bg); border:0.5px solid var(--c-field-border); border-radius:10px; padding:12px 14px; margin-top:18px; }
  .loc .mf { width:40px; height:40px; object-fit:contain; flex-shrink:0; display:block; filter:none; }
  .loc .grow { flex:1; min-width:0; }
  .loc .lt { color:var(--c-text); font-size:14px; font-weight:600; line-height:18px; }
  .loc .lb { color:var(--c-muted); font-size:12px; line-height:16px; margin-top:1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .choose { font-family:inherit; font-size:13px; font-weight:400; color:var(--c-text); background:var(--c-choose-bg); border:0.5px solid var(--c-choose-border); border-radius:6px; padding:5px 14px; cursor:pointer; box-shadow:var(--c-choose-shadow); white-space:nowrap; transition:filter .12s, opacity .12s; }
  .choose:hover:not(:disabled) { filter:brightness(0.97); }
  @media (prefers-color-scheme: dark) { .choose:hover:not(:disabled) { filter:brightness(1.25); } }
  :global(.dark) .choose:hover:not(:disabled) { filter:brightness(1.25); }
  .choose:disabled { opacity:.5; cursor:not-allowed; }
  .prog { position:relative; width:120px; height:120px; }
  .prog svg { width:120px; height:120px; transform:rotate(-90deg); }
  .ptrack { fill:none; stroke:rgba(255,255,255,0.28); stroke-width:5; }
  .pbar { fill:none; stroke:#fff; stroke-width:5; stroke-linecap:round; transition:stroke-dashoffset .18s ease; }
  .ppct { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#fff; font-size:15px; font-weight:400; letter-spacing:-0.3px; text-shadow:0 1px 4px rgba(0,0,0,0.25); }
  .bigcheck { width:84px; height:84px; display:block; }

  .manual-tools { display:flex; flex-wrap:wrap; gap:6px; margin-top:12px; }
  .manual-tools button { appearance:none; border:0.5px solid var(--c-field-border); border-radius:6px; background:var(--c-btn2-bg); color:var(--c-muted); font:inherit; font-size:11.5px; line-height:15px; padding:4px 7px; cursor:pointer; }
  .manual-tools button:hover:not(:disabled) { color:var(--c-text); }
  .manual-tools button:disabled { opacity:.5; cursor:not-allowed; }
  .copy-action-error {
    display:flex;
    align-items:center;
    gap:8px;
    margin-top:8px;
    color:#d04444;
    font-size:12px;
    line-height:16px;
  }
  .copy-action-error button {
    appearance:none;
    border:0;
    padding:0;
    background:transparent;
    color:inherit;
    font:inherit;
    font-weight:600;
    text-decoration:underline;
    text-underline-offset:2px;
    cursor:pointer;
  }
  .copy-action-error button:disabled { opacity:.55; cursor:wait; }

  .mn { font-family:ui-monospace,"SF Mono",Menlo,Monaco,monospace; }
  .medium, .strong { font-weight:500; }
  .mockwin { width:440px; background:#fff; border-radius:15px; box-shadow:0 0 0 1px rgba(0,0,0,0.1), 0 24px 60px -16px rgba(0,0,0,0.5); overflow:hidden; color:#000; flex-shrink:0; }
  .mockbar { position:relative; display:flex; align-items:center; gap:6px; padding:9px 12px; border-bottom:1px solid rgba(0,0,0,0.07); }
  .mockbar i { width:9px; height:9px; border-radius:50%; }
  .mockbar .tt { position:absolute; left:50%; transform:translateX(-50%); font-size:11px; font-weight:500; color:rgba(0,0,0,0.45); }
  .trust-body { padding:13px; display:flex; flex-direction:column; gap:10px; }
  .trust-card { border:1px solid rgba(0,0,0,0.08); background:#fafafa; border-radius:10px; padding:11px; }
  .trust-copy { font-size:12px; color:rgba(0,0,0,0.6); }
  .trust-options { margin-top:8px; display:flex; flex-direction:column; gap:4px; font-size:12px; }
  .trust-options div { padding:6px 9px; color:rgba(0,0,0,0.4); }
  .trust-options .selected { border:1px solid rgba(0,0,0,0.22); background:rgba(0,0,0,0.06); border-radius:6px; color:rgba(0,0,0,0.85); }
  .chip-row { display:flex; gap:6px; margin-top:8px; }
  .mchip { display:inline-flex; align-items:center; gap:4px; border:1px solid rgba(0,0,0,0.1); border-radius:7px; padding:3px 8px; font-size:11px; color:rgba(0,0,0,0.7); }
  .mchip-sep { margin:0 3px; color:rgba(0,0,0,0.2); }
  .worktree-dot { width:9px; height:9px; border-radius:2px; background:rgba(0,0,0,0.25); display:inline-block; }
  .composer-preview { display:flex; align-items:center; border:1px solid rgba(0,0,0,0.12); border-radius:11px; padding:10px 13px; }
  .composer-preview span:first-child { font-size:13px; color:rgba(0,0,0,0.4); }
  .return-icon { margin-left:auto; color:rgba(0,0,0,0.3); display:inline-flex; align-items:center; }
  .settings-preview { display:flex; justify-content:space-between; align-items:center; font-size:11px; color:rgba(0,0,0,0.5); }
  .settings-preview > span { display:flex; align-items:center; gap:9px; }
  .auto-pill { background:rgba(0,0,0,0.07); color:rgba(0,0,0,0.72); border-radius:5px; padding:2px 7px; font-weight:500; }
  .settings-mock { padding:40px 48px; display:flex; align-items:center; justify-content:center; }
  .settings-zoom { position:relative; display:flex; align-items:center; gap:28px; font-size:21px; color:rgba(0,0,0,0.75); }
  .settings-zoom > span:not(.auto-pill) { letter-spacing:-0.4px; }
  .auto-pill.big { border-radius:9px; padding:8px 16px; font-size:21px; }
  .high-pill { background:rgba(0,0,0,0.07); border-radius:8px; padding:6px 12px; color:rgba(0,0,0,0.85); }
  .cursor { position:absolute; right:0; bottom:0; transform:translate(18%,42%); filter:drop-shadow(0 1px 1.5px rgba(0,0,0,0.35)); }
  .setup-prompt-mock { padding:34px 48px; display:flex; align-items:center; }
  .prompt-box { display:flex; align-items:center; width:100%; border:1px solid rgba(0,0,0,0.14); border-radius:16px; padding:20px 24px; }
  .prompt-command { font-size:28px; font-weight:700; letter-spacing:-0.5px; color:#000; }
  .caret { display:inline-block; width:2px; height:26px; background:rgba(0,0,0,0.8); margin-left:3px; animation:caret 1s step-end infinite; }
  .return-icon.large { margin-left:auto; }
  @keyframes caret { 50%{opacity:0} }
  .mockwin.chat { display:flex; flex-direction:column; min-height:344px; }
  .mockwin.chat .mockbar { padding:11px 13px; gap:9px; }
  .mockwin.chat .mockbar i { width:14px; height:14px; border:0.5px solid rgba(0,0,0,0.1); }
  .mthread { padding:24px 15px 0; display:flex; flex-direction:column; gap:12px; flex:1; }
  .mthread.tight { padding-top:14px; gap:9px; }
  .mthread.tight p { font-size:13px; margin:0; color:#000; }
  .mbubble { align-self:flex-end; background:#efefee; border-radius:10px; padding:10px 12px; font-size:13px; color:#000; max-width:82%; }
  .mrow { display:flex; align-items:flex-start; gap:8px; font-size:12px; }
  .mrow .l { color:rgba(0,0,0,0.5); }
  .mcheck { width:16px; height:16px; border-radius:50%; background:rgba(41,201,105,0.15); color:#1aa64f; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
  .mspin2 { width:16px; height:16px; border-radius:50%; background:rgba(0,0,0,0.06); display:flex; align-items:center; justify-content:center; flex-shrink:0; }
  .mspin2 i { display:block; width:9px; height:9px; border:1.4px solid rgba(0,0,0,0.2); border-top-color:rgba(0,0,0,0.5); border-radius:50%; animation:sp .8s linear infinite; }
  .composer-pad { padding:13px 15px 15px; }
  .mcomposer { display:flex; align-items:center; justify-content:space-between; border:1px solid rgba(0,0,0,0.15); border-radius:8px; padding:9px 12px; font-size:13px; color:rgba(0,0,0,0.35); }


  @media (prefers-reduced-motion: reduce) {
    .grad,
    .gfxwrap,
    .panelwrap,
    .gfx,
    .panel {
      transition-duration:.12s !important;
      animation-duration:.12s !important;
    }

    .gfx.enter-left,
    .gfx.enter-right,
    .gfx.out-left,
    .gfx.out-right {
      transform:none;
    }

    .spin,
    .mspin2 i,
    .caret {
      animation:none !important;
    }

    .spin,
    .mspin2 i {
      border-top-color:currentColor;
      transform:none;
    }

    .caret {
      opacity:1;
    }

    .pbar {
      transition:none;
    }
  }
</style>
