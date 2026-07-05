<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { getCurrentWindow } from '@tauri-apps/api/window';
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
    type AiTools,
  } from '../../lib/onboarding-summary';
  import {
    allSettled,
    buildInitialStages,
    buildStagesFromManifest,
    friendlySetupBands,
    isContentRetryEligible,
    isStageSkipEligible,
    resumeStartStageFromManifest,
    setStageStatus,
    setupCompletionResult,
    setupProgressPercent,
    stageCommandInvocations,
    stageSkipThresholdMs,
    stageTimeoutMs,
    StageTimeoutError,
    STAGE_ORDER,
    withTimeout,
    type FailedStageDetail,
    type InstallManifest,
    type StageId,
    type StageState,
  } from '../../lib/onboarding-setup';
  import { postOptIn } from '../../lib/onboarding-telemetry';
  import {
    createWizardRouter,
    markSetupStepCompleted,
    WIZARD_STEPS,
  } from '../../lib/onboarding-wizard';

  interface Props {
    initialStep: number;
    onfinish?: () => void | Promise<void>;
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

  type ActiveStageControl = {
    runId: number;
    stageId: StageId;
    skip: () => void;
    retry: () => void;
    skipped: boolean;
  };

  const RING_CIRCUMFERENCE = 2 * Math.PI * 52;
  const FADE_OUT_MS = 320;
  const DEFAULT_STEP = WIZARD_STEPS[0].index;

  let { initialStep, onfinish }: Props = $props();

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

  let telemetryEnabled = $state(true);
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
  let skipReadyStage = $state<StageId | null>(null);
  let activeStageControl: ActiveStageControl | null = null;
  let contentProgress = $state<ContentProgressPayload | null>(null);
  let contentRetryInFlight = $state(false);
  let stagingSource = $state(false);
  let stagingSourceSaving = $state(false);
  let setupFailures = $state<FailedStageDetail[]>([]);
  const activeInstallHandles = new Set<string>();
  const activeContentHandles = new Set<string>();

  let aiTools = $state<AiTools | null>(null);
  let detectionFailed = $state(false);
  let probeInFlight = false;
  let detectorMounted = false;
  let launching = $state<'claude' | 'codex' | null>(null);
  let launchError = $state<string | null>(null);
  let revealError = $state<string | null>(null);
  let showManualTools = $state(false);
  let revealingFolder = $state(false);
  let commandCopied = $state(false);
  let pathCopied = $state(false);
  let importPromptCopied = $state(false);

  const displayPath = $derived(
    resolvedPath ? friendlyPath(resolvedPath, homeDir) : 'Resolving ~/hq...',
  );
  const installDisplayPath = $derived(
    installPath ? friendlyPath(installPath, homeDirFromDefaultHqPath(installPath)) : '~/hq',
  );
  const directoryButtonLabel = $derived(directoryBusy ? 'Checking…' : 'Choose…');
  const topHeight = $derived(currentStep >= 4 ? '240px' : '200px');
  const settledCount = $derived(
    stages.filter((stage) => stage.status === 'ok' || stage.status === 'failed')
      .length,
  );
  const currentStageId = $derived(
    stages.find((stage) => stage.status === 'running')?.id ?? null,
  );
  const contentStage = $derived(
    stages.find((stage) => stage.id === 'content') ?? null,
  );
  const contentRetryEligible = $derived(
    isContentRetryEligible({
      contentStage,
      activeStageId: currentStageId,
      progress: contentProgress,
      retrying: contentRetryInFlight,
    }),
  );
  const stagingToggleDisabled = $derived(
    stagingSourceSaving || contentStage?.status === 'ok',
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
  const currentStage = $derived(
    currentStageId ? stages.find((stage) => stage.id === currentStageId) : null,
  );
  const setupErrorStages = $derived(stages.filter((stage) => stage.error));
  const needsAttention = $derived(setupFailures.length > 0);
  const manualCommand = $derived(readyCommandFor(installPath, aiTools));
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
    if (currentStep !== 2 || setupStarted) return;
    setupStarted = true;
    void startSetupRun();
  });

  $effect(() => {
    if (aiTools?.any !== false || currentStep < 3) return;
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

  $effect(() => {
    const activeId = currentStageId;
    const done = setupDone;
    skipReadyStage = null;

    if (done || activeId === null) return;

    const startedAt = Date.now();
    const threshold = stageSkipThresholdMs(activeId);
    const timeout = window.setTimeout(() => {
      if (
        isStageSkipEligible({
          activeStageId: currentStageId,
          stageId: activeId,
          elapsedMs: Date.now() - startedAt,
          setupDone,
        })
      ) {
        skipReadyStage = activeId;
      }
    }, threshold);

    return () => {
      window.clearTimeout(timeout);
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
      const win = getCurrentWindow();
      await win.show();
      await win.setFocus();
    } catch (err) {
      console.warn('[onboarding-signin] failed to refocus window:', err);
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
        void postOptIn({ enabled: telemetryEnabled });
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
    activeStageControl = null;
    skipReadyStage = null;
    contentProgress = null;
    contentRetryInFlight = false;
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

  function normalizeContentProgress(
    payload: ContentProgressPayload,
  ): ContentProgressPayload {
    const total = payload.totalBytes ?? null;
    const received = payload.receivedBytes ?? null;
    const percent =
      typeof payload.percent === 'number'
        ? Math.max(0, Math.min(100, Math.round(payload.percent)))
        : total && total > 0 && typeof received === 'number'
          ? Math.max(0, Math.min(100, Math.round((received / total) * 100)))
          : null;
    return {
      ...payload,
      receivedBytes: received,
      totalBytes: total,
      percent,
    };
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

    contentProgress = normalizeContentProgress(payload);

    if (handle && payload.phase === 'complete') {
      activeContentHandles.delete(handle);
    }
  }

  async function listenForProgress(runId: number): Promise<void> {
    const unlisten = await listen<InstallProgressPayload>(
      'install:progress',
      (event) => trackInstallProgress(runId, event.payload),
    );
    if (!isCurrentRun(runId)) {
      unlisten();
      return;
    }
    unlistenInstallProgress = unlisten;

    const unlistenContent = await listen<ContentProgressPayload>(
      'content:progress',
      (event) => trackContentProgress(runId, event.payload),
    );
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

  async function loadStagingSource(): Promise<void> {
    if (typeof invoke !== 'function') return;
    try {
      stagingSource = Boolean(await invoke<boolean>('get_staging_source'));
    } catch {
      stagingSource = false;
    }
  }

  async function handleToggleStagingSource(): Promise<void> {
    if (stagingToggleDisabled || typeof invoke !== 'function') return;
    const next = !stagingSource;
    stagingSource = next;
    stagingSourceSaving = true;
    let saved = false;
    try {
      stagingSource = Boolean(
        await invoke<boolean>('set_staging_source', { enabled: next }),
      );
      saved = true;
    } catch (err) {
      stagingSource = !next;
      console.error('Failed to save staging source:', err);
    } finally {
      stagingSourceSaving = false;
    }
    if (saved && currentStageId === 'content' && activeStageControl?.stageId === 'content') {
      retryActiveContentStage(activeStageControl);
    }
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

  type StageRunOutcome = 'ok' | 'failed' | 'cancelled' | 'retry';

  async function runStage(id: StageId, runId: number): Promise<StageRunOutcome> {
    if (!isCurrentRun(runId)) return 'cancelled';
    stages = setStageStatus(stages, id, 'running');
    if (id === 'content') contentProgress = null;
    await journalStageStart(id);

    let skipStage!: () => void;
    let retryStage!: () => void;
    const controlPromise = new Promise<'skipped' | 'retry'>((resolve) => {
      skipStage = () => resolve('skipped');
      retryStage = () => resolve('retry');
    });
    const control: ActiveStageControl = {
      runId,
      stageId: id,
      skip: skipStage,
      retry: retryStage,
      skipped: false,
    };
    activeStageControl = control;

    const workPromise = invokeStageCommand(id, runId).then(
      () => ({ kind: 'done' as const }),
      (err) => ({ kind: 'failed' as const, err }),
    );
    const result = await Promise.race([
      workPromise,
      controlPromise.then((kind) => ({ kind })),
    ]);

    if (activeStageControl === control) {
      activeStageControl = null;
    }

    if (!isCurrentRun(runId)) return 'cancelled';

    if (result.kind === 'retry') {
      stages = setStageStatus(stages, id, 'pending');
      if (id === 'content') contentProgress = null;
      return 'retry';
    }

    if (result.kind === 'skipped') {
      const message = 'Skipped after timeout';
      stages = setStageStatus(stages, id, 'failed', message);
      await journalStageFailure(id, message);
      return 'failed';
    }

    if (control.skipped) return 'cancelled';
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

  async function runSetup(runId: number, startStage: StageId = STAGE_ORDER[0]) {
    const startIndex = Math.max(0, STAGE_ORDER.indexOf(startStage));
    for (const id of STAGE_ORDER.slice(startIndex)) {
      if (!isCurrentRun(runId)) return;
      let outcome: StageRunOutcome;
      do {
        outcome = await runStage(id, runId);
      } while (outcome === 'retry' && isCurrentRun(runId));
      if (outcome === 'cancelled') return;
      if (id === 'content' && outcome === 'failed') {
        skipReadyStage = null;
        return;
      }
      if (isCurrentRun(runId)) {
        skipReadyStage = null;
      }
    }

    if (isCurrentRun(runId) && !setupCompleted && allSettled(stages)) {
      setupCompleted = true;
      const result = setupCompletionResult(stages);
      setupFailures = result.failedStages;
      markSetupStepCompleted();
      await journalInstallComplete();
      advanceTo(3);
    }
  }

  async function startSetupRun() {
    const runId = beginSetupRun();
    if (installPath) effectiveInstallPath = installPath;
    await listenForProgress(runId);
    await loadStagingSource();
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

  function handleSkipCurrentStage(stageId: StageId) {
    const control = activeStageControl;
    if (!control || control.stageId !== stageId || stageId !== currentStageId) {
      return;
    }
    control.skipped = true;
    skipReadyStage = null;
    void cancelForegroundWork(control.runId);
    control.skip();
  }

  function retryActiveContentStage(control: ActiveStageControl) {
    contentRetryInFlight = true;
    skipReadyStage = null;
    void cancelActiveContentHandles(control.runId).finally(() => {
      contentRetryInFlight = false;
    });
    control.retry();
  }

  function handleRetryContentStage() {
    if (!contentRetryEligible || contentRetryInFlight) return;
    const control = activeStageControl;
    if (control && control.stageId === 'content' && currentStageId === 'content') {
      retryActiveContentStage(control);
      return;
    }

    if (currentStageId !== null) return;
    contentRetryInFlight = true;
    void runSetup(currentRunId, 'content').finally(() => {
      contentRetryInFlight = false;
    });
  }

  function formatBytes(bytes: number | null | undefined): string {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
      return '';
    }
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = units[0];
    for (let i = 1; i < units.length && value >= 1024; i += 1) {
      value /= 1024;
      unit = units[i];
    }
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
  }

  function contentProgressText(): string | null {
    if (!contentProgress) return null;
    if (contentProgress.message) {
      if (typeof contentProgress.percent === 'number') {
        return `${contentProgress.message} (${contentProgress.percent}%)`;
      }
      return contentProgress.message;
    }
    const prefix =
      contentProgress.phase === 'extract' ? 'Extracting template' : 'Downloading template';
    if (typeof contentProgress.percent === 'number') {
      return `${prefix} (${contentProgress.percent}%)`;
    }
    const received = formatBytes(contentProgress.receivedBytes);
    return received ? `${prefix} (${received})` : prefix;
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
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard failures are silent; the value stays visible and selectable.
    }
  }

  async function handleCopyCommand() {
    await copyText(manualCommand, (value) => (commandCopied = value));
  }

  async function handleCopyPath() {
    await copyText(installPath ?? '~/hq', (value) => (pathCopied = value));
  }

  async function handleCopyImportPrompt() {
    await copyText('/import-claude', (value) => (importPromptCopied = value));
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
    try {
      const tools = await ensureAiTools();
      if (tools.claude_desktop) {
        const url = buildClaudeCodeUrl({
          folder: installPath ?? '',
          prompt: '/setup',
        });
        await invoke('open_claude_code_link', { url });
        advanceTo(4);
        return;
      }
      if (tools.claude_cli && installPath) {
        await invoke('launch_claude_code', { path: installPath });
        advanceTo(4);
        return;
      }
      launchError =
        'Claude Code was not detected. Continue with the folder and /setup prompt shown here.';
      showManualTools = true;
      advanceTo(4);
    } catch (err) {
      const msg = errorMessage(err);
      launchError = `Could not open Claude Code: ${msg}`;
      showManualTools = true;
      if (/Unable to find application|not installed|not found|missing/i.test(msg)) {
        aiTools = markToolUnavailable(aiTools, 'claude_desktop');
        advanceTo(4);
      }
    } finally {
      launching = null;
    }
  }

  async function handleLaunchCodex() {
    launchError = null;
    revealError = null;
    launching = 'codex';
    try {
      const tools = await ensureAiTools();
      if (tools.codex_cli && installPath) {
        await invoke('launch_cli_in_terminal', {
          path: installPath,
          tool: 'codex',
        });
        advanceTo(4);
        return;
      }
      launchError =
        'Codex CLI was not detected. Continue and open this HQ folder manually from Codex.';
      showManualTools = true;
      advanceTo(4);
    } catch (err) {
      const msg = errorMessage(err);
      launchError = `Could not open Codex: ${msg}`;
      showManualTools = true;
      aiTools = markToolUnavailable(aiTools, 'codex_cli');
      if (/not installed|not found|missing/i.test(msg)) advanceTo(4);
    } finally {
      launching = null;
    }
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
      contentProgress = null;
    }

    panelOn = false;
    const delay = reducedMotion ? 120 : FADE_OUT_MS;

    void runMorph(previous, next, token).then((handled) => {
      if (handled) return;
      const slide = previous >= 4 && next >= 4 && !reducedMotion;
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
          {@render BigCheck()}
        </div>

        <div
          class="gfx gtop"
          class:on={graphicIsOn(4)}
          class:enter-left={graphicStep === 4 && incomingGraphicDirection === 'left'}
          class:enter-right={graphicStep === 4 && incomingGraphicDirection === 'right'}
          class:out-left={outgoingGraphicStep === 4 && outgoingGraphicDirection === 'left'}
          class:out-right={outgoingGraphicStep === 4 && outgoingGraphicDirection === 'right'}
          data-g="4"
        >
          {@render TrustMock()}
        </div>

        <div
          class="gfx"
          class:on={graphicIsOn(5)}
          class:enter-left={graphicStep === 5 && incomingGraphicDirection === 'left'}
          class:enter-right={graphicStep === 5 && incomingGraphicDirection === 'right'}
          class:out-left={outgoingGraphicStep === 5 && outgoingGraphicDirection === 'left'}
          class:out-right={outgoingGraphicStep === 5 && outgoingGraphicDirection === 'right'}
          data-g="5"
        >
          {@render SettingsMock()}
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
          {@render SetupPromptMock()}
        </div>

        <div
          class="gfx gtop"
          class:on={graphicIsOn(7)}
          class:enter-left={graphicStep === 7 && incomingGraphicDirection === 'left'}
          class:enter-right={graphicStep === 7 && incomingGraphicDirection === 'right'}
          class:out-left={outgoingGraphicStep === 7 && outgoingGraphicDirection === 'left'}
          class:out-right={outgoingGraphicStep === 7 && outgoingGraphicDirection === 'right'}
          data-g="7"
        >
          {@render HandoffMock()}
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
          <label class="check-row">
            <span class="check" class:on={telemetryEnabled}>
              <input
                type="checkbox"
                bind:checked={telemetryEnabled}
                aria-label="Share anonymous usage data to help make HQ better"
              />
              <span class="checkmark" aria-hidden="true">{@render CheckTiny()}</span>
            </span>
            <span>Share anonymous usage data to help make HQ better</span>
          </label>
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
          <div class="setup-compact" aria-live="polite">
            <div class="setup-row">
              <span>{overallPercent}% · {settledCount} of {STAGE_ORDER.length} stages</span>
              {#if currentStage}
                <span class="stage-pill">{currentStage.label}</span>
              {/if}
            </div>
            {#if contentProgressText()}
              <p class:slow={contentProgress?.slow || contentProgress?.stalled} class="setup-detail">
                {contentProgressText()}
              </p>
            {/if}
            <div class="setup-actions">
              <button
                type="button"
                class="mini-switch"
                class:active={stagingSource}
                disabled={stagingToggleDisabled}
                onclick={handleToggleStagingSource}
                role="switch"
                aria-checked={stagingSource}
              >
                <span aria-hidden="true"></span>
                Staging template
              </button>
              {#if skipReadyStage}
                <button
                  type="button"
                  class="mini-link"
                  onclick={() => skipReadyStage && handleSkipCurrentStage(skipReadyStage)}
                >
                  Skip slow step
                </button>
              {/if}
              {#if contentRetryEligible}
                <button type="button" class="mini-link" onclick={handleRetryContentStage}>
                  Retry template
                </button>
              {/if}
            </div>
            {#if setupErrorStages.length > 0}
              <p class="setup-detail error">
                {setupErrorStages[0].label}: {setupErrorStages[0].error}
              </p>
            {/if}
          </div>
          <div class="btns">
            <button class="btn btn-secondary" type="button" onclick={() => goBackTo(1)}>Back</button>
          </div>
        </section>

        <section
          class="panel"
          class:on={panelStep === 3 && panelOn}
          data-p="3"
          data-testid="onboarding-summary"
          aria-labelledby="onboarding-title-ready"
        >
          <h2 class="h" id="onboarding-title-ready">HQ is ready</h2>
          <p class="body">HQ now lives in your menubar and keeps everything in sync. Open it in your favorite AI tool to start working.</p>
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
          {#if manualToolsVisible}
            <div class="manual-tools" aria-label="Manual setup options">
              <button type="button" onclick={handleRevealFolder} disabled={revealingFolder}>
                {revealingFolder ? 'Revealing…' : 'Reveal folder'}
              </button>
              <button type="button" onclick={handleCopyPath}>{pathCopied ? 'Path copied' : 'Copy path'}</button>
              <button type="button" onclick={handleCopyCommand}>{commandCopied ? 'Command copied' : 'Copy command'}</button>
              <button type="button" onclick={handleCopyImportPrompt}>{importPromptCopied ? 'Import copied' : 'Copy /import-claude'}</button>
            </div>
          {/if}
          <div class="btns">
            <button
              class="btn btn-primary"
              type="button"
              disabled={launching !== null}
              onclick={handleLaunchClaudeCode}
            >
              {launching === 'claude' ? 'Opening…' : 'Open in Claude Code'}
            </button>
            <button
              class="btn btn-secondary"
              type="button"
              disabled={launching !== null}
              onclick={handleLaunchCodex}
            >
              {launching === 'codex' ? 'Opening…' : 'Open in Codex'}
            </button>
          </div>
        </section>

        <section
          class="panel"
          class:on={panelStep === 4 && panelOn}
          data-p="4"
          data-testid="onboarding-trust"
          aria-labelledby="onboarding-title-trust"
        >
          <h2 class="h" id="onboarding-title-trust">Trust your workspace</h2>
          <p class="body">Claude Code will open with your hq folder selected and /setup ready to run. Choose “Yes, trust this workspace.” Just check that hq is still the folder it’s pointing at.</p>
          <div class="btns split"><button class="btn btn-secondary" type="button" onclick={() => goBackTo(3)}>Back</button><button class="btn btn-primary" type="button" onclick={() => advanceTo(5)}>Continue</button></div>
        </section>

        <section
          class="panel"
          class:on={panelStep === 5 && panelOn}
          data-p="5"
          data-testid="onboarding-settings"
          aria-labelledby="onboarding-title-settings"
        >
          <h2 class="h" id="onboarding-title-settings">Dial in your settings</h2>
          <p class="body">For the best results, use the latest models (Opus 4.8 or GPT-5.5), set thinking to “High” or above, and turn on auto mode (bypass permissions). You might need to flip that last one on in settings.</p>
          <div class="btns split"><button class="btn btn-secondary" type="button" onclick={() => goBackTo(4)}>Back</button><button class="btn btn-primary" type="button" onclick={() => advanceTo(6)}>Continue</button></div>
        </section>

        <section
          class="panel"
          class:on={panelStep === 6 && panelOn}
          data-p="6"
          data-testid="onboarding-run-setup"
          aria-labelledby="onboarding-title-run-setup"
        >
          <h2 class="h" id="onboarding-title-run-setup">Press enter to run /setup</h2>
          <p class="body">Hit ⏎ in the message box to start setup.</p>
          <div class="btns split"><button class="btn btn-secondary" type="button" onclick={() => goBackTo(5)}>Back</button><button class="btn btn-primary" type="button" onclick={() => advanceTo(7)}>Continue</button></div>
        </section>

        <section
          class="panel"
          class:on={panelStep === 7 && panelOn}
          data-p="7"
          data-testid="onboarding-handoff"
          aria-labelledby="onboarding-title-handoff"
        >
          <h2 class="h" id="onboarding-title-handoff">Answer, then run /handoff</h2>
          <p class="body">Work through every question until it says setup is finished, then send “/handoff” to save everything to HQ’s memory. You’ll do this at the end of every session.</p>
          <div class="btns split"><button class="btn btn-secondary" type="button" onclick={() => goBackTo(6)}>Back</button><button class="btn btn-primary" type="button" onclick={() => advanceTo(8)}>Continue</button></div>
        </section>

        <section
          class="panel"
          class:on={panelStep === 8 && panelOn}
          data-p="8"
          data-testid="onboarding-build"
          aria-labelledby="onboarding-title-build"
        >
          <h2 class="h" id="onboarding-title-build">Open a fresh session and build</h2>
          <p class="body">Start with “/brainstorm” to get going. Working on a specific company? Send “/startwork acme” and describe what you want. Then it’s the same rhythm every time: start work, handoff, repeat.</p>
          <div class="btns split"><button class="btn btn-secondary" type="button" onclick={() => goBackTo(7)}>Back</button><button class="btn btn-primary" type="button" onclick={() => void onfinish?.()}>Done</button></div>
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
      <svg width="22" height="28" viewBox="0 0 17 22" fill="none" class="cursor"><path d="M2 1.5 2 16.8 6.1 12.9 8.8 19 11.2 17.9 8.5 11.9 13.8 11.6Z" fill="#1d1d1f" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>
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
    height:100vh;
    min-height:100vh;
    overflow:hidden;
    background:transparent;
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
  .scaler { transform:scale(1); transform-origin:center; }
  .window { width:640px; height:460px; border-radius:var(--radius-card); overflow:hidden; background:var(--c-bg); box-shadow:var(--shadow-window-light); position:relative; --toph:200px; }

  @media (prefers-color-scheme: dark) {
    .window { box-shadow:var(--shadow-window-dark); }
  }

  :global(.dark) .window { box-shadow:var(--shadow-window-dark); }

  .drag-strip { position:absolute; top:0; left:0; right:0; height:28px; z-index:8; }
  .grad { position:absolute; top:0; left:0; right:0; height:var(--toph); background:#a98bd8 var(--onboarding-bg-url) center/cover no-repeat; transition:height .55s cubic-bezier(.65,0,.35,1); z-index:0; }
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
  .panel { position:absolute; inset:0; padding:24px; display:flex; flex-direction:column; opacity:0; pointer-events:none; transition:opacity .3s ease; }
  .panel.on { opacity:1; pointer-events:auto; }

  .h { color:var(--c-text); font-size:24px; font-weight:600; line-height:32px; margin:0; letter-spacing:-1px; }
  .body { color:var(--c-muted); font-size:14px; font-weight:400; line-height:20px; margin:4px 0 0; max-width:592px; }
  .check-row { display:flex; align-items:center; gap:8px; margin-top:16px; cursor:pointer; }
  .check { position:relative; width:16px; height:16px; border-radius:4px; border:1px solid var(--check-border); background:transparent; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition:background-color .12s, border-color .12s; }
  .check.on { background:var(--check-bg); border-color:var(--check-bg); }
  .check input { position:absolute; inset:0; width:16px; height:16px; opacity:0; cursor:pointer; }
  .check svg { width:10px; height:10px; stroke:var(--check-fg); }
  .checkmark { display:grid; place-items:center; opacity:0; }
  .check input:checked + .checkmark { opacity:1; }
  .check-row span:last-child { color:var(--c-muted); font-size:14px; line-height:20px; }
  .btns { display:flex; gap:8px; margin-top:auto; }
  .btns.split { justify-content:space-between; }
  .btn { font-family:inherit; font-size:14px; font-weight:400; line-height:20px; padding:10px 16px; border-radius:8px; border:none; cursor:pointer; transition:opacity .15s, transform .1s; }
  .btn:active:not(:disabled) { transform:scale(.97); }
  .btn-primary { background:var(--c-btn-bg); color:var(--c-btn-fg); }
  .btn-secondary { background:var(--c-btn2-bg); color:var(--c-btn2-fg); }
  .btn:hover:not(:disabled) { opacity:.88; }
  .btn:disabled { cursor:not-allowed; opacity:.48; }

  .inline-note { margin:10px 0 0; color:var(--c-muted); font-size:12px; line-height:16px; }
  .inline-note.error { color:#d04444; }
  .inline-note.warning { color:var(--c-text); }

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
  .loc .mf { width:40px; height:40px; object-fit:contain; flex-shrink:0; display:block; }
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

  .setup-compact { margin-top:10px; display:grid; gap:5px; color:var(--c-muted); font-size:11.5px; line-height:15px; }
  .setup-row, .setup-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .setup-row { justify-content:space-between; }
  .stage-pill { max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--c-text); }
  .setup-detail { margin:0; color:var(--c-muted); }
  .setup-detail.slow, .setup-detail.error { color:var(--c-text); }
  .setup-actions button { font-family:inherit; font-size:11.5px; }
  .mini-switch { display:inline-flex; align-items:center; gap:5px; border:0; border-radius:999px; color:var(--c-muted); background:var(--c-btn2-bg); padding:3px 8px; cursor:pointer; }
  .mini-switch span { width:14px; height:8px; border-radius:999px; background:var(--check-border); position:relative; }
  .mini-switch span::after { content:''; position:absolute; top:1px; left:1px; width:6px; height:6px; border-radius:50%; background:var(--c-bg); transition:transform .12s; }
  .mini-switch.active span::after { transform:translateX(6px); }
  .mini-switch:disabled { opacity:.45; cursor:not-allowed; }
  .mini-link { border:0; padding:0; background:transparent; color:var(--c-text); cursor:pointer; text-decoration:underline; text-underline-offset:2px; }

  .manual-tools { display:flex; flex-wrap:wrap; gap:6px; margin-top:12px; }
  .manual-tools button { appearance:none; border:0.5px solid var(--c-field-border); border-radius:6px; background:var(--c-btn2-bg); color:var(--c-muted); font:inherit; font-size:11.5px; line-height:15px; padding:4px 7px; cursor:pointer; }
  .manual-tools button:hover:not(:disabled) { color:var(--c-text); }
  .manual-tools button:disabled { opacity:.5; cursor:not-allowed; }

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
  .trust-options .selected { border:1px solid rgba(43,127,255,0.3); background:rgba(43,127,255,0.08); border-radius:6px; color:rgba(0,0,0,0.85); }
  .chip-row { display:flex; gap:6px; margin-top:8px; }
  .mchip { display:inline-flex; align-items:center; gap:4px; border:1px solid rgba(0,0,0,0.1); border-radius:7px; padding:3px 8px; font-size:11px; color:rgba(0,0,0,0.7); }
  .mchip-sep { margin:0 3px; color:rgba(0,0,0,0.2); }
  .worktree-dot { width:9px; height:9px; border-radius:2px; background:rgba(0,0,0,0.25); display:inline-block; }
  .composer-preview { display:flex; align-items:center; border:1px solid rgba(0,0,0,0.12); border-radius:11px; padding:10px 13px; }
  .composer-preview span:first-child { font-size:13px; color:rgba(0,0,0,0.4); }
  .return-icon { margin-left:auto; color:rgba(0,0,0,0.3); display:inline-flex; align-items:center; }
  .settings-preview { display:flex; justify-content:space-between; align-items:center; font-size:11px; color:rgba(0,0,0,0.5); }
  .settings-preview > span { display:flex; align-items:center; gap:9px; }
  .auto-pill { background:rgba(202,165,61,0.16); color:#9a7a1c; border-radius:5px; padding:2px 7px; font-weight:500; }
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
  }
</style>
