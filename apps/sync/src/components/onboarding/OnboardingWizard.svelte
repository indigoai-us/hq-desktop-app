<script lang="ts">
  import RailIcon from '@hq/ui/rail-icon';
  import {
    FIRST_RUN_TIMING_TAG,
    createScreenTimer,
    startInstallTimer,
    type InstallTimer,
  } from '@hq/ui/first-run-timing';
  import {
    INSTALL_QUEUE_PROGRESS_EVENT,
    parseInstallQueueStatus,
    type InstallQueueStatus,
  } from '@hq/ui/finishing-setup';
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { getVersion } from '@tauri-apps/api/app';
  import { safeUnlisten } from '../../lib/listener-registry';
  import { open as openExternal } from '@tauri-apps/plugin-shell';
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import '../../styles/design-system.css';
  import './welcome/welcome.css';
  import { createWelcomeController, type WelcomeController } from './welcome/controller';
  import { FOLDER_ROWS, ORBIT_INNER, RAIL } from './welcome/content';
  import {
    HQ_MARK_H,
    HQ_MARK_Q,
    createConsentEngine,
    createFolderEngine,
    createKeyboardEngine,
    createMarkEngine,
    createOrbitEngine,
    createPanelEngine,
    createReadyEngine,
    keyboardRowsFor,
  } from './welcome/engines';
  import {
    SCENE_HOLD_MS,
    forwardLabel,
    installCardModel,
    createBlockingRetryGate,
    installCardActivityLines,
    isStoryScene,
    previousScene,
    readyProgressLine,
    readyRequiredFailureHeading,
    readyTimings,
    sceneForStep,
    stepForScene,
    storyScenes,
    welcomeChrome,
    welcomeKeyIntent,
    type SceneId,
  } from '../../lib/welcome-flow';
  import {
    deferredConsentGate,
    holdConsentAnswer,
    looksOffline,
    sendHeldConsent,
    shouldDeferConsent,
    type DeferredConsent,
  } from '../../lib/deferred-consent';
  import {
    appendChildFolderPath,
    friendlyPath,
    homeDirFromDefaultHqPath,
  } from '../../lib/onboarding-path';
  import { mapSignInError, type SignInProvider } from '../../lib/onboarding-signin';
  import {
    continuationDeps,
    loadContinuationContext,
    loadInstallAttemptId,
    type ContinuationContext,
  } from '../../lib/desktop-continuation-tauri';
  import { resolveFirstLaunchJoinKey } from '../../lib/desktop-first-launch-join-key';
  import {
    classifyContinuationError,
    flushReceipts,
    FIRST_LAUNCH_DOWNLOAD_JOIN_FLAG,
    launchReceipt,
    progressReceipt,
    recordReceipt,
    shouldSendFirstLaunchReceipt,
    type ContinuationOutcome,
  } from '../../lib/desktop-session-continuation';
  import { NO_AI_TOOLS, type AiTools } from '../../lib/onboarding-summary';
  import {
    activeStageId,
    allSettled,
    buildInitialStages,
    buildStagesFromManifest,
    countSettledStages,
    createSetupProgressTracker,
    friendlySetupBands,
    contentProgressSubStatus,
    resetSetupProgressTracker,
    setupRetryAttempt,
    setupRetrySubStatusText,
    setupSubStatus,
    stageCreepAt,
    trackSetupProgress,
    createSetupRunId,
    normalizeFailedStageIds,
    reuseInFlightOperation,
    resumeStartStageFromManifest,
    setStageStatus,
    setupCompletionResult,
    depsRetryWasAttemptedForFailure,
    depsTimeoutRetryTelemetry,
    setupProgressPercent,
    setupStageRecoveryAction,
    resolveFlagStatusWithTimeout,
    resolveFlagWithTimeout,
    stageCommandInvocations,
    stageTimeoutMs,
    setupFailureTelemetryDetails,
    StageTimeoutError,
    SETUP_TIMEOUT_NATIVE_SETTLE_TIMEOUT_MS,
    withProgressTimeout,
    partitionStages,
    BLOCKING_STAGES,
    STAGE_ORDER,
    withTimeout,
    type InstallManifest,
    type SetupRetryAttempt,
    type DepsTimeoutRetryFlagStatus,
    type DepsRetryResult,
    type SetupStageRecoveryAction,
    type StageId,
    type StageState,
    setupActivityPhrase,
  } from '../../lib/onboarding-setup';
  import {
    openHqShortcutChord,
    readOnboardingHostOs,
    setupExpectationCopy,
    shortcutKeyboardLayoutFor,
    thisComputerNounFor,
    yourComputerNounFor,
  } from '../../lib/onboarding-platform';
  import { postOptIn, markConsentRepromptShown } from '../../lib/onboarding-telemetry';
  import {
    emitDesktopAuthFailure,
    emitDesktopAuthProgress,
    emitDesktopOperationalTelemetry,
    type DesktopAuthProgressStep,
  } from '../../lib/desktop-telemetry';
  import { inviteFailedEvent, inviteSentEvent } from '../../lib/cdp-funnel-events';
  import {
    createOnboardingStepTelemetry,
    type InviteStepHiddenReason,
    type OnboardingAction,
    type OnboardingFlow,
    type RecordOnboardingStep,
  } from '../../lib/onboarding-step-telemetry';
  import {
    BUILD_STEP_INDEX,
    CONNECTOR_IMPORT_STEP_INDEX,
    CONSENT_STEP_INDEX,
    FIRST_FOLDER_SYNC_STEP_INDEX,
    INVITE_TEAMMATE_STEP_INDEX,
    type WizardMode,
    createWizardRouter,
    DIRECTORY_STEP_INDEX,
    HANDOFF_STEP_INDEX,
    markSetupStepCompleted,
    READY_STEP_INDEX,
    RUN_SETUP_STEP_INDEX,
    SETTINGS_STEP_INDEX,
    SETUP_STEP_INDEX,
    TRUST_STEP_INDEX,
    WELCOME_SIGNIN_STEP_INDEX,
    WIZARD_STEPS,
  } from '../../lib/onboarding-wizard';
  import { TELEMETRY_CONSENT_VERSION } from '../../lib/consent-version';
  import { startTraySync } from '../../lib/traySync';
  import ConnectorImportStep from './ConnectorImportStep.svelte';
  import {
    companyUidFromMissingBucket,
    decideCompanyRoute,
    isMissingBucketMessage,
    summarizeRoute,
    type CompanyRouteSummary,
  } from '../../lib/onboarding-company-route';
  import {
    MEMBERSHIP_ME_WITH_HISTORY_URL,
    requestCompanyProvisioning,
    resolveAccountKind,
    resolveFirstRunCompanyRoute,
    waitForProvisioning,
    type FirstRunCompanyPath,
  } from '../../lib/first-run-company';
  import type { AccountKind } from '../../lib/onboarding-company-route';
  import {
    initialPullRows,
    pullFailures,
    pullSettled,
    pullSucceeded,
    runCompanyPull,
    type CompanyPullRow,
    type CompanyPullRunResult,
  } from '../../lib/company-pull';
  import {
    createSyncPlatformAdapter,
    getHqAnywherePersonSetting,
    hqAnywhereRuntimeEnabled as resolveHqAnywhereRuntimeEnabled,
    putHqAnywherePersonSetting,
    setHqAnywhereGlobalRuntime,
    FIRST_LAUNCH_JOIN_KEY_FLAG,
    COMPANY_ROUTE_LOOKUP_RETRY_FLAG,
    FIRST_FOLDER_SYNC_STEP_FLAG,
    SETUP_DEPS_TIMEOUT_RETRY_FLAG,
    retryThrottled,
  } from '@hq/platform';
  import { markPostReadyActionReady } from '../../lib/post-ready-action-telemetry';
  import {
    recordFirstLaunchSignInReachOutcome,
  } from '../../lib/first-launch-signin-reach-telemetry';
  import { resolveFirstLaunchPublicFlag } from '../../lib/first-launch-public-flag';
  import {
    classifyInviteError,
    hqProErrorCode,
    HqProRequestError,
    inviteErrorMessage,
    isAlreadyExists,
    type InviteErrorKind,
    type InviteFailure,
  } from '../../lib/onboarding-invite';

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
    /**
     * `'replay'` is the menu-bar "Replay welcome intro": the four story screens
     * only (welcome, folder, cloud, shortcut) with Next / Done. No sign-in,
     * folder choice, install, consent or telemetry; `onfinish` when it ends.
     */
    mode?: WizardMode | 'replay';
    onboardingFlow?: OnboardingFlow;
    /** A completed install with a missing root must not resume its old manifest. */
    recoveringMissingRoot?: boolean;
    /** The `prs_*` the re-prompt is keyed to (reprompt mode only). */
    repromptPersonUid?: string | null;
    /**
     * The person's desktop wallpaper as an image URL (`Onboarding.svelte`
     * reads it natively). Painted full-bleed behind the flow, where the veil
     * blurs and dims it. `null` means the window is transparent over the
     * native behind-window blur instead.
     */
    wallpaper?: string | null;
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
    line?: string;
    finished?: boolean;
    setupRunId?: string;
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
  const MIN_VISIBLE_MS_FOR_ABANDON = 1500;
  const DEFAULT_STEP: number = WIZARD_STEPS[0].index;
  let {
    initialStep,
    onfinish,
    mode = 'onboarding',
    onboardingFlow = 'first_install',
    recoveringMissingRoot = false,
    repromptPersonUid = null,
    wallpaper = null,
  }: Props = $props();

  const isReprompt = $derived(mode === 'reprompt');
  /**
   * Only the consent step is shown and the wizard closes on the answer: the
   * re-prompt, and an installed machine that just lacks its consent answer.
   */
  const consentOnly = $derived(mode === 'reprompt' || mode === 'consent');
  /** The story screens only, from the menu bar. */
  const replay = $derived(mode === 'replay');
  /**
   * First-run onboarding asks the usage-data question as one checkbox line on
   * the ready screen and records the answer when the person finishes from
   * there. Consent-only runs keep their own blocking consent screen.
   */
  /**
   * This machine's own outpost (machine) identity: whether it has one, and
   * whether that identity is the live session. An outpost is a fleet agent,
   * not a person: it gets no usage-data question, no company to name and no
   * teammate to invite.
   */
  let machineIdentity = $state<{ available: boolean; active: boolean }>({
    available: false,
    active: false,
  });
  /** The live session is this outpost's machine identity (no person entity). */
  let outpostSession = $state(false);
  const consentOnReady = $derived(!consentOnly && !replay && !outpostSession);
  const onboardingTelemetry = createOnboardingStepTelemetry();
  const onboardingFeatureFlags = createSyncPlatformAdapter({
    invoke: (command, args) => invoke(command, args),
  });
  let onboardingIdentityPromise:
    | Promise<{
        context: ContinuationContext | null;
        firstLaunchReceiptRecorded: boolean;
      }>
    | null = null;
  let onboardingIdentityPrepared = false;
  let continuationContextPromise: Promise<ContinuationContext | null> | null = null;
  const manualOAuthReceiptTails = new Map<string, Promise<void>>();
  let firstLaunchStatusKnown: boolean | null = null;
  let firstLaunchJoinKeyEnabled: boolean | null = null;
  let firstLaunchJoinKeyArm: 'on' | 'off' | 'unknown' = 'unknown';
  let firstLaunchJoinKeyFlagPromise: Promise<boolean> | null = null;
  let firstLaunchDownloadJoinFlagPromise: Promise<boolean> | null = null;
  const queuedOnboardingStepRecords: Array<{
    step: number;
    action: OnboardingAction;
    occurredAt: string;
    record: () => void;
  }> = [];

  let activeInitialStep = $state<number | null>(null);
  let router = $state(createWizardRouter());
  let currentStep = $state(DEFAULT_STEP);
  let furthestStep = $state(DEFAULT_STEP);

  // First-run timing lines (format in @hq/ui/first-run-timing). Replay and
  // consent-only runs are not a first run, so they write none.
  function firstRunTimingLog(message: string): void {
    if (replay || consentOnly) return;
    Promise.resolve()
      .then(() => invoke('frontend_log', { tag: FIRST_RUN_TIMING_TAG, message }))
      .catch((error) => console.warn('[first-run] timing line was not written', error));
  }
  const screenTimer = createScreenTimer('welcome', firstRunTimingLog);
  $effect(() => {
    const shown = stepIdFor(currentStep);
    untrack(() => screenTimer.show(shown));
  });
  let reducedMotion = $state(false);

  // ─── Welcome flow screens ───────────────────────────────────────────────
  // The screen on show. The wizard step underneath (`currentStep`) still owns
  // routing, telemetry and resume; the two explainers share the setup step.
  let scene = $state<SceneId>(sceneForStep(DEFAULT_STEP));
  /** The current screen's forward button has arrived (its last beat fired). */
  let navRevealed = $state(false);
  /** Land the next screen on its settled frame (Back into the welcome). */
  let enterSettled = false;
  let veilOn = $state(false);
  /** A screen's motion failed: show every screen settled, without it. */
  let motionFailed = $state(false);
  let chromeBooted = $state(false);
  let welcomeController: WelcomeController | null = null;
  let welcomeRoot: HTMLDivElement | null = $state(null);
  const tickFills: HTMLElement[] = [];
  const refs: Record<string, HTMLElement | null> = {};
  const treeRows: HTMLElement[] = [];
  const railRows: HTMLElement[] = [];
  const innerChips: HTMLElement[] = [];
  const outerChips: HTMLElement[] = [];
  const consentChoices: HTMLElement[] = [];
  const keyEls = new Map<string, HTMLElement>();
  let ringA: SVGEllipseElement | null = null;
  let ringB: SVGEllipseElement | null = null;
  let ringsEl: SVGSVGElement | null = null;
  let coreEl: SVGSVGElement | null = null;
  /** The corner install card fades out a few seconds after the install is done. */
  let installCardRetired = $state(false);
  /** Whether the connector import has been offered in this run. */
  let connectorImportVisited = false;
  /** Whether the optional first-folder sync has been offered in this run. */
  let firstFolderSyncVisited = false;
  /** Whether the optional teammate invite has been offered in this run. */
  let inviteTeammateVisited = false;
  /**
   * The first-folder flag and invite eligibility, read once the blocking
   * phase is done, have settled. The follow-on steps wait for them so the connector import
   * never jumps ahead of a step that turns out to be on.
   */
  let postSetupStepsResolved = $state(false);
  /** The answer given before the install finished, held until it can be sent. */
  let deferredConsent = $state<DeferredConsent | null>(null);

  // The telemetry consent answer is a genuine tri-state: `null` means the
  // person has NOT answered yet. No option is pre-selected, so the consent
  // step's continue action stays disabled until they choose. (It used to be a
  // pre-ticked boolean on the sign-in panel, which biased the choice AND posted
  // the answer before the person entity existed — so the write 404'd and the
  // answer was dropped. Consent is now its own step after setup.)
  // Sharing is the default; the person can still pick "Don't share".
  let telemetryChoice = $state<'share' | 'decline' | null>('share');
  let hqAnywhereRuntimeEnabled = $state(false);
  let hqAnywhereEnabled = $state(false);
  let hqAnywhereSettingLoaded = $state(false);
  let hqAnywhereLoading = $state(false);
  let hqAnywhereSaving = $state(false);
  let hqAnywhereSettingUp = $state(false);
  let hqAnywhereLoadError = $state(false);
  let hqAnywhereSettingError = $state(false);
  let hqAnywhereRetryValue = $state<boolean | null>(null);
  let hqAnywhereSetupRetry = $state(false);
  let hqAnywhereLoadStarted = false;
  let consentSubmitting = $state(false);
  /** The ready screen, with its usage-data checkbox, has been on show. */
  let readyConsentShown = false;
  /**
   * The ready screen's answer is recorded: sent, held for the install, or
   * cached on this machine by an offline person who chose to finish anyway.
   * The checkbox locks once it is, so what it shows is what was recorded.
   */
  let readyConsentRecorded = $state(false);
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
  let microsoftEmail = $state('');
  let microsoftEmailPrompt = $state(false);
  let currentSignInCall = 0;
  let mounted = true;

  // The first-run sign-in screen opens nothing in the browser on its own. A
  // browser opens only when the person clicks a provider button, and those
  // buttons render only once the welcome animation has revealed the sign-in
  // block (or the motion failed and the settled screen shows instead).
  let launchRecorded = false;
  let signInActionsReady = $state(false);
  let onboardingAppVersion =
    typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : 'unknown';
  let onboardingAppVersionResolution: Promise<void> | null = null;
  let currentStepVisibleAt = Date.now();
  let onboardingAbandoned = false;
  let onboardingCompleted = false;

  let installPath = $state<string | null>(null);
  let validatedInstallPath = $state<string | null>(null);
  let resolvedPath = $state<string | null>(null);
  let homeDir = $state<string | null>(null);
  let directoryNotice = $state<Notice | null>(null);
  let directoryBusy = $state(false);
  let directoryCancelled = false;

  let stages = $state<StageState[]>(buildInitialStages());
  let setupCompleted = $state(false);
  let setupStarted = $state(false);
  let showFirstFolderSyncStep = $state(false);
  let showInviteTeammateStep = $state(false);
  /**
   * The company screen this person needs, read once setup completes: `create`
   * or `join` for someone with no company (the website no longer makes one),
   * `existing` or null (lookup failed) to skip it.
   */
  let companyPath = $state<FirstRunCompanyPath | null>(null);
  /** Signed-in email, read once for the signed-in-as notice and invite matching. */
  let signedInEmail = $state<string | null>(null);
  /** A session already on this machine when onboarding opened (old ~/.hq). */
  let existingSessionEmail = $state<string | null>(null);
  /**
   * The outpost session shown on the sign-in screen: the outpost's uid and
   * its owner's email. Never shown as a bare owner email, which would read as
   * the owner being signed in as a person.
   */
  let existingSessionOutpost = $state<{ uid: string | null; ownerEmail: string | null } | null>(null);
  const existingSessionOutpostLabel = $derived.by(() => {
    if (!existingSessionOutpost) return '';
    const { uid, ownerEmail } = existingSessionOutpost;
    if (uid && ownerEmail) return `${uid} · owner ${ownerEmail}`;
    return uid ?? (ownerEmail ? `owner ${ownerEmail}` : 'this machine');
  });
  let existingSessionShownRecorded = false;
  /** Polls left for a machine session minted shortly after launch. */
  let machineSessionPollsLeft = 0;
  let machineSessionPollTimer: ReturnType<typeof setTimeout> | null = null;
  let usingMachineIdentity = $state(false);
  let machineIdentityError = $state<string | null>(null);
  let switchingAccount = $state(false);
  /** First-sync self-heal: "Finishing setup…" while hq-pro provisions a bucket. */
  let firstFolderSelfHealing = $state(false);
  let firstFolderMissingBucketUids = new Set<string>();
  let firstFolderSelfHealAttempted = false;
  const firstFolderSelfHealTimeoutMs = 90_000;
  const firstFolderSelfHealIntervalMs = 2_000;
  /**
   * The company picked, joined or created in this flow, as the reference the
   * connector import passes to `hq integrations import --company` (slug, or
   * the `cmp_` uid when no slug is known). Null for a Personal setup (no
   * company, or the company step skipped): integrations are company-scoped,
   * so the connector import is not offered then.
   */
  let connectorImportCompany = $state<string | null>(null);
  /**
   * The company route lookup. It starts on the second setup explainer, so the
   * company step can run between the setup explainers and the ready
   * screen instead of after it. Reset on an account switch.
   */
  let companyRouteResolution: Promise<void> | null = null;
  let personEntityNeedsRetry = false;
  let personEntityRetry: Promise<void> | null = null;
  let companyRouteGeneration = 0;
  /** The company lookup has answered with a usable route (or none needed). */
  let companyRouteResolved = $state(false);
  /** Leaving the explainers is in progress; the forward button says so. */
  let leavingExplainers = $state(false);
  const MACHINE_SESSION_POLL_MS = 1_500;
  const MACHINE_SESSION_POLLS = 14;
  const MACHINE_IDENTITY_SIGN_IN_FAILED = 'We couldn’t sign in as this outpost. Try again.';
  let machineSessionPollSpent = false;
  let companyStepCompanyUid: string | null = null;
  let inviteTeammateContext: { companyUid: string; personUid: string } | null = null;
  let inviteStepHiddenTelemetryRecorded = false;
  let inviteCreatedForEmail: string | null = null;
  let inviteEmail = $state('');
  let inviteSending = $state(false);
  let inviteSent = $state(false);
  let inviteErrorKind = $state<InviteErrorKind | null>(null);
  /** Set when the address was already invited and HQ resent that invite. */
  let inviteResent = $state(false);
  let firstFolderSyncFlagResolution: Promise<boolean> | null = null;
  let firstFolderSyncBusy = $state(false);
  let firstFolderSyncError = $state(false);
  let firstFolderSyncStarted = false;
  let firstFolderSyncAwaitingCompletion = false;
  let firstFolderSyncObservedFailure = false;
  let firstFolderSyncCompleted = $state(false);
  let stageCreep = $state(0);
  // How long the stage that is running right now has been running. Drives both
  // the ring's creep and the sub-status line under the active band, so a long
  // stage never reads as frozen.
  let stageElapsedMs = $state(0);
  /** Real backend progress text for the running stage, when one was reported. */
  let stageDetail = $state<string | null>(null);
  /** Set while the active stage waits for its automatic next attempt. */
  let setupRetry = $state<{ stageId: StageId; attempt: SetupRetryAttempt } | null>(
    null,
  );
  // One high-water mark per visit to the setup step. Shown progress is read
  // through it so a retry or a rebuilt stage list can never walk it backward.
  const setupProgressTracker = createSetupProgressTracker();
  /**
   * The run that currently owns the start guard, or 0 when none does.
   *
   * It holds the run id rather than a bare boolean so a restart can TAKE the
   * guard from a run that is still unwinding. A cancelled run keeps awaiting
   * its current stage for as long as that stage's timeout (minutes), and
   * dropping the restart on the floor left the setup screen at 0% with
   * nothing running and no way back.
   */
  let inFlightRunId = 0;
  let effectiveInstallPath = $state<string | null>(null);
  let currentRunId = 0;
  // Set once the blocking install phase (folder, git, personalize, person
  // entity) is done. The ready screen stops waiting on the install here;
  // tools, sync and indexing keep running in the background.
  let blockingPhaseDone = $state(false);
  /** Try again is re-running a required step that already failed. */
  let blockingRetryRunning = $state(false);
  /** The required step Try again is running now, named by the Ready line. */
  let retryingStageId = $state<StageId | null>(null);
  // Each Try again takes a token, and every new or cancelled run clears the
  // gate, so a retry that ends after it was superseded does not clear a newer
  // retry's state.
  const blockingRetryGate = createBlockingRetryGate();
  let retryFailedBlocking: (() => Promise<void>) | null = null;
  // True while the background phase of backgroundRunId is still running, so
  // unmounting the wizard does not cancel it.
  let backgroundPhaseRunning = $state(false);
  // The host's background install queue, read on the ready step and kept
  // current from its progress event. `start_install_queue` returns once the
  // queue has started, so the wizard's own stages can all settle while the
  // queue is still installing, and a launch that opens on the ready step
  // never started a run here at all.
  let hostQueue = $state<InstallQueueStatus | null>(null);
  // Counts progress events, so a status read that an event overtook does not
  // put back an older status (a stale "running" would never clear).
  let hostQueueEvents = 0;
  // True once the ready step's first read of the host queue has come back, so
  // the ready step does not finish on the stale queue value it opened with.
  let hostQueueChecked = $state(false);
  let hostQueueReadToken = 0;
  // The ready step finishes by itself at most once per mount, plus one more
  // time after a usage-data write that failed has been cleared (the person
  // changed their answer). A failed finish leaves the finish-error note with
  // its own Finish setup button.
  let autoFinishAttempted = $state(false);
  let autoFinishRetryOwed = $state(false);
  let autoFinishRetried = false;
  // The usage-data checkbox is ticked by default, so the ready step stays up
  // `readyTimings().consentDwellMs` after blocking setup ends and the checkbox is visible before it
  // finishes by itself and records the answer. Touching either checkbox
  // starts the wait again.
  let readyDwellElapsed = $state(false);
  let readyDwellTimer: ReturnType<typeof setTimeout> | null = null;
  // A ready step that has not finished by itself `readyTimings().watchdogMs`
  // after it opened (a host queue item that never settles, a usage-data write
  // that never comes back) shows the finish-error note's Finish setup button.
  let readyWatchdogFired = $state(false);
  let backgroundRunId = 0;
  // The run whose background phase finished with every stage ok. Try again
  // completes setup for it when the retried step settles after that phase.
  let backgroundOkRunId = 0;
  // Settles when backgroundRunId's background phase ends.
  let backgroundPhaseDone: Promise<void> = Promise.resolve();
  const loggedFirstRunPhases = new Set<string>();
  let currentSetupRunId = '';
  let currentDepsAttemptId = '';
  let setupCancelled = false;
  const initialCloudSyncOperation = { operation: null as Promise<void> | null };
  let unlistenInstallProgress: UnlistenFn | null = null;
  let unlistenContentProgress: UnlistenFn | null = null;
  let unlistenPersonalFirstPushScan: UnlistenFn | null = null;
  let unlistenPersonalFirstPushProgress: UnlistenFn | null = null;
  let activeInitialSyncTimeoutProgress: (() => void) | null = null;
  let activeDepsLockWaitTimeoutProgress: (() => void) | null = null;
  let activeDepsOutputTimeoutProgress: (() => void) | null = null;
  let activeContentTimeoutProgress: (() => void) | null = null;
  let activeIndexingOutputTimeoutProgress: (() => void) | null = null;
  const activeInstallHandles = new Set<string>();
  const activeContentHandles = new Set<string>();
  const SETUP_STAGE_TIMEOUT_MAX_ELAPSED_MULTIPLIER = 3;

  let aiTools = $state<AiTools | null>(null);
  let probeInFlight = false;
  let detectorMounted = false;
  // The ready step re-reads the host's install queue this often while the
  // install runs. A queue item sends one event when it starts and one when it
  // settles, so a missed settle event would otherwise leave the step showing
  // a running install that has already finished.
  const READY_STATUS_REREAD_MS = 10_000;
  let finishing = $state(false);
  // Svelte clears rune-backed state during teardown, so keep the active
  // handoff marker outside that state for onDestroy's abandonment check.
  let finishInProgress = false;
  let finishError = $state(false);

  type StepTelemetryDetails = Omit<
    RecordOnboardingStep['properties'],
    'step' | 'action' | 'flow' | 'appVersion'
  >;

  function stepIdFor(step: number) {
    return WIZARD_STEPS.find((candidate) => candidate.index === step)?.id ?? 'welcome-signin';
  }

  function setCurrentStep(step: number): void {
    currentStep = step;
    currentStepVisibleAt = Date.now();
    if (step === CONNECTOR_IMPORT_STEP_INDEX) connectorImportVisited = true;
    if (step === FIRST_FOLDER_SYNC_STEP_INDEX) firstFolderSyncVisited = true;
    if (step === INVITE_TEAMMATE_STEP_INDEX) inviteTeammateVisited = true;
  }

  function recordStep(
    step: number,
    action: OnboardingAction,
    details: StepTelemetryDetails = {},
    flow?: OnboardingFlow,
    occurredAt?: string,
  ): void {
    if (consentOnly || replay) return;
    // Hold records only until first-launch eligibility is known. A disabled
    // flag or a non-first launch drains them without waiting for native context.
    if (
      !onboardingIdentityPrepared &&
      firstLaunchStatusKnown !== false &&
      firstLaunchJoinKeyEnabled !== false
    ) {
      const queuedDetails = { ...details };
      const eventOccurredAt = occurredAt ?? new Date().toISOString();
      queuedOnboardingStepRecords.push({
        step,
        action,
        occurredAt: eventOccurredAt,
        record: () => recordStepNow(step, action, queuedDetails, flow, eventOccurredAt),
      });
      return;
    }
    recordStepNow(step, action, details, flow, occurredAt);
  }

  function recordStepNow(
    step: number,
    action: OnboardingAction,
    details: StepTelemetryDetails = {},
    flow?: OnboardingFlow,
    occurredAt?: string,
  ): void {
    if (consentOnly || replay) return;
    const stepId = stepIdFor(step);
    const companyUid =
      stepId === 'invite-teammate'
        ? (typeof details.companyUid === 'string'
            ? details.companyUid
            : inviteTeammateContext?.companyUid ?? companyStepCompanyUid ?? undefined)
        : undefined;
    onboardingTelemetry.record({
      properties: {
        step: stepIdFor(step),
        action,
        ...details,
        ...(companyUid ? { companyUid } : {}),
        ...(stepId === 'invite-teammate' && !companyUid ? { companyUidMissing: true } : {}),
        appVersion: onboardingAppVersion,
        flow: flow ?? onboardingFlow,
      },
      ...(occurredAt ? { occurredAt } : {}),
    });
  }

  function recordDeferredSetupFailure(
    failure: DeferredDepsFailure,
    fallback: Pick<RecordOnboardingStep['properties'], 'retryAttempted' | 'retryResult'>,
  ): string {
    return onboardingTelemetry.recordDeferred({
      properties: {
        step: 'setup',
        action: 'failed',
        ...failure.details,
        appVersion: onboardingAppVersion,
        flow: onboardingFlow,
      },
      occurredAt: failure.occurredAt,
    }, fallback);
  }

  function resolveOnboardingAppVersion(): Promise<void> {
    if (onboardingAppVersionResolution) return onboardingAppVersionResolution;
    onboardingAppVersionResolution = getVersion()
      .then((version) => {
        const normalized = version.trim();
        if (normalized) onboardingAppVersion = normalized;
      })
      .catch((error) => {
        console.warn('[onboarding] could not resolve app version for telemetry:', error);
      });
    return onboardingAppVersionResolution;
  }

  function recordOnboardingAbandonment(): void {
    if (!consentOnly && !replay) flushQueuedOnboardingStepRecords();
    if (consentOnly || replay || finishing || finishInProgress || onboardingCompleted || onboardingAbandoned) return;
    const durationMs = Date.now() - currentStepVisibleAt;
    if (durationMs < MIN_VISIBLE_MS_FOR_ABANDON) return;
    onboardingAbandoned = true;
    recordStep(currentStep, 'abandoned', { durationMs });
  }

  function flushQueuedOnboardingStepRecords(suppressFirstLaunchWelcomeEntry = false): void {
    onboardingIdentityPrepared = true;
    for (const queued of queuedOnboardingStepRecords.splice(0)) {
      if (
        suppressFirstLaunchWelcomeEntry &&
        firstLaunchJoinKeyEnabled === true &&
        queued.step === WELCOME_SIGNIN_STEP_INDEX &&
        queued.action === 'entered'
      ) {
        continue;
      }
      queued.record();
    }
  }

  /**
   * Best-effort: `whoami` is the first place a `prs_*` person uid exists after
   * token exchange. Never awaited by the wizard; a miss is retried after setup
   * provisions the person entity.
   */
  async function resolveInstallerPersonUid(): Promise<void> {
    try {
      const identity = await invokeCommand<{ personUid?: string | null }>('whoami');
      const uid = typeof identity?.personUid === 'string' ? identity.personUid.trim() : '';
      if (uid) onboardingTelemetry.setPersonUid(uid);
    } catch {
      // Person entity may not exist until setup / ensure_person_entity.
    }
  }

  const displayPath = $derived(
    resolvedPath ? friendlyPath(resolvedPath, homeDir) : 'Resolving ~/hq...',
  );
  const installDisplayPath = $derived(
    installPath ? friendlyPath(installPath, homeDirFromDefaultHqPath(installPath)) : '~/hq',
  );
  const directoryButtonLabel = $derived(directoryBusy ? 'Checking…' : 'Choose…');
  const settledCount = $derived(countSettledStages(stages));
  const currentStageId = $derived(activeStageId(stages));
  const setupDone = $derived(allSettled(stages));
  const rawOverallPercent = $derived(
    setupProgressPercent({
      settledCount,
      totalStages: STAGE_ORDER.length,
      hasRunningStage: currentStageId !== null,
      stageCreep,
      allDone: setupDone,
    }),
  );
  // Everything user-facing reads the tracked value, never the raw one.
  const overallPercent = $derived(
    trackSetupProgress(setupProgressTracker, rawOverallPercent),
  );
  const setupBands = $derived(friendlySetupBands(overallPercent));
  // US-004: honest expectation-setting under "Getting your HQ ready". The UA
  // read is one-shot at render - the host cannot change during onboarding -
  // and stays neutral when the UA has not landed yet.
  const setupHostOs = $derived(
    readOnboardingHostOs(typeof navigator === 'undefined' ? null : navigator.userAgent),
  );
  const setupExpectation = $derived(setupExpectationCopy(setupHostOs));
  const thisComputer = $derived(thisComputerNounFor(setupHostOs));
  // The global shortcut is Option-Shift-O on a Mac and Alt+Shift+O elsewhere.
  const yourComputer = $derived(yourComputerNounFor(setupHostOs));
  // Board, lit keys and legend all come from this one layout decision.
  const shortcutLayout = $derived(shortcutKeyboardLayoutFor(setupHostOs));
  const keyboardRows = $derived(keyboardRowsFor(shortcutLayout));
  const shortcutChord = $derived(openHqShortcutChord(shortcutLayout));
  const chordKeys = $derived(shortcutChord.keys);
  const chordSpoken = $derived(shortcutChord.spoken);
  const setupSubStatusModel = $derived(
    setupSubStatus({
      stageId: currentStageId,
      elapsedMs: stageElapsedMs,
      detail: stageDetail,
      retry:
        setupRetry && setupRetry.stageId === currentStageId
          ? setupRetry.attempt
          : null,
    }),
  );
  /** Collects the keyboard's key elements for the shortcut screen's chord. */
  function registerKey(node: HTMLElement, id: string) {
    keyEls.set(id, node);
    return {
      destroy() {
        if (keyEls.get(id) === node) keyEls.delete(id);
      },
    };
  }

  // ─── Welcome flow: chrome, install card, auto-finish inputs ─────────────
  /** An install this flow started is still running. */
  const installPending = $derived(setupStarted && !blockingPhaseDone && !setupCompleted);
  const hostQueueRunning = $derived(hostQueue?.state === 'running');
  /** Every install item has settled: this flow's stages and the host's queue. */
  const installSettled = $derived(setupCompleted && !hostQueueRunning);
  /**
   * Some part of the install is still running, the background phase and the
   * host's queue included. The ready screen's progress line follows this, so
   * it names the step still running. The ready step does not wait for it: it
   * finishes once the blocking phase is done (`installPending`), and the
   * Finishing setup chip shows whatever is still running after the window
   * closes. A queue that settled with failures is not running.
   */
  const installActivityRunning = $derived(
    (setupStarted && !setupCompleted && (!blockingPhaseDone || backgroundPhaseRunning)) ||
      hostQueueRunning,
  );
  // Try again names its own step, not a background step running beside it.
  const currentInstallItemId = $derived(
    blockingRetryRunning && retryingStageId
      ? retryingStageId
      : installPending && currentStageId
        ? currentStageId
        : hostQueueRunning && hostQueue?.currentId ? hostQueue.currentId : currentStageId,
  );
  const failedBlockingStageIds = $derived(
    stages
      .filter(
        (stage) =>
          stage.status === 'failed' &&
          (BLOCKING_STAGES as readonly StageId[]).includes(stage.id),
      )
      .map((stage) => stage.id),
  );
  /** Set only after a required step has failed and is not running again. */
  const requiredFailureHeading = $derived(
    installPending || blockingRetryRunning
      ? null
      : readyRequiredFailureHeading(failedBlockingStageIds),
  );
  const currentInstallActivity = $derived(setupActivityPhrase(currentInstallItemId));
  // While blocking setup runs, the Ready line names the step and says so when
  // that step waits on its automatic retry or has run a while. The retry and
  // the elapsed clock belong to the wizard's own stage, not a host queue item.
  const readyLine = $derived(
    readyProgressLine({
      itemId: currentInstallItemId,
      retrying: Boolean(setupRetry && setupRetry.stageId === currentInstallItemId),
      // The clock follows the first active stage, so a step Try again runs
      // beside a background step shows no elapsed time.
      elapsedMs: currentInstallItemId !== null && currentInstallItemId === currentStageId ? stageElapsedMs : 0,
    }),
  );
  const chrome = $derived(welcomeChrome({ scene, replay, setupCompleted }));
  const installCard = $derived(
    installCardModel({
      // A run this flow did not start shows the host queue's own progress.
      percent:
        !setupStarted && hostQueue && hostQueueRunning && hostQueue.total > 0
          ? Math.floor((hostQueue.done * 100) / hostQueue.total)
          : overallPercent,
      completed: installSettled,
      currentItemId: currentInstallItemId,
      retryText:
        setupRetry && setupRetry.stageId === currentStageId
          ? setupRetrySubStatusText(setupRetry.attempt)
          : null,
    }),
  );
  const installCardLines = installCardActivityLines();
  const consentGate = $derived(deferredConsentGate(deferredConsent));
  const storyOrder = $derived(storyScenes(replay));

  $effect(() => {
    if (activeInitialStep === initialStep) return;
    activeInitialStep = initialStep;
    // First-run onboarding has no consent screen: its question is on the
    // ready screen, so a start at the consent step lands there.
    const start =
      !consentOnly && !replay && initialStep === CONSENT_STEP_INDEX
        ? READY_STEP_INDEX
        : initialStep;
    router = createWizardRouter({ start });
    setCurrentStep(router.currentStep);
    furthestStep = Math.max(furthestStep, router.currentStep);
    // The connector import only shows itself once it has something to offer;
    // until then (and for an auto-skip) the ready screen stays on show.
    scene =
      router.currentStep === CONNECTOR_IMPORT_STEP_INDEX
        ? 'ready'
        : sceneForStep(router.currentStep);
  });

  $effect(() => {
    if (installPath) effectiveInstallPath = installPath;
  });

  $effect(() => {
    // Record the first-launch receipt when the first-run sign-in panel shows.
    // This only sends telemetry; it never opens a browser.
    if (
      isReprompt ||
      replay ||
      currentStep !== WELCOME_SIGNIN_STEP_INDEX ||
      launchRecorded
    ) {
      return;
    }
    launchRecorded = true;
    void recordLaunch();
  });

  $effect(() => {
    if (consentOnly || replay || currentStep !== SETUP_STEP_INDEX) return;
    void resolveFirstFolderSyncStepFlag();
  });

  $effect(() => {
    // In re-prompt mode there is no install/setup — only the consent step — so
    // the setup run must never start even if the step index momentarily reads 2.
    if (consentOnly || replay || currentStep !== SETUP_STEP_INDEX || setupStarted) return;
    setupStarted = true;
    void startSetupRun();
  });

  // Entering the ready step reads the host's queue, so a run this wizard did
  // not start (or one still going after this flow's stages settled) shows on
  // the progress line instead of a finished install.
  // It reads again when this flow's stages settle, so the line never shows a
  // queue status that predates the queue's start. `hostQueueChecked` turns
  // true only once the latest of these reads has come back; the step waits
  // for that read, not for the queue to settle.
  $effect(() => {
    if (consentOnly || replay || currentStep !== READY_STEP_INDEX) return;
    void setupCompleted;
    const token = ++hostQueueReadToken;
    hostQueueChecked = false;
    void refreshHostQueueStatus().finally(() => {
      if (token === hostQueueReadToken) hostQueueChecked = true;
    });
  });

  // While the install runs on the ready step, read the host's queue again
  // every READY_STATUS_REREAD_MS, so a missed progress event cannot leave a
  // stale "running" on the progress line.
  $effect(() => {
    if (consentOnly || replay || currentStep !== READY_STEP_INDEX) return;
    if (!installActivityRunning) return;
    const intervalId = window.setInterval(() => {
      void refreshHostQueueStatus();
    }, READY_STATUS_REREAD_MS);
    return () => window.clearInterval(intervalId);
  });

  // One ticker per active stage. It advances the ring's creep AND the elapsed
  // clock the sub-status line reads, so the percent keeps moving and the copy
  // under the active band keeps changing for as long as the stage runs. A
  // stage stays active across its auto-retry, so the clock and the creep carry
  // on rather than restarting from zero on every attempt.
  $effect(() => {
    const activeId = currentStageId;
    const done = setupDone;
    stageCreep = 0;
    stageElapsedMs = 0;
    stageDetail = null;

    if (done || activeId === null) return;

    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      stageElapsedMs = elapsed;
      stageCreep = stageCreepAt(elapsed);
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  });

  onMount(() => {
    mounted = true;
    detectorMounted = true;
    directoryCancelled = false;
    void resolveOnboardingAppVersion();
    window.addEventListener('pagehide', recordOnboardingAbandonment);

    if (!consentOnly && !replay) {
      void prepareOnboardingTelemetryIdentity();
      // Every visible panel has an entry event. A resumed, non-initial panel
      // records both its ordinary entry and the resume signal used for drop-off
      // analysis.
      // ConnectorImportStep owns both its entry and terminal outcomes. This
      // keeps resumed connector screens to one entered event as well.
      if (currentStep !== CONNECTOR_IMPORT_STEP_INDEX) {
        recordStep(currentStep, 'entered', {}, onboardingFlow);
      }
      if (onboardingFlow === 'resume' && currentStep !== WELCOME_SIGNIN_STEP_INDEX) {
        recordStep(currentStep, 'resumed', {}, onboardingFlow);
      }
      // A resumed onboarding session may already have a restored token. Its
      // operational queue is independent of consent and can resume delivery.
      void invokeCommand<{ authenticated: boolean }>('get_auth_state')
        .then((auth) => {
          if (auth?.authenticated) {
            void resolveInstallerPersonUid();
            return onboardingTelemetry.flush();
          }
        })
        .catch(() => {});
      if (currentStep === WELCOME_SIGNIN_STEP_INDEX) void checkExistingSession();
      else void probeMachineIdentity();
    }

    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => {
      reducedMotion = media.matches;
    };
    updateMotion();
    media.addEventListener('change', updateMotion);

    if (!replay) {
      void resolveDefaultPath();
      void probeAiTools();
    }

    const stopWelcome = startWelcome();

    return () => {
      stopWelcome();
      mounted = false;
      detectorMounted = false;
      directoryCancelled = true;
      window.removeEventListener('pagehide', recordOnboardingAbandonment);
      media.removeEventListener('change', updateMotion);
    };
  });

  onMount(() => {
    let active = true;
    const unlisteners: UnlistenFn[] = [];
    function subscribeTauriEvent<Payload>(
      eventName: string,
      handler: (payload: Payload) => void,
    ): void {
      void listen<Payload>(eventName, (event) => {
        if (active) handler(event.payload);
      })
        .then((unlisten) => {
          const cleanup = safeUnlisten(unlisten);
          if (!active) cleanup();
          else unlisteners.push(cleanup);
        })
        .catch((error) => {
          console.warn(`onboarding: ${eventName} listener unavailable`, error);
        });
    }

    subscribeTauriEvent<{ errors?: unknown }>('sync:all-complete', (payload) => {
      handleCompanyPullAllComplete(payload);
      handleFirstFolderSyncComplete(payload);
    });
    subscribeTauriEvent<{ aborted?: unknown }>('sync:complete', (payload) => {
      if (companyPullWaiter && payload.aborted === true) companyPullWaiter.aborted = true;
      if (firstFolderSyncAwaitingCompletion && payload.aborted === true) {
        firstFolderSyncObservedFailure = true;
      }
    });
    subscribeTauriEvent<{ message?: unknown }>('sync:error', (payload) => {
      if (companyPullWaiter && typeof payload?.message === 'string') {
        companyPullWaiter.errors.push({ message: payload.message });
      }
      if (!firstFolderSyncAwaitingCompletion) return;
      const uid = companyUidFromMissingBucket(payload?.message);
      if (uid) firstFolderMissingBucketUids.add(uid);
      else firstFolderSyncObservedFailure = true;
    });
    subscribeTauriEvent('sync:auth-error', handleFirstFolderSyncAuthError);
    subscribeTauriEvent<unknown>(INSTALL_QUEUE_PROGRESS_EVENT, (payload) => {
      const status = parseInstallQueueStatus(payload);
      if (!status) return;
      hostQueueEvents += 1;
      hostQueue = status;
    });
    // A session minted after this screen mounted (the outpost machine identity
    // resolves in the background at launch) must show up without a relaunch.
    // The envelope carries an account id and a generation, no bearer material.
    subscribeTauriEvent('auth:session-changed', () => {
      if (currentStep === WELCOME_SIGNIN_STEP_INDEX) void checkExistingSession();
    });

    return () => {
      active = false;
      stopMachineSessionPoll();
      for (const unlisten of unlisteners) unlisten();
    };
  });

  onDestroy(() => {
    screenTimer.close();
    clearReadyDwell();
    recordOnboardingAbandonment();
    mounted = false;
    currentSignInCall += 1;
    // The background install phase outlives the wizard; it cancels itself when
    // it finishes after unmount. The ready screen finishes while the host's
    // install queue still runs, so closing the window leaves the queue's
    // tool installs running.
    if (!backgroundPhaseRunning) cancelSetupRun({ leaveHostInstalls: true });
  });

  function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }

  async function refreshHostQueueStatus(): Promise<void> {
    const eventsBefore = hostQueueEvents;
    try {
      const status = parseInstallQueueStatus(await invokeCommand<unknown>('get_install_queue_status'));
      if (status && mounted && hostQueueEvents === eventsBefore) {
        hostQueue = status;
      }
    } catch (err) {
      console.warn('[onboarding] install queue status unavailable:', err);
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

  async function handleSignIn(provider: SignInProvider, stateRecoveryAttempt = false) {
    if (provider === 'Microsoft' && microsoftEmail.trim() === '') {
      microsoftEmailPrompt = true;
      signInError = '';
      return;
    }

    existingSessionEmail = null;
    existingSessionOutpost = null;
    const call = ++currentSignInCall;
    loadingProvider = provider;
    signInError = '';
    const telemetryProvider = provider === 'Google' ? 'google' : 'microsoft';
    const progressSessionId = crypto.randomUUID();
    let authStep: DesktopAuthProgressStep = 'sign_in_started';
    void emitDesktopAuthProgress({ provider: telemetryProvider, step: authStep, sessionId: progressSessionId });
    recordManualOAuthReceipt(progressSessionId, 'started');
    recordStep(WELCOME_SIGNIN_STEP_INDEX, 'started', { provider: telemetryProvider });

    try {
      const { authorizeUrl, state } = await invokeCommand<{
        authorizeUrl: string;
        state: string;
      }>('start_oauth_login', {
        provider,
        ...(provider === 'Microsoft' ? { email: microsoftEmail.trim() } : {}),
      });
      if (!isCurrentSignInCall(call)) return;

      if (typeof openExternal !== 'function') {
        throw new Error('The desktop shell cannot open a browser in this environment.');
      }
      await openExternal(authorizeUrl);
      authStep = 'provider_page_opened';
      void emitDesktopAuthProgress({ provider: telemetryProvider, step: authStep, sessionId: progressSessionId });
      recordManualOAuthReceipt(progressSessionId, 'browser_opened');
      if (!isCurrentSignInCall(call)) return;

      const { code } = await invokeCommand<{ code: string }>(
        'oauth_listen_for_code',
        { state },
      );
      authStep = 'callback_received';
      void emitDesktopAuthProgress({ provider: telemetryProvider, step: authStep, sessionId: progressSessionId });
      recordManualOAuthReceipt(progressSessionId, 'callback_received');
      recordStep(WELCOME_SIGNIN_STEP_INDEX, 'callback_received', {
        provider: telemetryProvider,
      });
      if (!isCurrentSignInCall(call)) return;

      const result = await invokeCommand<{
        authenticated: boolean;
        expiresAt?: string;
        accountId?: string | null;
      }>('oauth_exchange_code', { code });
      if (!isCurrentSignInCall(call)) return;

      if (result.authenticated) {
        authStep = 'token_exchange_ok';
        void emitDesktopAuthProgress({ provider: telemetryProvider, step: authStep, sessionId: progressSessionId });
        recordManualOAuthReceipt(progressSessionId, 'identity_verified');
        await completeAuthenticatedSignIn(call, { provider: telemetryProvider });
      } else {
        void emitDesktopAuthFailure({
          provider: telemetryProvider,
          step: authStep,
          error: 'authentication rejected',
        });
        signInError = 'Authentication failed. Please try again.';
        recordStep(WELCOME_SIGNIN_STEP_INDEX, 'failed', {
          provider: telemetryProvider,
          outcome: 'authentication_rejected',
        });
        recordManualOAuthReceipt(progressSessionId, 'failed');
      }
    } catch (err) {
      if (!isCurrentSignInCall(call)) return;
      const errorKind = classifyContinuationError(err);
      recordManualOAuthReceipt(
        progressSessionId,
        errorKind === 'cancelled' ? 'cancelled' : 'failed',
        errorKind,
      );
      void emitDesktopAuthFailure({ provider: telemetryProvider, step: authStep, error: err });
      console.error('[onboarding-signin] sign-in failed:', err);
      if (!stateRecoveryAttempt && (errorKind === 'expired' || errorKind === 'state_mismatch')) {
        console.warn('[onboarding-signin] restarting once after an expired or mismatched attempt');
        void handleSignIn(provider, true);
        return;
      }
      signInError = mapSignInError(errorMessage(err), provider);
      recordStep(WELCOME_SIGNIN_STEP_INDEX, 'failed', {
        provider: telemetryProvider,
        outcome: 'oauth_failed',
        errorKind,
      });
    } finally {
      if (isCurrentSignInCall(call)) {
        loadingProvider = null;
      }
    }
  }

  function getContinuationContextForReceipt(): Promise<ContinuationContext | null> {
    continuationContextPromise ??= loadContinuationContext();
    return continuationContextPromise;
  }

  function recordManualOAuthReceipt(
    sessionId: string,
    outcome: ContinuationOutcome,
    errorKind?: ReturnType<typeof classifyContinuationError>,
  ): void {
    // This side channel is best-effort and deliberately never awaited by the
    // sign-in flow. The same session id also rides on the existing operational
    // progress event so its durable auth hold can be deduped against receipts.
    const previous = manualOAuthReceiptTails.get(sessionId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const context = await getContinuationContextForReceipt();
      if (!context || context.suppressFirstLaunchTelemetry) return;
      const deps = continuationDeps(context);
      const receipt = progressReceipt(deps, {
        sessionId,
        outcome,
        variant: 'control',
        flow: 'manual_oauth',
        ...(errorKind ? { errorKind } : {}),
      });
      await recordReceipt(deps, receipt);
    }).catch((error) => {
      console.warn('onboarding: anonymous sign-in receipt context unavailable', error);
    });
    manualOAuthReceiptTails.set(sessionId, next);
    if (outcome === 'identity_verified' || outcome === 'failed' || outcome === 'cancelled') {
      void next.then(() => {
        if (manualOAuthReceiptTails.get(sessionId) === next) manualOAuthReceiptTails.delete(sessionId);
      });
    }
  }

  /**
   * Record the once-per-installation launch receipt and replay any receipts
   * still queued from an earlier launch. Best effort: it never blocks sign-in
   * and never starts a browser session continuation.
   */
  async function recordLaunch(): Promise<void> {
    const { context, firstLaunchReceiptRecorded } = await prepareOnboardingTelemetryIdentity();
    if (!context) return;
    // The anonymous launch receipt and later authenticated desktop auth events
    // share this opaque id. Use it as the onboarding session join key too.
    onboardingTelemetry.setInstallAttemptId(context.installAttemptId);
    const deps = continuationDeps(context);
    void flushReceipts(deps).catch(() => undefined);
    // `firstLaunchRecorded` is the existing durable first-installation gate.
    // It survives re-renders and a resumed wizard, while recordReceipt keeps
    // an undelivered receipt's event id and timestamp stable for retry.
    if (firstLaunchReceiptRecorded) {
      if (await resolveFirstLaunchDownloadJoinEnabled(context.installAttemptId)) {
        try {
          const downloadAnonId = await invokeCommand<string | null>('web_visitor_anon_id');
          if (downloadAnonId) {
            deps.downloadJoinEnabled = true;
            deps.downloadAnonId = downloadAnonId;
          }
        } catch {
          console.warn('onboarding: installer visitor key unavailable; launch receipt unchanged');
        }
      }
      void recordReceipt(deps, launchReceipt(deps, firstLaunchJoinKeyArm)).catch(() => undefined);
    }
  }

  function resolveFirstLaunchDownloadJoinEnabled(installAttemptId: string): Promise<boolean> {
    if (!firstLaunchDownloadJoinFlagPromise) {
      const downloadJoinFlag = resolveFirstLaunchPublicFlag(
        FIRST_LAUNCH_DOWNLOAD_JOIN_FLAG,
        installAttemptId,
      ).then((enabled) => enabled === true);
      firstLaunchDownloadJoinFlagPromise = resolveFlagWithTimeout(downloadJoinFlag, 2_000);
    }
    return firstLaunchDownloadJoinFlagPromise;
  }

  function resolveFirstLaunchJoinKeyEnabled(visitorId: string | null): Promise<boolean> {
    if (!firstLaunchJoinKeyFlagPromise) {
      const flag = visitorId
        ? resolveFirstLaunchPublicFlag(FIRST_LAUNCH_JOIN_KEY_FLAG, visitorId)
        : Promise.resolve(null);
      firstLaunchJoinKeyFlagPromise = resolveFlagStatusWithTimeout(flag, 2_000).then(
        (status) => {
          const enabled = status === 'enabled';
          firstLaunchJoinKeyArm = status === 'enabled'
            ? 'on'
            : status === 'disabled'
              ? 'off'
              : 'unknown';
          firstLaunchJoinKeyEnabled = enabled;
          if (!enabled) flushQueuedOnboardingStepRecords();
          return enabled;
        },
        (error) => {
          console.warn(
            'onboarding: first-launch join-key flag resolution failed; leaving fallback off',
            error,
          );
          firstLaunchJoinKeyEnabled = false;
          firstLaunchJoinKeyArm = 'unknown';
          flushQueuedOnboardingStepRecords();
          return false;
        },
      );
    }
    return firstLaunchJoinKeyFlagPromise;
  }

  function prepareOnboardingTelemetryIdentity(): Promise<{
    context: ContinuationContext | null;
    firstLaunchReceiptRecorded: boolean;
  }> {
    const launchInitialStep = currentStep;
    if (!onboardingIdentityPromise) {
      onboardingIdentityPromise = (async () => {
        const firstLaunchPromise = invokeCommand<boolean>('is_first_run')
          .catch(() => false)
          .then((firstLaunch) => {
            firstLaunchStatusKnown = firstLaunch;
            if (!firstLaunch) flushQueuedOnboardingStepRecords();
            return firstLaunch;
          });
        const contextPromise = getContinuationContextForReceipt();
        const reachVisitorIdPromise = firstLaunchPromise.then((firstLaunch) =>
          firstLaunch ? loadInstallAttemptId() : null,
        );
        const firstLaunchJoinKeyEnabledPromise = Promise.all([
          firstLaunchPromise,
          reachVisitorIdPromise,
        ]).then(([firstLaunch, visitorId]) =>
          firstLaunch ? resolveFirstLaunchJoinKeyEnabled(visitorId) : false,
        );
        const [firstLaunch, context, joinKeyEnabled, reachVisitorId] = await Promise.all([
          firstLaunchPromise,
          contextPromise,
          firstLaunchJoinKeyEnabledPromise,
          reachVisitorIdPromise,
        ]);
        const installAttemptId = await resolveFirstLaunchJoinKey({
          firstLaunch,
          continuationInstallAttemptId: context?.installAttemptId ?? null,
          isEnabled: async () => joinKeyEnabled,
          readNativeId: loadInstallAttemptId,
        });
        if (installAttemptId) onboardingTelemetry.setInstallAttemptId(installAttemptId);
        let reachInstallAttemptId: string | null = null;
        let signInReachOutcome:
          | 'reached-signin'
          | 'existing-session-skip'
          | 'setup-resume-skip'
          | 'missing-root-recovery-skip'
          | 'consent-only-skip'
          | undefined;
        reachInstallAttemptId = installAttemptId ?? reachVisitorId;
        if (reachInstallAttemptId) {
          signInReachOutcome = launchInitialStep === WELCOME_SIGNIN_STEP_INDEX
            ? 'reached-signin'
            : mode === 'consent'
              ? 'consent-only-skip'
              : recoveringMissingRoot
                ? 'missing-root-recovery-skip'
                : onboardingFlow === 'resume' || launchInitialStep === SETUP_STEP_INDEX
                  ? 'setup-resume-skip'
                  : 'existing-session-skip';
        }
        const receiptReachOutcome = signInReachOutcome;
        const receiptReachInstallAttemptId = receiptReachOutcome ? reachInstallAttemptId ?? undefined : undefined;
        const firstLaunchReceiptRecorded = context
          ? shouldSendFirstLaunchReceipt(firstLaunch, context.suppressFirstLaunchTelemetry) &&
            onboardingTelemetry.recordFirstLaunch(receiptReachOutcome, receiptReachInstallAttemptId)
          : firstLaunch &&
            onboardingTelemetry.recordFirstLaunch(receiptReachOutcome, receiptReachInstallAttemptId);
        if (signInReachOutcome && context?.suppressFirstLaunchTelemetry !== true) {
          recordFirstLaunchSignInReachOutcome(signInReachOutcome);
        }
        return { context, firstLaunchReceiptRecorded, installAttemptId };
      })()
        .catch((error) => {
          console.warn(
            'onboarding: telemetry identity preparation failed; using the local session id',
            error,
          );
          return {
            context: null,
            firstLaunchReceiptRecorded: false,
          };
        })
        .then((result) => {
          flushQueuedOnboardingStepRecords(
            result.firstLaunchReceiptRecorded &&
              firstLaunchJoinKeyEnabled === true &&
              'installAttemptId' in result &&
              Boolean(result.installAttemptId),
          );
          return result;
        });
    }
    return onboardingIdentityPromise;
  }

  /**
   * The provider OAuth flow lands here after native code has activated the
   * auth session: the post-auth transition, telemetry flush, person lookup,
   * and refocus.
   */
  async function completeAuthenticatedSignIn(
    call: number,
    details: StepTelemetryDetails = {},
  ): Promise<void> {
    // The token is now available, so release operational records that were
    // buffered solely while the OAuth flow was unauthenticated.
    void onboardingTelemetry.flush().catch(() => {});
    // Person entity may not exist yet; later pings retry after setup.
    void resolveInstallerPersonUid();
    await refocusWindow();
    if (!isCurrentSignInCall(call)) return;
    // The consent question is asked later as its own step after setup.
    // Operational setup telemetry is emitted independently; skill usage
    // remains governed by that choice.
    advanceTo(DIRECTORY_STEP_INDEX, 'completed', {
      ...details,
      outcome: 'authenticated',
    });
  }

  function detectLooksLikeHq(result: DetectHqResult): boolean {
    return Boolean(result.looksLikeHq ?? result.looks_like_hq ?? result.isHq ?? result.is_hq);
  }

  function detectNonEmpty(result: DetectHqResult): boolean {
    return Boolean(result.nonEmpty ?? result.non_empty);
  }

  function acceptPath(path: string, validated = false) {
    resolvedPath = path;
    homeDir = homeDir ?? homeDirFromDefaultHqPath(path);
    directoryNotice = null;
    installPath = path;
    validatedInstallPath = validated ? path : null;
    if (typeof invoke === 'function') {
      void invoke('set_hq_install_path', { path }).catch(() => {});
    }
  }

  function rejectPath(text: string, tone: Notice['tone'] = 'error') {
    directoryNotice = { tone, text };
  }

  function resolveFirstFolderSyncStepFlag(): Promise<boolean> {
    if (!firstFolderSyncFlagResolution) {
      firstFolderSyncFlagResolution = (async () => {
        try {
          const result = await onboardingFeatureFlags.identity.hasFeature(
            FIRST_FOLDER_SYNC_STEP_FLAG,
          );
          if (!result.ok) {
            console.warn(
              'onboarding: first-folder sync rollout flag unavailable; leaving the step off',
              result.reason,
              result.code,
            );
            return false;
          }
          return result.value === true;
        } catch (error) {
          console.warn(
            'onboarding: first-folder sync rollout flag failed; leaving the step off',
            error,
          );
          return false;
        }
      })().then((enabled) => {
        if (mounted) showFirstFolderSyncStep = enabled;
        return enabled;
      });
    }
    return firstFolderSyncFlagResolution;
  }

  async function resolveCompanyRouteLookupRetryFlag(): Promise<boolean> {
    try {
      const result = await onboardingFeatureFlags.identity.hasFeature(
        COMPANY_ROUTE_LOOKUP_RETRY_FLAG,
      );
      if (!result.ok) {
        console.warn(
          'onboarding: company route lookup retry flag unavailable; leaving retry off',
          result.reason,
          result.code,
        );
        return false;
      }
      return result.value === true;
    } catch (error) {
      console.warn(
        'onboarding: company route lookup retry flag failed; leaving retry off',
        error,
      );
      return false;
    }
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  async function onboardingHqProJson(
    method: 'GET' | 'POST',
    url: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await retryThrottled(
      () =>
        invokeCommand<unknown>('hq_pro_fetch', {
          url,
          method,
          body: body === undefined ? null : JSON.stringify(body),
        }),
      (attempt) => {
        if (!isRecord(attempt) || typeof attempt.status !== 'number') {
          return { status: null };
        }
        return {
          status: attempt.status,
          retryAfter:
            typeof attempt.retryAfter === 'string' ? attempt.retryAfter : null,
        };
      },
    );
    if (!isRecord(response) || typeof response.status !== 'number') {
      throw new Error('hq-pro returned an invalid response');
    }
    if (response.status < 200 || response.status >= 300) {
      throw new HqProRequestError(response.status, hqProErrorCode(response.body));
    }
    const payload =
      typeof response.body === 'string' && response.body.trim()
        ? JSON.parse(response.body)
        : null;
    if (!isRecord(payload)) throw new Error('hq-pro returned an invalid JSON body');
    return payload;
  }

  /**
   * One `/membership/me` read shared by the company step and the invite step,
   * so finishing setup costs one membership lookup, not two.
   */
  let membershipMeRead: Promise<Record<string, unknown>> | null = null;
  function readMembershipMe(): Promise<Record<string, unknown>> {
    if (!membershipMeRead) {
      // US-023: the history flag adds the account's past companies, which is
      // how a returning account with no active company is told apart from a
      // brand-new one. The membership list is the same either way.
      membershipMeRead = onboardingHqProJson('GET', MEMBERSHIP_ME_WITH_HISTORY_URL);
      // A failed read is not cached; the next caller asks again.
      membershipMeRead.catch(() => (membershipMeRead = null));
    }
    return membershipMeRead;
  }

  /** The signed-in account's email (from the local token), or null. */
  async function resolveSignedInEmail(): Promise<string | null> {
    try {
      const auth = await invokeCommand<{ authenticated?: boolean; email?: string | null }>('get_auth_state');
      const email = auth?.authenticated && typeof auth.email === 'string' && auth.email.trim() ? auth.email.trim() : null;
      signedInEmail = email;
      return email;
    } catch {
      return null;
    }
  }

  /**
   * Signed-in-as guard: a token already on this machine when onboarding opens
   * (a reinstall over an old ~/.hq) may be someone else's. Show it on the
   * sign-in screen before anything is created.
   */
  /** Whether this machine holds an outpost identity and whether it is the live session. */
  async function probeMachineIdentity(): Promise<{ available: boolean; active: boolean }> {
    try {
      const status = await invokeCommand<{ available?: unknown; active?: unknown } | null>(
        'get_machine_identity_status',
      );
      machineIdentity = { available: status?.available === true, active: status?.active === true };
    } catch (error) {
      console.warn('onboarding: machine identity status unavailable', error);
      machineIdentity = { available: false, active: false };
    }
    outpostSession = machineIdentity.active;
    return machineIdentity;
  }

  /** The outpost behind the live machine session: its uid and its owner's email. */
  async function resolveOutpostIdentity(): Promise<{ uid: string | null; ownerEmail: string | null }> {
    try {
      const who = await invokeCommand<{ personUid?: unknown; email?: unknown } | null>('whoami');
      const uid =
        typeof who?.personUid === 'string' && who.personUid.startsWith('out_') ? who.personUid : null;
      const ownerEmail = typeof who?.email === 'string' && who.email.trim() ? who.email.trim() : null;
      return { uid, ownerEmail };
    } catch (error) {
      console.warn('onboarding: outpost identity lookup failed', error);
      return { uid: null, ownerEmail: null };
    }
  }

  function recordExistingSessionShown(): void {
    if (existingSessionShownRecorded) return;
    existingSessionShownRecorded = true;
    recordStep(WELCOME_SIGNIN_STEP_INDEX, 'started', { outcome: 'existing_session_shown' });
  }

  function stopMachineSessionPoll(): void {
    if (machineSessionPollTimer !== null) clearTimeout(machineSessionPollTimer);
    machineSessionPollTimer = null;
    machineSessionPollsLeft = 0;
  }

  /**
   * A machine identity resolves its session in the background at launch, a
   * little after this screen mounts. Look again every 1.5s for about 20s while
   * the sign-in screen waits with an identity available but no session yet.
   */
  function scheduleMachineSessionPoll(): void {
    if (machineSessionPollTimer !== null) return;
    if (machineSessionPollsLeft <= 0) return;
    machineSessionPollsLeft -= 1;
    machineSessionPollTimer = setTimeout(() => {
      machineSessionPollTimer = null;
      if (!mounted || currentStep !== WELCOME_SIGNIN_STEP_INDEX) return;
      void checkExistingSession();
    }, MACHINE_SESSION_POLL_MS);
  }

  /**
   * Signed-in-as guard: a token already on this machine when onboarding opens
   * (a reinstall over an old ~/.hq) may be someone else's. Show it on the
   * sign-in screen before anything is created. The machine's own outpost
   * identity is shown whatever the launch classified as: it is this
   * machine's, not a leftover, and it may land after this screen mounted
   * (the auth session event and a short poll call back in here).
   */
  async function checkExistingSession(): Promise<void> {
    try {
      const machine = await probeMachineIdentity();
      if (machine.active) {
        const [email, outpost] = await Promise.all([resolveSignedInEmail(), resolveOutpostIdentity()]);
        if (currentStep !== WELCOME_SIGNIN_STEP_INDEX) return;
        stopMachineSessionPoll();
        existingSessionEmail = null;
        existingSessionOutpost = { uid: outpost.uid, ownerEmail: outpost.ownerEmail ?? email };
        recordExistingSessionShown();
        return;
      }
      if (machine.available && currentStep === WELCOME_SIGNIN_STEP_INDEX) {
        if (machineSessionPollsLeft === 0 && machineSessionPollTimer === null && !machineSessionPollSpent) {
          machineSessionPollSpent = true;
          machineSessionPollsLeft = MACHINE_SESSION_POLLS;
        }
        scheduleMachineSessionPoll();
      }
      const firstLaunch = await invokeCommand<boolean>('is_first_run').catch(() => false);
      if (!firstLaunch) return;
      const email = await resolveSignedInEmail();
      if (email && currentStep === WELCOME_SIGNIN_STEP_INDEX) {
        existingSessionOutpost = null;
        existingSessionEmail = email;
        recordExistingSessionShown();
      }
    } catch (error) {
      console.warn('onboarding: existing session check failed', error);
    }
  }

  /** Sign in as this machine's outpost (the local opt-out is cleared natively). */
  async function useMachineIdentity(): Promise<void> {
    if (usingMachineIdentity) return;
    usingMachineIdentity = true;
    machineIdentityError = null;
    try {
      await invokeCommand('use_machine_identity');
      await checkExistingSession();
      if (!existingSessionOutpost) machineIdentityError = MACHINE_IDENTITY_SIGN_IN_FAILED;
    } catch (error) {
      console.warn('onboarding: use machine identity failed', error);
      machineIdentityError = MACHINE_IDENTITY_SIGN_IN_FAILED;
    } finally {
      usingMachineIdentity = false;
    }
  }

  /** Keep the session that was already here. */
  function continueExistingSession(): void {
    if (!existingSessionEmail && !existingSessionOutpost) return;
    const outcome = existingSessionOutpost ? 'outpost_session_continued' : 'existing_session_continued';
    existingSessionEmail = null;
    existingSessionOutpost = null;
    void completeAuthenticatedSignIn(++currentSignInCall, { outcome });
  }

  /** Sign out and go back to the sign-in buttons. Used by the guard and by the invite mismatch. */
  async function switchAccount(): Promise<void> {
    if (switchingAccount) return;
    switchingAccount = true;
    try {
      await invokeCommand('sign_out');
    } catch (error) {
      console.warn('onboarding: sign out for account switch failed', error);
    } finally {
      switchingAccount = false;
    }
    // The next account must never import connectors into, or read from, the
    // previous account's company. sign_out clears it natively too; this also
    // covers a sign-out that failed.
    connectorImportCompany = null;
    // The cached membership read belongs to the previous account as well.
    membershipMeRead = null;
    resetAccountKind();
    await selectCompany(null, true);
    existingSessionEmail = null;
    existingSessionOutpost = null;
    existingSessionShownRecorded = false;
    signedInEmail = null;
    // Signing out of the outpost session is a local opt-out: the identity
    // stays available, so the sign-in screen offers it again.
    void probeMachineIdentity();
    recordStep(WELCOME_SIGNIN_STEP_INDEX, 'started', { outcome: 'existing_session_switched' });
  }

  function companyStepHqProJson(
    method: 'GET' | 'POST',
    url: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (method === 'GET' && (url === '/membership/me' || url === MEMBERSHIP_ME_WITH_HISTORY_URL)) {
      return readMembershipMe();
    }
    return onboardingHqProJson(method, url, body);
  }

  async function resolveInviteTeammateContext(): Promise<
    | { context: { companyUid: string; personUid: string } }
    | { context: null; hiddenReason: InviteStepHiddenReason }
  > {
    try {
      const membershipPayload = await readMembershipMe();
      const rawMemberships = membershipPayload.memberships;
      if (!Array.isArray(rawMemberships) || !rawMemberships.every(isRecord)) {
        return { context: null, hiddenReason: 'no_invite_context' };
      }
      const activeCompanyMemberships = rawMemberships.filter(
        (membership) =>
          membership.status === 'active' &&
          typeof membership.companyUid === 'string' &&
          membership.companyUid.startsWith('cmp_'),
      );
      const activeCompanyUids = [
        ...new Set(
          activeCompanyMemberships.map(
            (membership) => membership.companyUid as string,
          ),
        ),
      ];
      if (activeCompanyUids.length !== 1) {
        return { context: null, hiddenReason: 'no_invite_context' };
      }

      const companyUid = activeCompanyUids[0]!;
      const ownMemberships = activeCompanyMemberships.filter(
        (membership) => membership.companyUid === companyUid,
      );
      if (
        ownMemberships.length !== 1 ||
        typeof ownMemberships[0]?.personUid !== 'string' ||
        !ownMemberships[0].personUid.startsWith('prs_')
      ) {
        return { context: null, hiddenReason: 'no_invite_context' };
      }
      const personUid = ownMemberships[0].personUid;

      const rosterPayload = await onboardingHqProJson(
        'GET',
        `/membership/company/${encodeURIComponent(companyUid)}`,
      );
      const rawMembers = rosterPayload.members;
      if (!Array.isArray(rawMembers) || !rawMembers.every(isRecord)) {
        return { context: null, hiddenReason: 'no_invite_context' };
      }
      const activeMembers = rawMembers.filter((member) => member.status === 'active');
      if (
        activeMembers.length !== 1 ||
        activeMembers[0]?.personUid !== personUid ||
        (typeof activeMembers[0]?.companyUid === 'string' &&
          activeMembers[0].companyUid !== companyUid)
      ) {
        return { context: null, hiddenReason: 'no_invite_context' };
      }
      return { context: { companyUid, personUid } };
    } catch (error) {
      console.warn('onboarding: invite teammate eligibility lookup failed', error);
      return { context: null, hiddenReason: 'lookup_failed' };
    }
  }

  function recordInviteFailure(failure: InviteFailure): void {
    inviteErrorKind = failure.kind;
    void emitDesktopOperationalTelemetry(inviteFailedEvent(failure.kind));
    recordStep(INVITE_TEAMMATE_STEP_INDEX, 'failed', {
      errorKind: failure.kind,
      errorCategory: failure.kind === 'network' ? 'network' : 'unknown',
      ...(failure.httpStatus === undefined ? {} : { statusCode: failure.httpStatus }),
    });
  }

  function postInvite(
    context: { companyUid: string; personUid: string },
    inviteeEmail: string,
    resend: boolean,
  ): Promise<Record<string, unknown>> {
    return onboardingHqProJson('POST', '/membership/invite', {
      companyUid: context.companyUid,
      role: 'member',
      invitedBy: context.personUid,
      inviteeEmail,
      ...(resend ? { resend: true } : { sendEmail: true }),
    });
  }

  async function sendTeammateInvite(): Promise<void> {
    const context = inviteTeammateContext;
    const inviteeEmail = inviteEmail.trim();
    if (!context || !inviteeEmail || inviteSending || inviteSent) return;

    inviteSending = true;
    inviteErrorKind = null;
    inviteResent = false;
    try {
      let resend = inviteCreatedForEmail === inviteeEmail;
      let alreadyInvited = false;
      let response: Record<string, unknown>;
      try {
        response = await postInvite(context, inviteeEmail, resend);
      } catch (error) {
        // A resumed session (or a second click after a lost answer) meets the
        // invite the first attempt made. hq-pro answers 409; resend it.
        if (resend || !isAlreadyExists(error)) throw error;
        resend = true;
        alreadyInvited = true;
        inviteCreatedForEmail = inviteeEmail;
        response = await postInvite(context, inviteeEmail, true);
      }
      const inviteExists =
        isRecord(response.membership) || (resend && response.resent === true);
      if (!inviteExists) {
        recordInviteFailure({ kind: 'request_failed' });
        return;
      }
      inviteCreatedForEmail = inviteeEmail;
      if (response.emailSent !== true) {
        recordInviteFailure({ kind: 'email_delivery_failed' });
        return;
      }
      inviteSent = true;
      inviteResent = alreadyInvited;
      void emitDesktopOperationalTelemetry(inviteSentEvent());
      recordStep(INVITE_TEAMMATE_STEP_INDEX, 'completed', {
        outcome: alreadyInvited ? 'resent' : 'ok',
        invitesSent: 1,
      });
    } catch (error) {
      console.warn('onboarding: invite teammate request failed', error);
      recordInviteFailure(classifyInviteError(error));
    } finally {
      inviteSending = false;
    }
  }

  async function resolveDefaultPath() {
    directoryBusy = true;
    directoryNotice = null;
    try {
      // Resolve only. The folder is created by the install step, after the
      // person has confirmed where HQ lives.
      const path = await invokeCommand<string>('resolve_hq_path', { create: false });
      if (directoryCancelled) return;
      homeDir = homeDirFromDefaultHqPath(path);
      acceptPath(path);
    } catch (err) {
      if (directoryCancelled) return;
      console.warn('onboarding: default install directory could not be prepared', err);
      resolvedPath = null;
      installPath = null;
      rejectPath('HQ could not prepare the default folder. Choose a location to continue.', 'warning');
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

      if (detection.exists && !detectLooksLikeHq(detection) && detectNonEmpty(detection)) {
        const installPath = appendChildFolderPath(picked, 'hq');
        const [childDetection, childWritable] = await Promise.all([
          invokeCommand<DetectHqResult>('detect_hq', { path: installPath }),
          invokeCommand<boolean>('check_writable', { path: installPath }),
        ]);
        if (!childWritable) {
          rejectPath(
            'HQ cannot write to a new folder here. Choose another location, or allow HQ access to this folder in your system privacy settings, then try again.',
            'warning',
          );
          recordStep(DIRECTORY_STEP_INDEX, 'failed', {
            outcome: 'not_writable',
            errorKind: 'directory_not_writable',
          });
          return;
        }
        if (
          childDetection.exists &&
          !detectLooksLikeHq(childDetection) &&
          detectNonEmpty(childDetection)
        ) {
          rejectPath(
            'The hq subfolder already contains files. Choose another location or rename that subfolder before trying again.',
            'warning',
          );
          recordStep(DIRECTORY_STEP_INDEX, 'failed', {
            outcome: 'invalid_directory',
            errorKind: 'directory_child_nonempty_non_hq',
          });
          return;
        }
        acceptPath(installPath, true);
        directoryNotice = {
          tone: 'warning',
          text: 'This location already has files. HQ will use the new hq folder inside it.',
        };
        return;
      }

      if (!writable) {
        rejectPath(
          'HQ cannot write to this folder. Choose another location, or allow HQ access to it in your system privacy settings, then try again.',
          'warning',
        );
        recordStep(DIRECTORY_STEP_INDEX, 'failed', {
          outcome: 'not_writable',
          errorKind: 'directory_not_writable',
        });
        return;
      }

      acceptPath(picked, true);
    } catch (err) {
      console.warn('onboarding: selected directory could not be checked', err);
      rejectPath(
        'HQ could not check this folder. Choose another location or check its access settings, then try again.',
        'warning',
      );
      recordStep(DIRECTORY_STEP_INDEX, 'failed', {
        outcome: 'directory_check_failed',
        errorKind: 'directory_check_failed',
      });
    } finally {
      directoryBusy = false;
    }
  }

  async function handleInstall() {
    if (!installPath || directoryBusy) return;
    if (validatedInstallPath === installPath) {
      advanceTo(SETUP_STEP_INDEX, 'completed');
      return;
    }

    const selectedPath = installPath;
    directoryBusy = true;
    directoryNotice = null;
    try {
      // The default path is only resolved before auth exists. Validate it
      // here, after sign-in, before allowing setup to use it; check_writable
      // creates the folder, so this Install step is where it first appears.
      const [detection, writable] = await Promise.all([
        invokeCommand<DetectHqResult>('detect_hq', { path: selectedPath }),
        invokeCommand<boolean>('check_writable', { path: selectedPath }),
      ]);
      if (detection.exists && !detectLooksLikeHq(detection) && detectNonEmpty(detection)) {
        const installPath = appendChildFolderPath(selectedPath, 'hq');
        const [childDetection, childWritable] = await Promise.all([
          invokeCommand<DetectHqResult>('detect_hq', { path: installPath }),
          invokeCommand<boolean>('check_writable', { path: installPath }),
        ]);
        if (!childWritable) {
          rejectPath(
            'HQ cannot write to a new folder here. Choose another location, or allow HQ access to this folder in your system privacy settings, then try again.',
            'warning',
          );
          recordStep(DIRECTORY_STEP_INDEX, 'failed', {
            outcome: 'not_writable',
            errorKind: 'directory_not_writable',
          });
          return;
        }
        if (
          childDetection.exists &&
          !detectLooksLikeHq(childDetection) &&
          detectNonEmpty(childDetection)
        ) {
          rejectPath(
            'The hq subfolder already contains files. Choose another location or rename that subfolder before trying again.',
            'warning',
          );
          recordStep(DIRECTORY_STEP_INDEX, 'failed', {
            outcome: 'invalid_directory',
            errorKind: 'directory_child_nonempty_non_hq',
          });
          return;
        }
        acceptPath(installPath, true);
        directoryNotice = {
          tone: 'warning',
          text: 'This location already has files. HQ will use the new hq folder inside it.',
        };
        return;
      }

      if (!writable) {
        rejectPath(
          'HQ cannot write to this folder. Choose another location, or allow HQ access to it in your system privacy settings, then try again.',
          'warning',
        );
        recordStep(DIRECTORY_STEP_INDEX, 'failed', {
          outcome: 'not_writable',
          errorKind: 'directory_not_writable',
        });
        return;
      }

      validatedInstallPath = selectedPath;
      advanceTo(SETUP_STEP_INDEX, 'completed');
    } catch (err) {
      console.warn('onboarding: final directory validation failed', err);
      rejectPath(
        'HQ could not check this folder. Choose another location or check its access settings, then try again.',
        'warning',
      );
      recordStep(DIRECTORY_STEP_INDEX, 'failed', {
        outcome: 'directory_check_failed',
        errorKind: 'directory_check_failed',
      });
    } finally {
      directoryBusy = false;
    }
  }

  function beginSetupRun(): number {
    currentRunId += 1;
    currentSetupRunId = createSetupRunId();
    currentDepsAttemptId = currentSetupRunId;
    setupCancelled = false;
    setupRetry = null;
    // Supersession: the previous run may have left a stage mid-retry. This
    // run owns the list now, so nothing may still be waiting on that retry.
    stages = resetRetryingStages(stages);
    clearBlockingRetry();
    activeDepsLockWaitTimeoutProgress = null;
    activeDepsOutputTimeoutProgress = null;
    activeContentTimeoutProgress = null;
    activeIndexingOutputTimeoutProgress = null;
    activeInstallHandles.clear();
    activeContentHandles.clear();
    return currentRunId;
  }

  /** Ends any Try again state; a retry still in flight can no longer clear it. */
  function clearBlockingRetry(): void {
    blockingRetryGate.clear();
    blockingRetryRunning = false;
    retryingStageId = null;
  }

  function isCurrentRun(runId: number): boolean {
    return runId === currentRunId && !setupCancelled;
  }

  async function cancelActiveInstallHandles(runId: number): Promise<void> {
    if (runId !== currentRunId) return;
    const handles = [...activeInstallHandles];
    activeInstallHandles.clear();
    await Promise.allSettled(
      handles.map((handle) =>
        invoke('cancel_install', { handle }),
      ),
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

  async function cancelForegroundWork(
    runId: number,
    { leaveHostInstalls = false }: { leaveHostInstalls?: boolean } = {},
  ): Promise<void> {
    if (leaveHostInstalls) {
      // The install handles belong to the host's queue items (tool installs,
      // embeddings). The queue owns them and has its own per-item deadline,
      // so only this wizard's tracking of them is dropped.
      if (runId === currentRunId) activeInstallHandles.clear();
      await cancelActiveContentHandles(runId);
      return;
    }
    await Promise.allSettled([
      cancelActiveInstallHandles(runId),
      cancelActiveContentHandles(runId),
    ]);
  }

  function trackInstallProgress(runId: number, payload: InstallProgressPayload): void {
    if (!isCurrentRun(runId)) return;
    const handle = payload.handle;
    if (!handle) return;

    if (payload.finished) {
      if (handle !== 'preflight') activeInstallHandles.delete(handle);
      return;
    }
    if (handle !== 'preflight') activeInstallHandles.add(handle);
    if (
      currentStageId === 'deps' &&
      payload.setupRunId === currentDepsAttemptId &&
      payload.line?.trim()
    ) {
      activeDepsOutputTimeoutProgress?.();
    }
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

    if (
      currentStageId === 'content' &&
      handle &&
      activeContentHandles.has(handle) &&
      !payload.stalled &&
      (payload.phase === 'download' ||
        payload.phase === 'extract' ||
        payload.phase === 'complete')
    ) {
      activeContentTimeoutProgress?.();
    }

    if (handle && payload.phase === 'complete') {
      activeContentHandles.delete(handle);
    }

    // The template download is the one stage that reports genuine progress;
    // show it verbatim instead of the written sub-steps while it runs.
    if (currentStageId === 'content') {
      stageDetail = contentProgressSubStatus(payload);
    }
  }

  async function listenForProgress(runId: number): Promise<void> {
    const unlisten = safeUnlisten(await listen<InstallProgressPayload>(
      'install:progress',
      (event) => trackInstallProgress(runId, event.payload),
    ));
    const unlistenCliLockWait = safeUnlisten(await listen<string>(
      'setup:cli-install-lock-wait',
      (event) => {
        const handle = event.payload;
        if (
          isCurrentRun(runId) &&
          currentStageId === 'deps' &&
          activeInstallHandles.has(handle)
        ) {
          activeDepsLockWaitTimeoutProgress?.();
        }
      },
    ));
    if (!isCurrentRun(runId)) {
      unlisten();
      unlistenCliLockWait();
      return;
    }
    unlistenInstallProgress = () => {
      unlisten();
      unlistenCliLockWait();
    };

    const unlistenContent = safeUnlisten(await listen<ContentProgressPayload>(
      'content:progress',
      (event) => trackContentProgress(runId, event.payload),
    ));
    if (!isCurrentRun(runId)) {
      unlistenContent();
      return;
    }
    unlistenContentProgress = unlistenContent;

    const unlistenReindex = safeUnlisten(await listen<string>(
      'setup:reindex-progress',
      (event) => {
        if (
          isCurrentRun(runId) &&
          currentStageId === 'indexing' &&
          event.payload === currentSetupRunId
        ) {
          activeIndexingOutputTimeoutProgress?.();
        }
      },
    ));
    if (!isCurrentRun(runId)) {
      unlistenReindex();
      return;
    }
    unlistenInstallProgress = (() => {
      const previousUnlisten = unlistenInstallProgress;
      return () => {
        previousUnlisten?.();
        unlistenReindex();
      };
    })();

    const notifyInitialSyncActivity = () => {
      if (isCurrentRun(runId) && currentStageId === 'initial-sync') {
        activeInitialSyncTimeoutProgress?.();
      }
    };
    const unlistenPersonalScan = safeUnlisten(
      await listen('sync:personal-first-push-scan', notifyInitialSyncActivity),
    );
    if (!isCurrentRun(runId)) {
      unlistenPersonalScan();
      return;
    }
    unlistenPersonalFirstPushScan = unlistenPersonalScan;

    const unlistenPersonalProgress = safeUnlisten(
      await listen('sync:personal-first-push-progress', notifyInitialSyncActivity),
    );
    if (!isCurrentRun(runId)) {
      unlistenPersonalProgress();
      return;
    }
    unlistenPersonalFirstPushProgress = unlistenPersonalProgress;
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
    } catch (err) {
      // Resume journaling is best-effort; setup itself remains authoritative.
      console.warn('[onboarding-setup] record_step_start failed:', err);
    }
  }

  async function journalStageOk(id: StageId): Promise<void> {
    try {
      await invoke('record_step_ok', { stepId: id });
    } catch (err) {
      console.warn('[onboarding-setup] record_step_ok failed:', err);
    }
  }

  async function journalStageFailure(id: StageId, message: string): Promise<void> {
    try {
      await invoke('record_step_failure', { stepId: id, error: message });
    } catch (err) {
      console.warn('[onboarding-setup] record_step_failure failed:', err);
    }
  }

  async function journalInstallComplete(): Promise<void> {
    try {
      await invoke('record_install_complete');
    } catch (err) {
      console.warn('[onboarding-setup] record_install_complete failed:', err);
    }
  }

  type OnboardingFailureScope = {
    setupRunId: string;
    attemptCount: number;
    flow: OnboardingFlow;
    frontendSessionId: string;
  };

  async function invokeStageCommand(
    id: StageId,
    runId: number,
    failureScope: OnboardingFailureScope,
    depsTimeoutRetryEnabled: boolean,
  ): Promise<void> {
    const invocations = stageCommandInvocations(id, {
      installPath: effectiveInstallPath,
      hostOs: setupHostOs,
    });
    if (invocations.length === 0) return;
    if (typeof invoke !== 'function') {
      throw new Error('The desktop bridge is not available in this environment.');
    }

    const ms = stageTimeoutMs(id);
    const activityTimeoutEnabled =
      id === 'deps' || id === 'content' || id === 'indexing';
    if (!isCurrentRun(runId)) return;
    for (const invocation of invocations) {
      let args = invocation.args;
      if (['content', 'deps', 'git-init', 'indexing'].includes(id)) {
        args = { ...(args ?? {}), failureScope };
      }
      if (id === 'indexing' && activityTimeoutEnabled) {
        args = { ...(args ?? {}), activityTimeoutEnabled: true };
      }
      let handle: string | null = null;
      if (invocation.command === 'fetch_and_extract_template') {
        handle = contentHandle(runId);
        activeContentHandles.add(handle);
        args = { ...args, handle };
      }
      try {
        const operation =
          invocation.command === 'start_initial_cloud_sync'
            ? reuseInFlightOperation(initialCloudSyncOperation, () =>
                Promise.resolve(invokeDesktopCommand(invocation.command, args)),
              )
            : Promise.resolve(invokeDesktopCommand(invocation.command, args));
        const onTimeout = (timeoutMs = ms) =>
          new StageTimeoutError(id, timeoutMs);
        const cancel = () => cancelForegroundWork(runId);
        if (id === 'initial-sync') {
          await withProgressTimeout(
            operation,
            ms,
            onTimeout,
            (onProgress) => {
              activeInitialSyncTimeoutProgress = onProgress;
              return () => {
                if (activeInitialSyncTimeoutProgress === onProgress) {
                  activeInitialSyncTimeoutProgress = null;
                }
              };
            },
            cancel,
          );
        } else if (id === 'deps') {
          await withProgressTimeout(
            operation,
            ms,
            onTimeout,
            (onProgress) => {
              activeDepsLockWaitTimeoutProgress = onProgress;
              if (activityTimeoutEnabled) {
                activeDepsOutputTimeoutProgress = onProgress;
              }
              return () => {
                if (activeDepsLockWaitTimeoutProgress === onProgress) {
                  activeDepsLockWaitTimeoutProgress = null;
                }
                if (activeDepsOutputTimeoutProgress === onProgress) {
                  activeDepsOutputTimeoutProgress = null;
                }
              };
            },
            cancel,
            activityTimeoutEnabled
              ? ms * SETUP_STAGE_TIMEOUT_MAX_ELAPSED_MULTIPLIER
              : undefined,
            depsTimeoutRetryEnabled,
            depsTimeoutRetryEnabled
              ? SETUP_TIMEOUT_NATIVE_SETTLE_TIMEOUT_MS
              : 0,
          );
        } else if (id === 'content' && activityTimeoutEnabled) {
          await withProgressTimeout(
            operation,
            ms,
            onTimeout,
            (onProgress) => {
              activeContentTimeoutProgress = onProgress;
              return () => {
                if (activeContentTimeoutProgress === onProgress) {
                  activeContentTimeoutProgress = null;
                }
              };
            },
            cancel,
            ms * SETUP_STAGE_TIMEOUT_MAX_ELAPSED_MULTIPLIER,
          );
        } else if (id === 'indexing' && activityTimeoutEnabled) {
          await withProgressTimeout(
            operation,
            ms,
            onTimeout,
            (onProgress) => {
              activeIndexingOutputTimeoutProgress = onProgress;
              return () => {
                if (activeIndexingOutputTimeoutProgress === onProgress) {
                  activeIndexingOutputTimeoutProgress = null;
                }
              };
            },
            cancel,
            ms * SETUP_STAGE_TIMEOUT_MAX_ELAPSED_MULTIPLIER,
          );
        } else {
          await withTimeout(operation, ms, onTimeout, cancel);
        }
      } catch (err) {
        if (invocation.required) throw err;
      } finally {
        if (handle) {
          activeContentHandles.delete(handle);
        }
      }
    }
  }

  type DeferredDepsFailure = {
    details: StepTelemetryDetails;
    occurredAt: string;
    flagStatus: DepsTimeoutRetryFlagStatus;
    timedOut: boolean;
    retrySuppressed: boolean;
    retryScheduled: boolean;
    telemetryId?: string;
  };

  type StageRunResult =
    | { outcome: 'ok' }
    | {
        outcome: 'cancelled';
        retryAttempted?: boolean;
        retryResult?: DepsRetryResult;
      }
    | {
        outcome: 'failed';
        recovery: SetupStageRecoveryAction;
        depsFailure?: DeferredDepsFailure;
      };

  const CANCELLED_STAGE_RUN: StageRunResult = { outcome: 'cancelled' };

  type NativeStageFailureDetail = {
    failedDependency?: unknown;
    errorCategory?: unknown;
    errorKind?: unknown;
    errorOperation?: unknown;
    errorIoKind?: unknown;
    errorCode?: unknown;
  };

  async function stageFailureTelemetryDetails(
    id: StageId,
    error: unknown,
    failureScope: OnboardingFailureScope,
  ) {
    const timeoutCategory = error instanceof StageTimeoutError ? 'timeout' : undefined;
    const timeoutKind = error instanceof StageTimeoutError ? 'setup_stage_timeout' : undefined;
    let nativeDetail: NativeStageFailureDetail | undefined;
    try {
      nativeDetail = await invokeCommand<NativeStageFailureDetail | undefined>(
        'take_onboarding_failure_detail',
        { stage: id, ...failureScope },
      );
    } catch {
      // Failure-detail telemetry must not affect setup recovery or its copy.
      console.warn('[onboarding] setup failure detail was unavailable');
    }
    return setupFailureTelemetryDetails({
      stageId: id,
      errorCategory: timeoutCategory ?? nativeDetail?.errorCategory,
      errorKind: timeoutKind ?? nativeDetail?.errorKind,
      failedDependency: nativeDetail?.failedDependency,
      errorOperation: nativeDetail?.errorOperation,
      errorIoKind: nativeDetail?.errorIoKind,
      errorCode: nativeDetail?.errorCode,
    });
  }

  async function runStage(
    id: StageId,
    runId: number,
    attemptCount: number,
    depsTimeoutRetryStatus: Promise<DepsTimeoutRetryFlagStatus>,
  ): Promise<StageRunResult> {
    if (!isCurrentRun(runId)) return CANCELLED_STAGE_RUN;
    const setupRunId = currentSetupRunId;
    const depsRetryFlagStatus =
      id === 'deps' ? await depsTimeoutRetryStatus : 'disabled';
    const depsTimeoutRetryEnabled = depsRetryFlagStatus === 'enabled';
    if (!isCurrentRun(runId)) return CANCELLED_STAGE_RUN;
    const setupAttemptId =
      id === 'deps' && depsTimeoutRetryEnabled
        ? createSetupRunId()
        : setupRunId;
    if (id === 'deps') currentDepsAttemptId = setupAttemptId;
    const failureScope = {
      setupRunId: setupAttemptId,
      attemptCount,
      flow: onboardingFlow,
      frontendSessionId: onboardingTelemetry.sessionId,
    };
    const startedAt = Date.now();
    recordStep(SETUP_STEP_INDEX, 'started', {
      component: id,
      attemptCount,
      setupRunId,
    });
    // The attempt is under way, so the retry notice gives way to the stage's
    // own sub-steps.
    if (setupRetry?.stageId === id) setupRetry = null;
    stages = setStageStatus(stages, id, 'running');
    // The deps items are timed per tool in Rust; these three are timed here.
    const installTimer: InstallTimer | null =
      id === 'content' || id === 'initial-sync' || id === 'indexing'
        ? startInstallTimer(id, firstRunTimingLog)
        : null;
    await journalStageStart(id);

    const result = await invokeStageCommand(
      id,
      runId,
      failureScope,
      depsTimeoutRetryEnabled,
    ).then(
      () => ({ kind: 'done' as const }),
      (err) => ({ kind: 'failed' as const, err }),
    );
    installTimer?.finish(
      !isCurrentRun(runId) ? 'cancelled' : result.kind === 'done' ? 'ok' : 'failed',
    );

    if (!isCurrentRun(runId)) {
      recordStep(SETUP_STEP_INDEX, 'skipped', {
        component: id,
        attemptCount,
        durationMs: Date.now() - startedAt,
        outcome: 'cancelled',
        setupRunId,
      });
      return {
        outcome: 'cancelled',
        ...(id === 'deps' && attemptCount > 1
          ? {
              retryAttempted: true,
              retryResult: result.kind === 'done' ? 'recovered' : 'failed-again',
            }
          : {}),
      };
    }

    if (result.kind === 'done') {
      stages = setStageStatus(stages, id, 'ok');
      await journalStageOk(id);
      recordStep(SETUP_STEP_INDEX, 'completed', {
        component: id,
        attemptCount,
        durationMs: Date.now() - startedAt,
        setupRunId,
      });
      return { outcome: 'ok' };
    }
    if (result.kind === 'failed') {
      const message = errorMessage(result.err);
      // Decide recovery before the status lands: a stage that will try again
      // must never pass through 'failed', which would count it as settled and
      // then un-count it, jolting the ring forward and straight back.
      const occurredAt = new Date().toISOString();
      const recovery = setupStageRecoveryAction({
        stageId: id,
        message,
        retryCount: attemptCount - 1,
        depsTimeoutRetryEnabled,
        depsTimeoutRetrySuppressed:
          result.err instanceof StageTimeoutError &&
          result.err.retrySuppressed,
      });
      stages = setStageStatus(
        stages,
        id,
        recovery.kind === 'retry' ? 'retrying' : 'failed',
        message,
      );
      await journalStageFailure(id, message);
      const failureDetails = await stageFailureTelemetryDetails(id, result.err, failureScope);
      if (!isCurrentRun(runId)) {
        return {
          outcome: 'cancelled',
          ...(id === 'deps' && attemptCount > 1
            ? { retryAttempted: true, retryResult: 'failed-again' as const }
            : {}),
        };
      }
      const details: StepTelemetryDetails = {
        component: id,
        failureStage: id,
        attemptCount,
        durationMs: Date.now() - startedAt,
        outcome: 'stage_command_failed',
        setupRunId,
        ...failureDetails,
      };
      if (id === 'deps') {
        return {
          outcome: 'failed',
          recovery,
          depsFailure: {
            details,
            occurredAt,
            flagStatus: depsRetryFlagStatus,
            timedOut: result.err instanceof StageTimeoutError,
            retrySuppressed:
              result.err instanceof StageTimeoutError && result.err.retrySuppressed,
            retryScheduled: false,
          },
        };
      }
      recordStep(SETUP_STEP_INDEX, 'failed', details, undefined, occurredAt);
      return { outcome: 'failed', recovery };
    }
    return CANCELLED_STAGE_RUN;
  }

  function waitForAutoRetry(ms: number): Promise<void> {
    if (!(ms > 0)) return Promise.resolve();
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function failFirstFolderSyncAttempt(): void {
    firstFolderSyncBusy = false;
    firstFolderSyncAwaitingCompletion = false;
    firstFolderSyncObservedFailure = false;
    firstFolderSyncStarted = false;
    firstFolderSyncError = true;
  }

  function handleFirstFolderSyncComplete(payload: unknown): void {
    if (!firstFolderSyncAwaitingCompletion || firstFolderSyncCompleted) return;
    const result = payload as { errors?: unknown } | null;
    const errors = result && Array.isArray(result.errors) ? result.errors : null;
    const otherErrors = (errors ?? []).filter((entry) => {
      const message = isRecord(entry) ? entry.message : entry;
      const uid = companyUidFromMissingBucket(message);
      if (uid) firstFolderMissingBucketUids.add(uid);
      return !isMissingBucketMessage(message) || !uid;
    });
    if (!errors || otherErrors.length > 0 || firstFolderSyncObservedFailure) {
      failFirstFolderSyncAttempt();
      return;
    }
    if (firstFolderMissingBucketUids.size > 0) {
      void selfHealMissingBuckets([...firstFolderMissingBucketUids]);
      return;
    }

    firstFolderSyncBusy = false;
    firstFolderSyncAwaitingCompletion = false;
    firstFolderSyncObservedFailure = false;
    firstFolderSyncCompleted = true;
    firstFolderSyncError = false;
    recordStep(FIRST_FOLDER_SYNC_STEP_INDEX, 'completed');
    if (currentStep === FIRST_FOLDER_SYNC_STEP_INDEX) {
      advanceTo(nextAfterFirstFolderSync(), null);
    }
  }

  function handleFirstFolderSyncAuthError(_payload: { message?: string }): void {
    if (!firstFolderSyncAwaitingCompletion || firstFolderSyncCompleted) return;
    failFirstFolderSyncAttempt();
  }

  /**
   * Self-heal: the first sync found a company with no bucket ("has no bucket
   * provisioned"). Ask hq-pro to finish provisioning, show "Finishing setup…",
   * then sync again. Once per attempt; "Try again" starts a fresh attempt.
   */
  async function selfHealMissingBuckets(uids: string[]): Promise<void> {
    if (firstFolderSelfHealAttempted) {
      failFirstFolderSyncAttempt();
      return;
    }
    firstFolderSelfHealAttempted = true;
    firstFolderSelfHealing = true;
    firstFolderSyncBusy = true;
    let failedStep: string | null = null;
    for (const companyUid of uids) {
      recordStep(FIRST_FOLDER_SYNC_STEP_INDEX, 'started', { selfHeal: 'triggered', companyUid });
      let state = await requestCompanyProvisioning(invokeCommand, companyUid);
      if (state.status === 'pending') {
        state = await waitForProvisioning({
          invoke: invokeCommand,
          companyUid,
          timeoutMs: firstFolderSelfHealTimeoutMs,
          intervalMs: firstFolderSelfHealIntervalMs,
          cancelled: () => !mounted,
        });
      }
      if (!mounted) return;
      if (state.status !== 'ready') {
        failedStep = state.status === 'failed' ? state.step : 'timeout';
        recordStep(FIRST_FOLDER_SYNC_STEP_INDEX, 'failed', {
          selfHeal: 'failed',
          companyUid,
          provisioningStep: failedStep,
        });
        break;
      }
      recordStep(FIRST_FOLDER_SYNC_STEP_INDEX, 'started', { selfHeal: 'succeeded', companyUid });
    }
    firstFolderSelfHealing = false;
    firstFolderMissingBucketUids.clear();
    if (failedStep !== null) {
      failFirstFolderSyncAttempt();
      return;
    }
    firstFolderSyncBusy = false;
    firstFolderSyncAwaitingCompletion = false;
    firstFolderSyncStarted = false;
    await startFirstFolderSync(true);
  }

  async function startFirstFolderSync(fromSelfHeal = false): Promise<void> {
    if (firstFolderSyncBusy || firstFolderSyncStarted || firstFolderSyncCompleted) return;
    if (!fromSelfHeal) firstFolderSelfHealAttempted = false;
    firstFolderMissingBucketUids.clear();
    firstFolderSyncStarted = true;
    firstFolderSyncAwaitingCompletion = true;
    firstFolderSyncObservedFailure = false;
    firstFolderSyncBusy = true;
    firstFolderSyncError = false;
    recordStep(FIRST_FOLDER_SYNC_STEP_INDEX, 'started');
    try {
      await startTraySync(onboardingFeatureFlags);
    } catch (error) {
      console.warn('onboarding: first-folder sync could not be started', error);
      if (!firstFolderSyncCompleted) {
        firstFolderSyncBusy = false;
        firstFolderSyncAwaitingCompletion = false;
        firstFolderSyncStarted = false;
        firstFolderSyncError = true;
      }
    }
  }

  async function runSetup(
    runId: number,
    startStage: StageId = STAGE_ORDER[0],
    depsTimeoutRetryStatus: Promise<DepsTimeoutRetryFlagStatus> = Promise.resolve('disabled'),
  ) {
    const startIndex = Math.max(0, STAGE_ORDER.indexOf(startStage));
    const retryCounts = new Map<StageId, number>();
    const pendingDepsFailures: DeferredDepsFailure[] = [];
    const recordDepsFailure = (
      failure: DeferredDepsFailure,
      retryAttempted: boolean,
      retryResult: DepsRetryResult,
    ) => {
      const didRetryThisFailure = depsRetryWasAttemptedForFailure(
        failure.retryScheduled,
        retryAttempted,
      );
      const retryTelemetry = depsTimeoutRetryTelemetry({
        flagStatus: failure.flagStatus,
        timedOut: failure.timedOut,
        retrySuppressed: failure.retrySuppressed,
        retryAttempted: didRetryThisFailure,
        retryRecovered: didRetryThisFailure && retryResult === 'recovered',
      });
      if (failure.telemetryId) {
        onboardingTelemetry.resolveDeferred(failure.telemetryId, retryTelemetry);
      } else {
        recordStep(
          SETUP_STEP_INDEX,
          'failed',
          { ...failure.details, ...retryTelemetry },
          undefined,
          failure.occurredAt,
        );
      }
    };
    const flushPendingDepsFailures = (
      retryAttempted: boolean,
      retryResult: DepsRetryResult,
    ) => {
      for (const failure of pendingDepsFailures) {
        recordDepsFailure(failure, retryAttempted, retryResult);
      }
      pendingDepsFailures.length = 0;
    };
    const skippedRetryResult = (failure: DeferredDepsFailure): DepsRetryResult => {
      if (!failure.timedOut || failure.retrySuppressed) return 'not-eligible';
      if (failure.flagStatus === 'unreadable') return 'skipped-flag-unreadable';
      if (failure.flagStatus === 'disabled') return 'skipped-flag-off';
      return 'not-eligible';
    };
    // Runs `ids` in order. False means the run stopped (superseded or
    // cancelled) and nothing after it may run.
    const runStageList = async (ids: readonly StageId[]): Promise<boolean> => {
    for (const id of ids) {
      if (!isCurrentRun(runId)) return false;
      while (isCurrentRun(runId)) {
        const attemptCount = (retryCounts.get(id) ?? 0) + 1;
        const result = await runStage(
          id,
          runId,
          attemptCount,
          depsTimeoutRetryStatus,
        );
        if (result.outcome === 'cancelled') {
          if (pendingDepsFailures.length > 0) {
            flushPendingDepsFailures(
              result.retryAttempted ?? false,
              result.retryResult ?? 'not-eligible',
            );
          }
          return false;
        }
        if (result.outcome === 'ok') {
          if (pendingDepsFailures.length > 0) {
            flushPendingDepsFailures(true, 'recovered');
          }
          break;
        }

        if (result.depsFailure) {
          const failure = result.depsFailure;
          failure.retryScheduled = false;
          failure.telemetryId = recordDeferredSetupFailure(failure, {
            retryAttempted: false,
            retryResult: skippedRetryResult(failure),
          });
          pendingDepsFailures.push(failure);
        }
        const action = result.recovery;
        if (action.kind !== 'retry') {
          if (pendingDepsFailures.length > 1) {
            flushPendingDepsFailures(true, 'failed-again');
          } else if (pendingDepsFailures.length === 1) {
            const [failure] = pendingDepsFailures;
            if (failure) recordDepsFailure(failure, false, skippedRetryResult(failure));
            pendingDepsFailures.length = 0;
          }
          break;
        }

        retryCounts.set(id, action.nextRetryCount);
        // The stage keeps its place in the bands while it waits — it is still
        // 'retrying', not 'pending' — and only the sub-status changes. A
        // backend detail from the attempt that just failed is stale.
        setupRetry = { stageId: id, attempt: setupRetryAttempt(id, action.nextRetryCount) };
        stageDetail = null;
        await waitForAutoRetry(action.delayMs);
        if (!isCurrentRun(runId)) {
          if (pendingDepsFailures.length > 0) {
            flushPendingDepsFailures(false, 'not-eligible');
          }
          return false;
        }
        const retryingFailure = pendingDepsFailures.at(-1);
        if (retryingFailure) {
          retryingFailure.retryScheduled = true;
          if (retryingFailure.telemetryId) {
            onboardingTelemetry.markDeferredRetryAttempted(retryingFailure.telemetryId);
          }
        }
      }
    }
    return isCurrentRun(runId);
    };

    retryFailedBlocking = async () => {
      if (!isCurrentRun(runId) || blockingRetryRunning) return;
      const ids = stages
        .filter(
          (stage) =>
            stage.status === 'failed' &&
            (BLOCKING_STAGES as readonly StageId[]).includes(stage.id),
        )
        .map((stage) => stage.id);
      if (ids.length === 0) return;
      const token = blockingRetryGate.begin();
      blockingRetryRunning = true;
      retryingStageId = ids[0];
      readyDwellElapsed = false;
      for (const id of ids) {
        retryCounts.delete(id);
        stages = setStageStatus(stages, id, 'pending', null);
      }
      try {
        // The workspace step rewrites the files the background upload and
        // index read, so it waits for this run's background phase to end.
        if (ids.includes('content') && backgroundRunId === runId && backgroundPhaseRunning) {
          await backgroundPhaseDone;
        }
        for (const id of ids) {
          if (!isCurrentRun(runId)) break;
          retryingStageId = id;
          if (!(await runStageList([id]))) break;
        }
      } finally {
        if (blockingRetryGate.end(token)) {
          blockingRetryRunning = false;
          retryingStageId = null;
        }
      }
      // The background phase may have ended while this retry ran; its own
      // completion check saw the retried step still running and passed. A
      // background phase that ended before Try again already completed setup
      // with the failed step, and this call does nothing.
      if (isCurrentRun(runId) && backgroundOkRunId === runId && !backgroundPhaseRunning) {
        await completeSetup(runId);
      }
    };

    // US-004: the person waits only on the blocking phase (local files, git,
    // personalize, person entity). Tool installs, the vault upload and
    // indexing run after the decision screen opens.
    const { blocking, background } = partitionStages(STAGE_ORDER[startIndex]);
    const blockingOk = await runStageList(blocking);
    if (!isCurrentRun(runId)) return;
    if (!blockingOk) {
      // A blocking stage was cancelled; the run stops here and a resumed
      // run writes the phase line.
      return;
    }
    // The consent answer and the first upload both need the person entity,
    // so it is created before the decision screen. A failure here is retried
    // by the consent path and by the initial-sync stage.
    try {
      personEntityNeedsRetry = !(await invokeCommand<boolean>('ensure_person_entity'));
    } catch (err) {
      personEntityNeedsRetry = true;
      console.warn('[onboarding-setup] ensure_person_entity failed:', err);
    }
    if (!isCurrentRun(runId)) return;
    logFirstRunPhaseOnce('blocking', 'ok');
    blockingPhaseDone = true;
    void runBackgroundPhase(runId, background, runStageList);
    // The optional follow-on steps need the person entity, not the tools
    // install, so they are looked up now and the ready screen can offer them
    // while the background phase runs.
    void resolvePostSetupSteps(() => isCurrentRun(runId) && mounted);
  }

  /**
   * Record the blocking phase's elapsed time once per install. A retry or a
   * resumed run does not log it again: the first measurement is the one the
   * 60 second budget is checked against.
   */
  function logFirstRunPhaseOnce(phase: 'blocking' | 'background', result: 'ok' | 'failed'): void {
    if (loggedFirstRunPhases.has(phase)) return;
    loggedFirstRunPhases.add(phase);
    invokeCommand('log_first_run_phase', { phase, result }).catch((err: unknown) => {
      console.warn('[onboarding-setup] log_first_run_phase failed:', err);
    });
  }

  function setBackgroundSetupFlag(running: boolean): void {
    invokeCommand('set_first_run_background_setup', { running }).catch((err: unknown) => {
      console.warn('[onboarding-setup] set_first_run_background_setup failed:', err);
    });
  }

  /**
   * The background phase. It is not awaited by runSetup, so the decision
   * screen opens while it runs. It survives the wizard closing (the person
   * opened HQ Desktop): onDestroy leaves it running, and it releases the
   * listeners itself when it ends on an unmounted wizard.
   */
  async function runBackgroundPhase(
    runId: number,
    ids: readonly StageId[],
    runStageList: (ids: readonly StageId[]) => Promise<boolean>,
  ): Promise<void> {
    backgroundRunId = runId;
    backgroundPhaseRunning = true;
    let markBackgroundPhaseDone = () => {};
    backgroundPhaseDone = new Promise<void>((resolve) => {
      markBackgroundPhaseDone = resolve;
    });
    setBackgroundSetupFlag(true);
    let backgroundOk = false;
    try {
      backgroundOk = await runStageList(ids);
    } catch (err) {
      console.warn('[onboarding-setup] background phase failed:', err);
    } finally {
      // A retry or resume starts a new run; only the run that set the flag
      // clears it, so a superseded run cannot release the newer run's hold.
      if (backgroundRunId === runId) {
        if (backgroundOk) backgroundOkRunId = runId;
        backgroundPhaseRunning = false;
        setBackgroundSetupFlag(false);
      }
      markBackgroundPhaseDone();
    }
    if (isCurrentRun(runId)) {
      logFirstRunPhaseOnce('background', backgroundOk ? 'ok' : 'failed');
      if (backgroundOk) await completeSetup(runId);
    }
    if (!mounted && backgroundRunId === runId) cancelSetupRun({ leaveHostInstalls: true });
  }

  async function completeSetup(runId: number): Promise<void> {
    if (isCurrentRun(runId) && !setupCompleted && allSettled(stages)) {
      setupCompleted = true;
      const result = setupCompletionResult(stages);
      const failedStages = normalizeFailedStageIds(result.failedStages.map((stage) => stage.id));
      markSetupStepCompleted();
      await journalInstallComplete();
      setupCompletionMetrics = {
        stageCount: stages.length,
        failedStageCount: result.failedStages.length,
        failedStages,
        setupRunId: currentSetupRunId,
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
      void emitDesktopOperationalTelemetry({
        eventName: 'desktop_setup_completed',
        properties: { ...setupCompletionMetrics },
      });
      // Setup is what provisions the person entity; stitch the install session.
      void resolveInstallerPersonUid();
      // The install ran in the background while the person carried on through
      // the story, so it no longer moves the wizard: it records its own
      // completion wherever the person is. A held consent answer is sent, and
      // the optional first-folder sync, teammate invite and connector offer are
      // made, from effects keyed on `blockingPhaseDone` (or `setupCompleted`).
      recordStep(SETUP_STEP_INDEX, 'completed', {
        failedStageCount: result.failedStages.length,
        failedStages,
        setupRunId: currentSetupRunId,
        outcome: result.failedStages.length === 0 ? 'all_stages_completed' : 'completed_with_failures',
      });
      // Both follow-on steps are optional. The invite path appears only for a
      // company with one active member; every membership lookup fails closed.
      // They were looked up when the blocking phase ended; a run that reached
      // completion without that lookup settling looks them up here.
      if (!postSetupStepsResolved) await resolvePostSetupSteps(() => isCurrentRun(runId) && mounted);
    }
  }

  /**
   * US-023: whether the signed-in account is new or returning, read once from
   * `/membership/me` (with company history) after sign-in. A returning
   * account skips the new-person steps and has its companies pulled onto
   * this Mac before Ready. A lookup that keeps failing after the person
   * entity exists shows an error with Try again on the Ready screen; it never
   * falls back to the new-person steps.
   */
  let accountKind = $state<AccountKind | null>(null);
  let accountLookupFailed = $state(false);
  let accountLookupRetrying = $state(false);
  let accountKindResolution: Promise<AccountKind> | null = null;
  let accountKindGeneration = 0;
  let accountKindRecorded = false;
  const returningAccount = $derived(accountKind?.kind === 'returning');
  const returningCompanyNames = $derived(
    accountKind?.kind === 'returning' ? listCompanyNames(accountKind.companies.map((company) => company.name)) : '',
  );

  /** The Ready heading for a returning account, or null for the usual one. */
  const returningReadyHeading = $derived.by(() => {
    if (accountKind?.kind !== 'returning' || accountLookupFailed) return null;
    const pulling = companyPullRows.length > 0 && !companyPullClear;
    if (pulling && returningCompanyNames) return `Welcome back. Bringing ${returningCompanyNames} to this Mac.`;
    const here = companyPullRows.filter((row) => row.status === 'done').map((row) => row.name);
    if (here.length === 0) return 'Welcome back. HQ is ready.';
    return `Welcome back. ${listCompanyNames(here)} ${here.length === 1 ? 'is' : 'are'} on this Mac.`;
  });

  function companyPullRowLabel(row: CompanyPullRow): string {
    if (row.status === 'queued') return 'Waiting';
    if (row.status === 'pulling') return 'Pulling';
    if (row.status === 'done') return 'Ready';
    return `Couldn't pull ${row.name}`;
  }

  /** "Acme", "Acme and Globex", "Acme, Globex and Initech". */
  function listCompanyNames(names: readonly string[]): string {
    const clean = names.map((name) => name.trim()).filter(Boolean);
    if (clean.length <= 1) return clean[0] ?? '';
    return `${clean.slice(0, -1).join(', ')} and ${clean[clean.length - 1]}`;
  }

  function resetAccountKind(): void {
    accountKindGeneration += 1;
    accountKind = null;
    accountLookupFailed = false;
    accountLookupRetrying = false;
    accountKindResolution = null;
    accountKindRecorded = false;
    companyPullGeneration += 1;
    companyPullRows = [];
    companyPullStarted = false;
    companyPullRunning = false;
    companyPullContinued = false;
  }

  /** One shared account-kind lookup; a failed one is forgotten so the next caller asks again. */
  function ensureAccountKind(): Promise<AccountKind> {
    if (accountKindResolution) return accountKindResolution;
    const generation = accountKindGeneration;
    const resolution = resolveAccountKind({
      readMembershipMe,
      invalidateMembershipMeRead: () => {
        membershipMeRead = null;
      },
    }).then((result) => {
      if (generation !== accountKindGeneration) return result;
      if (result.kind === 'lookup_failed') {
        if (accountKindResolution === resolution) accountKindResolution = null;
        return result;
      }
      accountKind = result;
      accountLookupFailed = false;
      if (!accountKindRecorded) {
        accountKindRecorded = true;
        recordStep(SETUP_STEP_INDEX, 'started', {
          accountKind: result.kind,
          ...(result.kind === 'returning' ? { accountSignal: result.signal } : {}),
        });
      }
      void invokeCommand('set_account_kind', { kind: result.kind }).catch((error) => {
        console.warn('onboarding: account kind could not be remembered', error);
      });
      return result;
    });
    accountKindResolution = resolution;
    return resolution;
  }

  /** Try again on the lookup error: ask the server again, then route as usual. */
  async function retryAccountLookup(): Promise<void> {
    if (accountLookupRetrying) return;
    accountLookupRetrying = true;
    membershipMeRead = null;
    accountKindResolution = null;
    resetCompanyRoute();
    try {
      await resolveCompanyStep();
      if (returningAccount) startReturningCompanyPull();
    } finally {
      accountLookupRetrying = false;
    }
  }

  /** The returning account's companies, being pulled onto this Mac. */
  let companyPullRows = $state<CompanyPullRow[]>([]);
  let companyPullRunning = $state(false);
  /** The person chose Continue past a failed pull; HQ's auto-pull keeps trying. */
  let companyPullContinued = $state(false);
  let companyPullStarted = false;
  let companyPullGeneration = 0;
  /** About the native runner's own 10-minute hard timeout, plus a margin. */
  const COMPANY_PULL_SYNC_TIMEOUT_MS = 11 * 60_000;
  let companyPullWaiter: {
    aborted: boolean;
    errors: Array<{ company?: string; message: string }>;
    finish: (result: CompanyPullRunResult) => void;
  } | null = null;
  const companyPullFailedRows = $derived(pullFailures(companyPullRows));
  const companyPullSettled = $derived(pullSettled(companyPullRows) && !companyPullRunning);
  /** Ready may finish: every company is here, or the person chose Continue after a failure. */
  const companyPullClear = $derived(
    accountKind?.kind !== 'returning' ||
      (companyPullRows.length === 0 && !accountKind.companies.some((company) => company.slug)) ||
      (companyPullRows.length > 0 &&
        companyPullSettled && (pullSucceeded(companyPullRows) || companyPullContinued)),
  );

  function syncErrorEntries(errors: unknown): Array<{ company?: string; message: string }> {
    if (!Array.isArray(errors)) return [];
    return errors.map((entry) => {
      if (isRecord(entry)) {
        return {
          ...(typeof entry.company === 'string' ? { company: entry.company } : {}),
          message: typeof entry.message === 'string' ? entry.message : 'sync error',
        };
      }
      return { message: typeof entry === 'string' ? entry : 'sync error' };
    });
  }

  /**
   * Start one scoped sync and resolve with what it reported. The waiter is in
   * place before the sync starts, so a fast `sync:all-complete` is not missed.
   */
  function runCompanyPullSync(slug: string): Promise<CompanyPullRunResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => finish({ errors: [], aborted: false, timedOut: true }), COMPANY_PULL_SYNC_TIMEOUT_MS);
      const waiter = {
        aborted: false,
        errors: [] as Array<{ company?: string; message: string }>,
        finish: (result: CompanyPullRunResult) => finish(result),
      };
      function release(): void {
        settled = true;
        window.clearTimeout(timer);
        if (companyPullWaiter === waiter) companyPullWaiter = null;
      }
      function finish(result: CompanyPullRunResult): void {
        if (settled) return;
        release();
        resolve(result);
      }
      function fail(error: unknown): void {
        if (settled) return;
        release();
        reject(error);
      }
      companyPullWaiter = waiter;
      onboardingFeatureFlags.sync.startSync(slug).then(
        (started) => {
          if (!started.ok) fail(new Error(started.message));
        },
        fail,
      );
    });
  }

  function handleCompanyPullAllComplete(payload: unknown): void {
    const waiter = companyPullWaiter;
    if (!waiter) return;
    const result = payload as { errors?: unknown } | null;
    waiter.finish({
      errors: [...waiter.errors, ...syncErrorEntries(result?.errors)],
      aborted: waiter.aborted,
    });
  }

  /** Pull the returning account's companies (all of them, or only the ones named on Try again). */
  async function runReturningCompanyPull(only?: string[]): Promise<void> {
    if (companyPullRunning) return;
    const generation = companyPullGeneration;
    const current = () => mounted && generation === companyPullGeneration;
    companyPullRunning = true;
    if (only) companyPullContinued = false;
    try {
      await runCompanyPull({
        rows: companyPullRows,
        only,
        deps: {
          runSync: runCompanyPullSync,
          provision: async (companyUid) => {
            const state = await requestCompanyProvisioning(invokeCommand, companyUid);
            if (state.status !== 'pending') return state;
            return waitForProvisioning({
              invoke: invokeCommand,
              companyUid,
              timeoutMs: firstFolderSelfHealTimeoutMs,
              intervalMs: firstFolderSelfHealIntervalMs,
              cancelled: () => !current(),
            });
          },
          cancelled: () => !current(),
        },
        onRows: (rows) => {
          if (current()) companyPullRows = rows;
        },
        onOutcome: (outcome) => {
          if (!current()) return;
          recordStep(FIRST_FOLDER_SYNC_STEP_INDEX, outcome.outcome === 'done' ? 'completed' : 'failed', {
            companyUid: outcome.companyUid,
            companyPull: outcome.outcome,
            attemptCount: outcome.attempt,
            ...(outcome.errorKind ? { companyPullError: outcome.errorKind } : {}),
            ...(outcome.selfHealed ? { selfHeal: outcome.outcome === 'done' ? 'succeeded' : 'failed' } : {}),
          });
        },
      });
    } finally {
      if (current()) companyPullRunning = false;
    }
  }

  /** Start the pull once, after the person entity exists and the account is known to be returning. */
  function startReturningCompanyPull(): void {
    if (companyPullStarted || accountKind?.kind !== 'returning' || !blockingPhaseDone) return;
    companyPullStarted = true;
    companyPullRows = initialPullRows(
      accountKind.companies
        .filter((company) => company.slug)
        .map((company) => ({ companyUid: company.companyUid, slug: company.slug!, name: company.name })),
    );
    void runReturningCompanyPull();
  }

  /** Forget the company lookup (account switch): the next call looks again. */
  function resetCompanyRoute(): void {
    companyRouteGeneration += 1;
    companyRouteResolution = null;
    companyRouteResolved = false;
  }

  /**
   * Look up which way the company step goes (create, join, existing, skip),
   * once. Started on the second setup explainer (or when the explainers are
   * skipped) so the step can come before the ready screen; awaited again once setup completes. A lookup that fails is
   * forgotten, so the post-setup call tries again (the person entity is
   * provisioned during setup, and the old after-setup timing still works).
   */
  function resolveCompanyStep(): Promise<void> {
    if (!companyRouteResolution) {
      const generation = companyRouteGeneration;
      companyRouteResolution = lookUpCompanyRoute(() => mounted && generation === companyRouteGeneration);
    }
    return companyRouteResolution;
  }

  async function lookUpCompanyRoute(stillCurrent: () => boolean): Promise<void> {
    // A lookup that starts once the blocking phase is done has the person
    // entity to look up with, so its answer is final.
    const afterPersonEntity = blockingPhaseDone || setupCompleted;
    if ((await probeMachineIdentity()).active) {
      // An outpost has no person entity: there is no membership to look up,
      // no company to name and no teammate to invite. Its company is the
      // app's active one (the outpost was enrolled into it), used only for
      // the connector import.
      const active = await activeCompanyForConnectorImport();
      if (!stillCurrent()) return;
      companyPath = null;
      inviteTeammateContext = null;
      showInviteTeammateStep = false;
      connectorImportCompany = active;
      companyRouteResolved = true;
      return;
    }
    const account = await ensureAccountKind();
    if (!stillCurrent()) return;
    if (account.kind === 'lookup_failed') {
      // Never fall back to the new-person steps, and never offer the
      // create-company recovery, on a lookup that failed.
      companyPath = null;
      inviteTeammateContext = null;
      showInviteTeammateStep = false;
      if (afterPersonEntity) {
        accountLookupFailed = true;
        recordCompanyRouteLookupFailed();
        companyRouteResolved = true;
      } else {
        // Too early (before the person entity); the post-setup lookup looks again.
        companyRouteResolution = null;
      }
      return;
    }
    if (account.kind === 'returning') {
      // A returning account is not asked to create or join a company: its
      // primary company becomes the app's active one, and the Ready screen
      // pulls every company onto this Mac. The teammate invite and the
      // connector import stay as they are for a person already in a company.
      companyPath = null;
      if (account.primary) {
        // Record the route the new-person flow would have taken, as skipped,
        // so company-route telemetry stays comparable across both kinds.
        const route = decideCompanyRoute({ companies: account.companies, invites: [], signedInEmail: null });
        const summary = summarizeRoute(route, account.companies, []);
        recordStep(SETUP_STEP_INDEX, 'skipped', {
          outcome: `route_${route.decision}`,
          decision: route.decision,
          existingCompanies: summary.existingCompanies,
          paidCompany: summary.paidCompany,
          pendingInvites: summary.pendingInvites,
          companyUid: account.primary.companyUid,
        });
        companyStepCompanyUid = account.primary.companyUid;
        recordWorkspaceSelected(account.primary.companyUid);
        await selectCompany(account.primary.slug);
        if (!stillCurrent()) return;
      }
      const inviteResolution = account.primary ? await resolveInviteTeammateContext() : null;
      if (!stillCurrent()) return;
      inviteTeammateContext = inviteResolution?.context ?? null;
      showInviteTeammateStep = inviteTeammateContext !== null;
      if (inviteResolution && inviteResolution.context === null && !inviteStepHiddenTelemetryRecorded) {
        inviteStepHiddenTelemetryRecorded = true;
        recordStep(INVITE_TEAMMATE_STEP_INDEX, 'skipped', {
          outcome: inviteResolution.hiddenReason,
          companyUid: account.primary!.companyUid,
        });
      }
      connectorImportCompany = account.primary ? (account.primary.slug ?? account.primary.companyUid) : null;
      companyRouteResolved = true;
      startReturningCompanyPull();
      return;
    }
    const retryCompanyLookup = resolveCompanyRouteLookupRetryFlag();
    const [email, anonId] = await Promise.all([
      resolveSignedInEmail(),
      invokeCommand<string | null>('web_visitor_anon_id').catch(() => null),
    ]);
    const firstRunCompanyPathPromise = resolveFirstRunCompanyRoute({
      hqProJson: companyStepHqProJson,
      invoke: invokeCommand,
      signedInEmail: email,
      anonId,
      enableMembershipLookupRetry: retryCompanyLookup,
      invalidateMembershipMeRead: () => {
        membershipMeRead = null;
      },
    });
    const firstRunCompanyPath = await firstRunCompanyPathPromise;
    // Resolve invite eligibility after the company route has completed its
    // retry so it can use the recovered shared membership response.
    const inviteResolution =
      firstRunCompanyPath !== null && 'route' in firstRunCompanyPath
        ? await resolveInviteTeammateContext()
        : null;
    const inviteContext = inviteResolution?.context ?? null;
    if (!stillCurrent()) return;
    if (firstRunCompanyPath && 'route' in firstRunCompanyPath) {
      companyPath = firstRunCompanyPath.route;
      recordCompanyRoute(firstRunCompanyPath.route, firstRunCompanyPath.summary);
      inviteTeammateContext = inviteContext;
      showInviteTeammateStep = inviteContext !== null;
      if (
        inviteResolution &&
        inviteResolution.context === null &&
        !inviteStepHiddenTelemetryRecorded
      ) {
        inviteStepHiddenTelemetryRecorded = true;
        recordStep(INVITE_TEAMMATE_STEP_INDEX, 'skipped', {
          outcome: inviteResolution.hiddenReason,
          ...(companyStepCompanyUid ? { companyUid: companyStepCompanyUid } : {}),
        });
      }
      companyRouteResolved = true;
      return;
    }
    companyPath = null;
    inviteTeammateContext = null;
    showInviteTeammateStep = false;
    if (firstRunCompanyPath?.kind === 'lookup_failed') recordCompanyRouteLookupFailed();
    // The lookup could not say which company this person is in. The app's
    // active company still names one when there is one; the connector import
    // is skipped only when there is none.
    const active = await activeCompanyForConnectorImport();
    if (!stillCurrent()) return;
    connectorImportCompany = active;
    if (afterPersonEntity) {
      // There is no later attempt: settle on no company step.
      companyRouteResolved = true;
    } else {
      // Too early (before the person entity); the post-setup lookup looks again.
      companyRouteResolution = null;
    }
  }

  /** The optional follow-on steps after setup; re-run after an account switch. */
  async function resolvePostSetupSteps(stillCurrent: () => boolean): Promise<void> {
    if (personEntityNeedsRetry && !personEntityRetry) {
      // Share one retry across concurrent post-setup resolutions. A failed
      // blocking-phase person write must not make the company lookup final.
      personEntityNeedsRetry = false;
      personEntityRetry = (async () => {
        try {
          await invokeCommand<boolean>('ensure_person_entity');
        } catch (err) {
          console.warn('[onboarding-setup] person entity retry failed:', err);
        }
        if (!stillCurrent()) return;
        membershipMeRead = null;
        resetCompanyRoute();
      })();
    }
    if (personEntityRetry) await personEntityRetry;
    if (!stillCurrent()) return;
    const [firstFolderEnabled] = await Promise.all([
      resolveFirstFolderSyncStepFlag(),
      resolveCompanyStep().then(() => {
        // A lookup started before the person entity existed and failed is
        // forgotten; look once more now that it exists.
        if (!companyRouteResolved && stillCurrent()) return resolveCompanyStep();
      }),
    ]);
    if (!stillCurrent()) return;
    // A returning account with companies gets the company pull in place of
    // the first folder sync: it brings every company folder, not just one.
    const pullingCompanies = accountKind?.kind === 'returning' && accountKind.companies.some((company) => company.slug);
    showFirstFolderSyncStep = firstFolderEnabled && !pullingCompanies;
    postSetupStepsResolved = true;
    startReturningCompanyPull();
  }

  /**
   * Leave the setup explainers for the ready screen.
   * There is no company screen (US-007): the membership lookup keeps running
   * in the background, a company the person already belongs to connects on
   * its own, and a personal setup needs no company.
   */
  async function leaveExplainers(): Promise<void> {
    if (leavingExplainers) return;
    leavingExplainers = true;
    try {
      if (!consentOnly && !replay) void resolveCompanyStep();
      advanceTo(READY_STEP_INDEX, null);
    } finally {
      leavingExplainers = false;
    }
  }

  interface SetupCompletionMetrics {
    stageCount: number;
    failedStageCount: number;
    failedStages: StageId[];
    setupRunId: string;
    detectedToolCount: number;
  }
  let setupCompletionMetrics = $state<SetupCompletionMetrics | null>(null);

  /**
   * Record the telemetry answer. Returns whether it was recorded; only a
   * write the SERVER confirmed (or, during an install, an answer held on this
   * machine) counts. Called from the consent screen's Continue in the
   * consent-only runs, and from every finish on the first-run ready screen
   * (`finishWithRecovery`). Declining is first-class: it records the answer,
   * withholds no product capability, and finishes setup exactly like sharing
   * does.
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
  async function submitConsent(): Promise<boolean> {
    if (telemetryChoice === null || consentSubmitting) return false;
    consentSubmitting = true;
    consentFailure = null;
    const enabled = telemetryChoice === 'share';
    // Welcome flow: the question now comes while the install is still running
    // in the background, before the person entity exists. The answer is cached
    // locally with its provenance right away and the person carries on; the
    // remote write happens once the install is ready (`flushDeferredConsent`),
    // with the same honest failure states. If even the local cache fails there
    // is nothing to hold, so fall through to the immediate write below.
    if (shouldDeferConsent({ consentOnly, installPending })) {
      const held = await holdConsentAnswer(enabled);
      if (held) {
        deferredConsent = held;
        consentSubmitting = false;
        recordStep(CONSENT_STEP_INDEX, 'completed', { outcome: 'answer_held_until_install' });
        return true;
      }
    }
    try {
      // AC1 — make the ordering explicit. Ensure the person entity exists
      // before the opt-in POST fires. This resolves from cache instantly on the
      // common path; only a fresh install with in-flight provisioning waits.
      // In re-prompt mode the entity already exists (the person has been running
      // HQ), so this is a fast confirmation, not a bootstrap.
      try {
        await invokeCommand<boolean>('ensure_person_entity');
        void resolveInstallerPersonUid();
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
        return false;
      }

      if (consentOnly) {
        // The stale record is now replaced with a fully versioned one. Record
        // that the re-prompt was answered for this person+version (idempotent
        // with the dismissal guard) and close — there is no ready screen.
        if (repromptPersonUid) {
          await markConsentRepromptShown(TELEMETRY_CONSENT_VERSION, repromptPersonUid);
        }
        await finishWithRecovery();
        return true;
      }

      recordStep(CONSENT_STEP_INDEX, 'completed', { outcome: 'answered_on_ready' });
      return true;
    } finally {
      consentSubmitting = false;
    }
  }

  async function loadHqAnywhereSetting(): Promise<void> {
    if (hqAnywhereLoading || hqAnywhereSaving) return;
    hqAnywhereLoading = true;
    hqAnywhereLoadError = false;
    hqAnywhereSettingError = false;
    hqAnywhereRetryValue = null;
    hqAnywhereSetupRetry = false;
    try {
      const result = await getHqAnywherePersonSetting(onboardingFeatureFlags.settings);
      if (result.ok) {
        hqAnywhereEnabled = result.value;
        hqAnywhereSettingLoaded = true;
      } else {
        console.warn('[onboarding-hq-anywhere] setting read failed:', result);
        hqAnywhereLoadError = true;
      }
    } catch (error) {
      console.warn('[onboarding-hq-anywhere] setting read failed:', error);
      hqAnywhereLoadError = true;
    } finally {
      hqAnywhereLoading = false;
    }
  }

  async function prepareHqAnywhereSetting(): Promise<void> {
    const enabled = await resolveHqAnywhereRuntimeEnabled(onboardingFeatureFlags.identity);
    if (!enabled) return;
    hqAnywhereRuntimeEnabled = true;
    await loadHqAnywhereSetting();
  }

  async function configureHqAnywhereGlobalRuntime(value: boolean): Promise<void> {
    if (hqAnywhereSettingUp) return;
    hqAnywhereSettingUp = true;
    hqAnywhereSettingError = false;
    hqAnywhereRetryValue = null;
    hqAnywhereSetupRetry = false;
    try {
      const result = await setHqAnywhereGlobalRuntime(
        onboardingFeatureFlags.identity,
        onboardingFeatureFlags.settings,
        value,
      );
      if (!result.ok) {
        console.warn('[onboarding-hq-anywhere] global runtime setup failed:', result);
        hqAnywhereRetryValue = value;
        hqAnywhereSetupRetry = true;
        hqAnywhereSettingError = true;
      }
    } catch (error) {
      console.warn('[onboarding-hq-anywhere] global runtime setup failed:', error);
      hqAnywhereRetryValue = value;
      hqAnywhereSetupRetry = true;
      hqAnywhereSettingError = true;
    } finally {
      hqAnywhereSettingUp = false;
    }
  }

  async function saveHqAnywhereSetting(value: boolean): Promise<void> {
    if (hqAnywhereSaving || hqAnywhereSettingUp || hqAnywhereLoading || !hqAnywhereSettingLoaded) return;
    const previous = hqAnywhereEnabled;
    hqAnywhereEnabled = value;
    hqAnywhereSaving = true;
    hqAnywhereLoadError = false;
    hqAnywhereSettingError = false;
    hqAnywhereRetryValue = null;
    hqAnywhereSetupRetry = false;
    try {
      const result = await putHqAnywherePersonSetting(
        onboardingFeatureFlags.settings,
        value,
      );
      if (result.ok) {
        hqAnywhereSaving = false;
        await configureHqAnywhereGlobalRuntime(value);
      } else {
        console.warn('[onboarding-hq-anywhere] setting write failed:', result);
        hqAnywhereEnabled = previous;
        hqAnywhereRetryValue = value;
        hqAnywhereSettingError = true;
      }
    } catch (error) {
      console.warn('[onboarding-hq-anywhere] setting write failed:', error);
      hqAnywhereEnabled = previous;
      hqAnywhereRetryValue = value;
      hqAnywhereSettingError = true;
    } finally {
      hqAnywhereSaving = false;
    }
  }

  function retryHqAnywhereSetting(): void {
    if (hqAnywhereLoadError) {
      void loadHqAnywhereSetting();
    } else if (hqAnywhereRetryValue !== null && hqAnywhereSetupRetry) {
      void configureHqAnywhereGlobalRuntime(hqAnywhereRetryValue);
    } else if (hqAnywhereRetryValue !== null) {
      void saveHqAnywhereSetting(hqAnywhereRetryValue);
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
    if (consentOnly) {
      // Reprompt has no ready screen. The answer is cached with provenance and
      // reconciled by the consent repair on reconnect; mark the prompt shown so
      // it does not nag again this version, then close.
      if (repromptPersonUid) {
        await markConsentRepromptShown(TELEMETRY_CONSENT_VERSION, repromptPersonUid);
      }
      await finishWithRecovery();
      return;
    }
    // Ready screen: the answer is cached with provenance and the consent
    // repair sends it on the next connection. Finish without posting again and
    // without calling it a confirmed write.
    readyConsentRecorded = true;
    consentFailure = null;
    await finishWithRecovery();
  }

  async function startSetupRun() {
    // A second entry must not rebuild the stage list underneath a LIVE run —
    // the rebuilt list would drop finished stages and restart the bands. But
    // a restart has to win: leaving the setup step cancels the run without
    // waiting for its current stage, so coming back finds the guard still
    // held by a run that is no longer current. That run is superseded here
    // instead of being allowed to swallow the restart.
    if (inFlightRunId !== 0) {
      if (inFlightRunId === currentRunId && !setupCancelled) return;
      cancelSetupRun();
    }
    const runId = beginSetupRun();
    inFlightRunId = runId;
    try {
      const depsTimeoutRetryStatus = resolveFlagStatusWithTimeout(
        Promise.resolve()
          .then(() =>
            onboardingFeatureFlags.identity.resolveFeatureFlagStatus?.(
              SETUP_DEPS_TIMEOUT_RETRY_FLAG,
            ) ?? Promise.resolve({ ok: false as const, reason: 'unavailable' as const }),
          )
          .then((result) => {
            if (!result.ok || !result.value.configured) return null;
            return result.value.enabled;
          })
          .catch((error) => {
            console.warn(
              'onboarding: dependency timeout retry flag unavailable; leaving retry off',
              error,
            );
            return null;
          }),
        2_000,
      );
      if (!isCurrentRun(runId)) return;
      if (installPath) effectiveInstallPath = installPath;
      await listenForProgress(runId);
      let startStage: StageId = STAGE_ORDER[0];
      if (!recoveringMissingRoot) {
        try {
          const manifest = await invoke<InstallManifest>('read_install_manifest');
          if (!isCurrentRun(runId)) return;
          effectiveInstallPath = manifest.installPath || effectiveInstallPath;
          if (manifest.installPath) installPath = manifest.installPath;
          startStage = resumeStartStageFromManifest(manifest);
          stages = buildStagesFromManifest(manifest, startStage);
        } catch {
          // Missing/corrupt manifests fall back to a fresh run.
        }
      }
      if (!isCurrentRun(runId)) return;
      await runSetup(runId, startStage, depsTimeoutRetryStatus);
    } finally {
      // Only the run that still owns the guard may release it: a superseded
      // run finishing late must not clear a newer run's claim. Every exit —
      // cancel, error, completion, supersession — passes through here.
      if (inFlightRunId === runId) inFlightRunId = 0;
    }
  }

  /**
   * Stop this wizard's setup run. `leaveHostInstalls` is for the wizard going
   * away (window closed, desktop opened): the host's install queue keeps
   * running, so its processes are not cancelled. A retry, a stage timeout and
   * going back before setup still cancel them.
   */
  function cancelSetupRun({ leaveHostInstalls = false }: { leaveHostInstalls?: boolean } = {}) {
    setupCancelled = true;
    unlistenInstallProgress?.();
    unlistenInstallProgress = null;
    unlistenContentProgress?.();
    unlistenContentProgress = null;
    unlistenPersonalFirstPushScan?.();
    unlistenPersonalFirstPushScan = null;
    unlistenPersonalFirstPushProgress?.();
    unlistenPersonalFirstPushProgress = null;
    activeInitialSyncTimeoutProgress = null;
    activeDepsLockWaitTimeoutProgress = null;
    activeDepsOutputTimeoutProgress = null;
    activeContentTimeoutProgress = null;
    activeIndexingOutputTimeoutProgress = null;
    // A stage that failed and is waiting on its auto-retry never settles once
    // its run stops being current, so `allSettled` would stay false forever
    // and the completion gate would never fire. Put it back to 'pending': the
    // next run owns it again.
    stages = resetRetryingStages(stages);
    setupRetry = null;
    clearBlockingRetry();
    void cancelForegroundWork(currentRunId, { leaveHostInstalls });
  }

  /** Any stage left waiting on a retry goes back to 'pending'. */
  function resetRetryingStages(list: StageState[]): StageState[] {
    if (!list.some((stage) => stage.status === 'retrying')) return list;
    return list.map((stage) =>
      stage.status === 'retrying' ? { ...stage, status: 'pending' as const } : stage,
    );
  }

  // Detects the installed AI tools once at mount. The result only feeds the
  // `detectedToolCount` telemetry; the ready screen has no tool buttons.
  async function probeAiTools() {
    if (probeInFlight) return;
    probeInFlight = true;
    try {
      const tools = await invoke<AiTools>('detect_ai_tools');
      if (detectorMounted) aiTools = tools;
    } catch {
      if (detectorMounted) aiTools = NO_AI_TOOLS;
    } finally {
      probeInFlight = false;
    }
  }

  async function finishWithRecovery(): Promise<boolean> {
    if (finishing || finishInProgress) return false;
    finishing = true;
    finishInProgress = true;
    finishError = false;
    try {
      // Every way of finishing from the ready screen (the auto-finish once
      // the blocking phase is done, the finish-error note's Finish setup, the
      // consent Retry) records the usage-data answer first, and nothing
      // finishes on a failed write: the failure is shown with Retry, or for
      // an offline person whose answer is cached, "Finish setup, send later".
      if (consentOnReady && readyConsentShown && !readyConsentRecorded) {
        if (!(await submitConsent())) return false;
        readyConsentRecorded = true;
      }
      await onfinish?.();
      onboardingCompleted = true;
      // A finish from a button (Retry, "Finish setup, send later") settles any
      // owed automatic retry: the flow must not finish a second time.
      autoFinishRetryOwed = false;
      autoFinishAttempted = true;
      recordStep(currentStep, 'completed', { outcome: 'finished' });
      return true;
    } catch (err) {
      console.error('onboarding: finish failed', err);
      finishError = true;
      return false;
    } finally {
      finishInProgress = false;
      finishing = false;
    }
  }

  async function handleFinish(): Promise<void> {
    await finishWithRecovery();
  }

  function advanceTo(
    step: number,
    exitAction: OnboardingAction | null = 'completed',
    exitDetails: StepTelemetryDetails = {},
    targetScene?: SceneId,
  ) {
    router.goTo(step);
    transitionTo(router.currentStep, exitAction, exitDetails, targetScene);
  }

  /**
   * Where the optional first-folder sync hands over: the teammate invite when
   * the person is eligible and has not seen it, otherwise the ready screen
   * (which then offers the connector import, and holds the usage-data answer).
   */
  function nextAfterFirstFolderSync(): number {
    return showInviteTeammateStep && inviteTeammateContext && !inviteTeammateVisited
      ? INVITE_TEAMMATE_STEP_INDEX
      : READY_STEP_INDEX;
  }

  function goBackTo(step: number, targetScene?: SceneId) {
    router.goTo(step);
    transitionTo(router.currentStep, 'back', {}, targetScene);
  }

  /**
   * Move the wizard to `next` and put its screen on show.
   *
   * The install now runs in the background across the explainers, consent and
   * ready, so leaving the setup step no longer cancels it. Only going back to
   * the folder choice does (the folder may change), and only while the install
   * is unfinished; the next "Install here" starts it over.
   */
  function transitionTo(
    next: number,
    exitAction: OnboardingAction | null = 'completed',
    exitDetails: StepTelemetryDetails = {},
    targetScene?: SceneId,
  ) {
    // The connector import keeps the current screen until it has something to
    // offer (`onoffer`), so an auto-skip never flashes an empty panel.
    const nextScene =
      targetScene ?? (next === CONNECTOR_IMPORT_STEP_INDEX ? scene : sceneForStep(next));
    if (next === currentStep) {
      scene = nextScene;
      return;
    }
    const previous = currentStep;
    if (exitAction) recordStep(previous, exitAction, exitDetails);
    // ConnectorImportStep owns its entry so it can record detection outcomes
    // without a duplicate generic entry event.
    if (next !== CONNECTOR_IMPORT_STEP_INDEX) recordStep(next, 'entered');
    setCurrentStep(next);
    furthestStep = Math.max(furthestStep, next);

    if (next < SETUP_STEP_INDEX && setupStarted && !setupCompleted) {
      cancelSetupRun();
      setupStarted = false;
      blockingPhaseDone = false;
      personEntityNeedsRetry = false;
      personEntityRetry = null;
      stages = buildInitialStages();
      // The only genuine start-over: the next run earns its percent again.
      resetSetupProgressTracker(setupProgressTracker);
      setupRetry = null;
    }
    scene = nextScene;
  }

  // ─── Welcome flow: screens, controls, keyboard ──────────────────────────

  /**
   * The forward action of the screen on show: the prototype's Next, with each
   * screen's real work behind it.
   */
  function forward(): void {
    if (replay) {
      const order = storyOrder as readonly SceneId[];
      const index = order.indexOf(scene);
      if (index === -1 || index + 1 >= order.length) {
        void finishReplay();
        return;
      }
      scene = order[index + 1]!;
      return;
    }
    switch (scene) {
      case 'folder':
        handleInstall();
        return;
      case 'cloud':
        // Look up memberships while the second explainer plays, so a company
        // the person already belongs to is connected by the ready screen.
        void resolveCompanyStep();
        scene = 'shortcut';
        return;
      case 'shortcut':
        // Leaving the explainers is not the setup step "completing": the
        // install records its own completion when it finishes.
        void leaveExplainers();
        return;
      case 'consent':
        if (!consentFailure) void submitConsent();
        return;
      case 'ready':
        // The ready screen finishes by itself (the AUTO-FINISH effect), so a
        // key press here never finishes early.
        return;
      default:
        return;
    }
  }

  function goBack(): void {
    if (!chrome.back) return;
    const target = previousScene(scene, replay);
    if (!target) return;
    if (target === 'welcome') enterSettled = true;
    if (replay) {
      scene = target;
      return;
    }
    const step = stepForScene(target);
    if (step === currentStep) {
      scene = target;
      return;
    }
    goBackTo(step, target);
    // A finished install closes the way back into the setup step for the
    // router; the explainer itself can still be seen again.
    scene = target;
  }

  function skipIntro(): void {
    if (chrome.skip === 'ready') void leaveExplainers();
    else if (chrome.skip === 'end') void finishReplay();
  }

  async function finishReplay(): Promise<void> {
    await finishWithRecovery();
  }

  function forwardEnabled(): boolean {
    switch (scene) {
      case 'welcome':
        return replay;
      case 'folder':
        return replay || (Boolean(installPath) && !directoryBusy);
      case 'consent':
        return telemetryChoice !== null && !consentSubmitting && !finishing && !consentFailure;
      case 'ready':
        return false;
      default:
        return isStoryScene(scene);
    }
  }

  function keyTarget(target: EventTarget | null): 'none' | 'button' | 'field' {
    if (!(target instanceof Element)) return 'none';
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return 'field';
    if (target.closest('button, a, summary, [role="button"]')) return 'button';
    return 'none';
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const intent = welcomeKeyIntent(event.key, {
      target: keyTarget(event.target),
      navRevealed: navRevealed || scene === 'welcome',
    });
    if (!intent) return;
    event.preventDefault();
    if (intent === 'escape') {
      // The replay can be left at any point. Setup cannot be skipped, so in
      // onboarding Escape only finishes the screen's animation.
      if (replay) void finishReplay();
      else welcomeController?.fastForward();
      return;
    }
    if (intent === 'back') {
      goBack();
      return;
    }
    if (intent === 'fast-forward') {
      welcomeController?.fastForward();
      return;
    }
    if (!navRevealed && scene !== 'welcome') {
      welcomeController?.fastForward();
      return;
    }
    if (forwardEnabled()) forward();
  }

  /** A click on the backdrop (not on a control) finishes the animation too. */
  function handleBackdropClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('button, a, input, label, summary, .loc, .lrow')) return;
    if (!navRevealed) welcomeController?.fastForward();
  }

  function revealNav(): void {
    navRevealed = true;
  }

  /** The welcome mark has settled and shown the sign-in block: offer the providers. */
  function revealSignIn(): void {
    navRevealed = true;
    signInActionsReady = true;
  }

  /**
   * Build the screen engines once the markup is in place, and keep the
   * controller in step with `scene`. Returns the teardown.
   */
  function startWelcome(): () => void {
    const controller = createWelcomeController({
      reducedMotion: () => reducedMotion,
      // No onTick: the progress ticks do not count down a screen's hold; the
      // current tick is simply on (design review, 2026-10-12).
      // The motion is decoration in front of setup; it must never block it.
      onError: () => {
        motionFailed = true;
        navRevealed = true;
        signInActionsReady = true;
      },
    });
    welcomeController = controller;
    const el = (key: string) => refs[key] ?? null;
    const has = (...keys: string[]) => keys.every((key) => refs[key]);

    if (has('markCanvas', 'markCap', 'markSignin')) {
      controller.register(
        'welcome',
        createMarkEngine(
          {
            canvas: el('markCanvas') as HTMLCanvasElement,
            cap: el('markCap')!,
            signin: el('markSignin')!,
            nav: el('navWelcome'),
          },
          { replay, onSettle: revealSignIn },
        ),
      );
    }
    if (has('folderCanvas', 'folderCopy', 'tree', 'treeRoot', 'folder')) {
      controller.register(
        'folder',
        createFolderEngine(
          {
            canvas: el('folderCanvas') as HTMLCanvasElement,
            copy: el('folderCopy')!,
            tree: el('tree')!,
            root: el('treeRoot')!,
            rows: treeRows,
            loc: el('loc'),
            folder: el('folder')!,
            nav: el('navFolder'),
          },
          { reveal: revealNav },
        ),
      );
    }
    if (ringsEl && ringA && ringB && coreEl && has('corelabel', 'cloudCopy', 'rail')) {
      controller.register(
        'cloud',
        createOrbitEngine(
          {
            rings: ringsEl,
            ellipses: [ringA, ringB],
            core: coreEl,
            corelabel: el('corelabel')!,
            copy: el('cloudCopy')!,
            rail: el('rail')!,
            railRows,
            innerChips,
            outerChips,
            nav: el('navCloud'),
          },
          { reveal: revealNav },
        ),
      );
    }
    if (has('kb', 'glow', 'chordline', 'shortcutCopy')) {
      controller.register(
        'shortcut',
        createKeyboardEngine(
          {
            kb: el('kb')!,
            keys: keyEls,
            glow: el('glow')!,
            line: el('chordline')!,
            copy: el('shortcutCopy')!,
            nav: el('navShortcut'),
          },
          { reveal: revealNav },
        ),
      );
    }
    if (has('consentCopy', 'consentForm', 'consentFine')) {
      controller.register(
        'consent',
        createConsentEngine(
          {
            copy: el('consentCopy')!,
            form: el('consentForm')!,
            choices: consentChoices,
            fine: el('consentFine')!,
            nav: el('navConsent'),
          },
          { reveal: revealNav },
        ),
      );
    }
    if (has('readyCanvas', 'readyCopy', 'readyProg', 'readyAlt')) {
      controller.register(
        'ready',
        createReadyEngine(
          {
            canvas: el('readyCanvas') as HTMLCanvasElement,
            copy: el('readyCopy')!,
            prog: el('readyProg')!,
            nav: el('navReady'),
            alt: el('readyAlt')!,
          },
          { reveal: revealNav },
        ),
      );
    }
    for (const id of ['first-folder', 'invite', 'connectors', 'trust', 'settings', 'run-setup', 'handoff', 'build']) {
      const block = refs[`panel:${id}`];
      if (block) controller.register(id, createPanelEngine(block, { reveal: revealNav }));
    }

    // One beat on the untouched desktop, then the veil settles in; the chrome
    // never waits for the overture.
    const veilTimer = window.setTimeout(() => (veilOn = true), reducedMotion ? 0 : 420);
    const chromeTimer = window.setTimeout(() => (chromeBooted = true), reducedMotion ? 0 : 900);
    // Layout measures type, so lay out again once the bundled fonts are in.
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => welcomeController?.relayout());
    }
    return () => {
      window.clearTimeout(veilTimer);
      window.clearTimeout(chromeTimer);
      controller.destroy();
      welcomeController = null;
    };
  }

  // Keep the controller showing the screen in `scene`, and move focus to its
  // heading on every change after the first (so a screen reader announces the
  // new screen; nothing is focused on first render).
  let shownScene: SceneId | null = null;
  $effect(() => {
    const next = scene;
    const controller = welcomeController;
    if (!controller) return;
    if (shownScene === next) return;
    const first = shownScene === null;
    shownScene = next;
    navRevealed = false;
    const settled = enterSettled;
    enterSettled = false;
    if (motionFailed) navRevealed = true;
    // Ticks up to and including this screen's are full; the rest are empty.
    const current = chrome.currentTick;
    for (const [tick, fill] of tickFills.entries()) {
      if (fill) fill.style.width = tick <= current ? '100%' : '0';
    }
    void tick().then(() => {
      controller.show(next, {
        holdMs: isStoryScene(next) ? SCENE_HOLD_MS[next] : 0,
        settled,
      });
      if (!first) {
        const heading = welcomeRoot?.querySelector<HTMLElement>(
          `[data-scene="${next}"] [data-scene-heading]`,
        );
        heading?.focus({ preventScroll: true });
      }
    });
  });

  function clearReadyDwell(): void {
    if (readyDwellTimer !== null) clearTimeout(readyDwellTimer);
    readyDwellTimer = null;
  }

  function restartReadyDwell(): void {
    clearReadyDwell();
    readyDwellElapsed = false;
    if (
      installPending ||
      blockingRetryRunning ||
      requiredFailureHeading ||
      scene !== 'ready' ||
      !navRevealed ||
      !consentOnReady
    ) return;
    readyDwellTimer = setTimeout(() => {
      readyDwellTimer = null;
      readyDwellElapsed = true;
    }, readyTimings().consentDwellMs);
  }

  // Count the full dwell only while the ready heading and usage-data choice are visible.
  $effect(() => {
    if (
      scene !== 'ready' ||
      !navRevealed ||
      !consentOnReady ||
      installPending ||
      blockingRetryRunning ||
      requiredFailureHeading
    ) return;
    untrack(restartReadyDwell);
    return clearReadyDwell;
  });

  $effect(() => {
    if (consentOnly || replay || currentStep !== READY_STEP_INDEX || scene !== 'ready') return;
    const timer = setTimeout(() => {
      readyWatchdogFired = true;
    }, readyTimings().watchdogMs);
    return () => clearTimeout(timer);
  });

  // The ready screen carries the usage-data checkbox: once it has been on
  // show, finishing records the answer.
  $effect(() => {
    if (scene === 'ready' && consentOnReady) {
      readyConsentShown = true;
      markPostReadyActionReady();
    }
  });

  $effect(() => {
    if (scene === 'ready' && consentOnReady && !hqAnywhereLoadStarted) {
      hqAnywhereLoadStarted = true;
      void prepareHqAnywhereSetting();
    }
  });

  // Content that changes height re-lays the screen out, so the button under it
  // never overlaps it.
  $effect(() => {
    void [
      directoryNotice,
      consentFailure,
      finishError,
      installPending,
      installActivityRunning,
      deferredConsent,
      signInActionsReady,
      readyConsentRecorded,
    ];
    void tick().then(() => welcomeController?.relayout());
  });

  // The corner card says "HQ is installed" for a moment, then gets out of the way.
  $effect(() => {
    if (!installSettled) {
      installCardRetired = false;
      return;
    }
    const timer = window.setTimeout(() => (installCardRetired = true), 3500);
    return () => window.clearTimeout(timer);
  });

  // A usage-data answer held during the install is sent once the blocking
  // phase is done: that phase provisions the person entity the write lands on,
  // and finishing must not wait for the background tools install.
  $effect(() => {
    if ((blockingPhaseDone || setupCompleted) && deferredConsent?.phase === 'held') {
      void flushDeferredConsent();
    }
  });

  async function flushDeferredConsent(): Promise<void> {
    const held = deferredConsent;
    if (!held || held.phase === 'sending' || held.phase === 'sent') return;
    deferredConsent = { phase: 'sending', enabled: held.enabled };
    const result = await sendHeldConsent(held);
    if (!mounted) return;
    deferredConsent = result;
    if (result.phase === 'sent') void resolveInstallerPersonUid();
  }

  // Someone who answered before the blocking phase finished is already on the
  // ready screen when it does. The optional follow-on steps run then (they
  // need the person entity, not the tools install, which keeps running in the
  // background), each once, in order: the first-folder sync (flag-gated),
  // the teammate invite (flag-gated, sole active member only), then the
  // connector import, which only shows itself if it has something to offer.
  // Each hands back to the ready screen, which picks the next one up here.
  // There is no company step (US-007): memberships connect on their own.

  $effect(() => {
    if (consentOnly || replay || !(blockingPhaseDone || setupCompleted) || !postSetupStepsResolved) return;
    if (currentStep !== READY_STEP_INDEX) return;
    if (showFirstFolderSyncStep && !firstFolderSyncVisited) {
      advanceTo(FIRST_FOLDER_SYNC_STEP_INDEX, null);
      return;
    }
    if (showInviteTeammateStep && inviteTeammateContext && !inviteTeammateVisited) {
      advanceTo(INVITE_TEAMMATE_STEP_INDEX, null);
      return;
    }
    if (connectorImportVisited) return;
    if (!connectorImportCompany) {
      // Personal setup: there is no company to import connectors into, so
      // the step is not offered and the ready screen stays on show.
      connectorImportVisited = true;
      return;
    }
    // US-023: a returning account imports into a company only once its
    // pull is over (or the person chose Continue), so the folder exists.
    if (!companyPullClear) return;
    advanceTo(CONNECTOR_IMPORT_STEP_INDEX, null);
  });

  // AUTO-FINISH. The ready screen has no buttons: it finishes by itself, and
  // the desktop opens, once the blocking phase is done. That is when the
  // ready screen is on show and its scene has arrived (`navRevealed`, set by
  // the ready engine when the usage-data line appears), the host queue has
  // been read on this step, the blocking phase is done (`installPending` is
  // false), the usage-data answer is not held back, and the post-ready steps
  // above have all run: the conditions below mirror the routing effect, so
  // this never fires while the routing effect still has a step to open.
  // It does not wait for the background phase (tool installs, the vault
  // upload, indexing) or the host's install queue. They keep running after
  // the window closes, and the Finishing setup chip shows them; the desktop
  // does not need any of them to open (the hq CLI falls back to npx until
  // its install lands).
  // A wizard that started no install on this mount (only a direct mount at
  // the ready step) never runs those steps; its blocking phase ran on an
  // earlier mount, so it finishes once the host queue has been read.
  // The usage-data checkbox is ticked by default, so it also waits
  // the consent dwell after the checkbox appears, or after the person
  // last touched a checkbox, so the default is never recorded before the
  // person could untick it.
  // It fires once per mount. A finish that fails leaves the finish-error note
  // with its Finish setup button, and a usage-data write that fails leaves the
  // consent error with Retry; once the person clears that error by changing
  // their answer, it fires one more time.
  $effect(() => {
    if (consentOnly || replay || currentStep !== READY_STEP_INDEX || scene !== 'ready') return;
    if (!navRevealed || !hostQueueChecked) return;
    if (installPending || blockingRetryRunning || requiredFailureHeading) return;
    if (consentOnReady && !readyDwellElapsed) return;
    if (consentGate !== 'clear' || consentFailure !== null || finishing || autoFinishAttempted) return;
    if (setupStarted) {
      if (!(blockingPhaseDone || setupCompleted) || !postSetupStepsResolved) return;
      if (showFirstFolderSyncStep && !firstFolderSyncVisited) return;
      if (showInviteTeammateStep && inviteTeammateContext && !inviteTeammateVisited) return;
      if (!connectorImportVisited && connectorImportCompany) return;
      // US-023: hold Ready while the account lookup failed, and while a
      // returning account's companies are still coming (or one failed and
      // the person has not chosen Continue).
      if (accountLookupFailed || !companyPullClear) return;
    }
    autoFinishAttempted = true;
    void finishWithRecovery().then((finished) => {
      if (!finished && consentFailure !== null && !autoFinishRetried) autoFinishRetryOwed = true;
    });
  });

  $effect(() => {
    if (!autoFinishRetryOwed || consentFailure !== null || finishing) return;
    autoFinishRetryOwed = false;
    autoFinishRetried = true;
    autoFinishAttempted = false;
  });

  /** One row per run: what the membership lookup found and which way it went. */
  function recordCompanyRoute(route: FirstRunCompanyPath, summary: CompanyRouteSummary): void {
    if (route.kind === 'skip') {
      companyStepCompanyUid = route.company.companyUid;
      recordWorkspaceSelected(route.company.companyUid);
    }
    recordStep(SETUP_STEP_INDEX, route.kind === 'skip' ? 'skipped' : 'started', {
      outcome: `route_${route.decision}`,
      decision: route.decision,
      existingCompanies: summary.existingCompanies,
      paidCompany: summary.paidCompany,
      pendingInvites: summary.pendingInvites,
      ...(route.kind === 'skip' ? { companyUid: route.company.companyUid } : {}),
    });
    if (route.kind === 'skip') {
      connectorImportCompany = route.company.slug ?? route.company.companyUid;
      void selectCompany(route.company.slug);
    }
  }

  /** A failed lookup keeps the existing #setup create-company recovery in place. */
  function recordCompanyRouteLookupFailed(): void {
    recordStep(SETUP_STEP_INDEX, 'started', {
      outcome: 'route_lookup_failed',
      decision: 'lookup_failed',
    });
  }

  /** Record the company action without delaying or changing the visible flow. */
  function recordWorkspaceSelected(companyUid: string | null | undefined): void {
    if (!companyUid) return;
    void invokeCommand('record_onboarding_workspace_selected', { companyUid }).catch((error) => {
      console.warn('onboarding: workspace-selected receipt could not be queued', error);
    });
  }

  /** The app's active company slug, or null when there is none or it cannot be read. */
  async function activeCompanyForConnectorImport(): Promise<string | null> {
    try {
      const slug = await invokeCommand<string | null>('get_desktop_active_company');
      return typeof slug === 'string' && slug.trim() ? slug.trim() : null;
    } catch {
      return null;
    }
  }

  /** Make the chosen company the app's active one (or clear it). Best effort. */
  async function selectCompany(slug: string | null, clear = false): Promise<void> {
    if (!slug && !clear) return;
    try {
      await invokeCommand('set_desktop_active_company', { companySlug: slug });
    } catch (error) {
      console.warn('onboarding: could not select the company', error);
    }
  }

  /** Leave the teammate invite: sent (Continue) or skipped. */
  function leaveInviteTeammate(): void {
    advanceTo(READY_STEP_INDEX, inviteSent ? null : 'skipped', {}, 'ready');
  }

  function connectorImportDone(): void {
    const fromOffer = scene === 'connectors';
    if (fromOffer) enterSettled = false;
    advanceTo(READY_STEP_INDEX, null, {}, 'ready');
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="hq-welcome"
  class:replay
  class:has-wallpaper={!!wallpaper}
  class:motion-failed={motionFailed}
  data-testid="onboarding-wizard"
  data-current-scene={scene}
  bind:this={welcomeRoot}
  onclick={handleBackdropClick}
>
  <h1 class="sr-only">{replay ? 'Welcome to HQ' : 'HQ desktop onboarding'}</h1>
  {#if wallpaper}
    <div
      class="wallpaper"
      data-testid="welcome-wallpaper"
      style:background-image={`url("${wallpaper}")`}
      aria-hidden="true"
    ></div>
  {/if}
  <div class="veil" class:on={veilOn} aria-hidden="true"></div>
  <div class="grain" class:on={scene === 'folder' || scene === 'ready'} aria-hidden="true"></div>
  <div class="titlebar" data-tauri-drag-region aria-hidden="true"></div>

  <!-- 0 · welcome: the constellation forms the mark; sign in under it -->
  <section
    class="scene s-welcome"
    class:on={scene === 'welcome'}
    data-scene="welcome"
    data-testid="onboarding-signin"
    aria-labelledby="onboarding-title-signin"
  >
    <canvas bind:this={refs.markCanvas} aria-hidden="true"></canvas>
    <h2 class="cap" id="onboarding-title-signin" tabindex="-1" data-scene-heading bind:this={refs.markCap}>
      Everything you need. In one place.
    </h2>
    <div class="signin" bind:this={refs.markSignin}>
      <div class="signin-inner" class:busy={loadingProvider !== null}>
        <p class="body">A home for your work and everything your team knows. Ready for every AI you work with.</p>
        {#if !replay}
          <!-- The consent question is its own screen; nothing is asked here. -->
          <div class="btns-slot">
            {#if signInActionsReady}
              <div class="btns">
                <button
                  class="btn btn-primary"
                  type="button"
                  disabled={loadingProvider !== null}
                  aria-busy={loadingProvider === 'Google'}
                  onclick={() => handleSignIn('Google')}
                >{@render GoogleMark()}Continue with Google</button>
                <button
                  class="btn btn-secondary"
                  type="button"
                  disabled={loadingProvider !== null}
                  aria-busy={loadingProvider === 'Microsoft'}
                  onclick={() => handleSignIn('Microsoft')}
                >{@render MicrosoftMark()}Continue with Microsoft</button>
              </div>
              {#if microsoftEmailPrompt}
                <form
                  class="microsoft-email"
                  data-testid="microsoft-email-form"
                  onsubmit={(event) => {
                    event.preventDefault();
                    void handleSignIn('Microsoft');
                  }}
                >
                  <label for="onboarding-microsoft-email">Enter the Microsoft email you use with HQ</label>
                  <input
                    id="onboarding-microsoft-email"
                    data-testid="microsoft-email"
                    type="email"
                    autocomplete="username"
                    autocapitalize="none"
                    spellcheck="false"
                    bind:value={microsoftEmail}
                    disabled={loadingProvider !== null}
                  />
                  <button
                    class="btn btn-secondary"
                    type="submit"
                    data-testid="microsoft-email-continue"
                    disabled={loadingProvider !== null || microsoftEmail.trim() === ''}
                  >Continue</button>
                </form>
              {/if}
            {/if}
          </div>
          {#if existingSessionOutpost}
            <p class="status inline-note" role="status" data-testid="onboarding-signed-in-as">
              You're signed in as this outpost ({existingSessionOutpostLabel}).
              <button class="link-inline" type="button" data-testid="onboarding-signed-in-as-continue" disabled={switchingAccount} onclick={continueExistingSession}>Continue</button>
              or
              <button class="link-inline" type="button" data-testid="onboarding-signed-in-as-switch" disabled={switchingAccount} onclick={() => void switchAccount()}>switch account</button>?
            </p>
          {:else if existingSessionEmail}
            <p class="status inline-note" role="status" data-testid="onboarding-signed-in-as">
              You're signed in as {existingSessionEmail}.
              <button class="link-inline" type="button" data-testid="onboarding-signed-in-as-continue" disabled={switchingAccount} onclick={continueExistingSession}>Continue</button>
              or
              <button class="link-inline" type="button" data-testid="onboarding-signed-in-as-switch" disabled={switchingAccount} onclick={() => void switchAccount()}>switch account</button>?
            </p>
          {:else if machineIdentity.available}
            <!-- This machine has its own outpost identity, not in use (opted out, or not resolved yet). -->
            <p class="status inline-note" role="status" data-testid="onboarding-use-outpost-note">
              This machine has its own outpost identity.
              <button class="link-inline" type="button" data-testid="onboarding-use-outpost" disabled={usingMachineIdentity || loadingProvider !== null} aria-busy={usingMachineIdentity} onclick={() => void useMachineIdentity()}>{usingMachineIdentity ? 'Signing in as this outpost…' : "Use this outpost's identity"}</button>
            </p>
            {#if machineIdentityError}
              <p class="status error inline-note" role="alert" data-testid="onboarding-use-outpost-error">{machineIdentityError}</p>
            {/if}
          {/if}
          {#if signInError}
            <p class="status error inline-note" role="alert">{signInError}</p>
          {:else}
            <p class="status" role="status">
              {loadingProvider
                ? `A browser window opened for ${loadingProvider} sign-in. Finish there and we’ll pick up right here.`
                : ''}
            </p>
          {/if}
        {/if}
      </div>
    </div>
    {#if replay}
      <div class="nav" class:on={scene === 'welcome' && navRevealed} bind:this={refs.navWelcome}>
        <button class="btn btn-primary" type="button" onclick={forward}>Next</button>
      </div>
    {/if}
  </section>

  <!-- 1 · it's a folder: the folder opens, the tree writes in, where it lives -->
  <section
    class="scene s-folder"
    class:on={scene === 'folder'}
    data-scene="folder"
    data-testid="onboarding-directory"
    aria-labelledby="onboarding-title-directory"
  >
    <canvas bind:this={refs.folderCanvas} aria-hidden="true"></canvas>
    <div class="copy" bind:this={refs.folderCopy}>
      <h2 class="h h-lg" id="onboarding-title-directory" tabindex="-1" data-scene-heading>It's a folder</h2>
      <p class="body">HQ lives on your machine as plain files. Your work, your rules, your team’s memory. Any AI sits on top of it.</p>
    </div>
    <div class="tree" bind:this={refs.tree}>
      <div class="troot" bind:this={refs.treeRoot}>HQ/</div>
      {#each FOLDER_ROWS as row, i (row[0])}
        <div class="trow" bind:this={treeRows[i]}>
          <span class="tname">{row[0]}</span><span class="tmeaning">{row[1]}</span>
        </div>
      {/each}
      {#if !replay}
        <div class="loc" bind:this={refs.loc}>
          <p class="lcap" id="welcome-location-caption">Pick where it lives. You can move it any time.</p>
          <div class="lrow">
            <span class="lname" aria-hidden="true">HQ</span>
            <span class="lpath" title={resolvedPath ?? undefined} aria-describedby="welcome-location-caption">{displayPath}</span>
            <button
              class="btn btn-secondary choose"
              type="button"
              disabled={directoryBusy}
              aria-label={directoryBusy ? 'Checking the folder' : `Choose where HQ lives. Now ${displayPath}`}
              onclick={chooseFolder}
            >{directoryButtonLabel}</button>
          </div>
          {#if directoryNotice}
            <p
              class="notice"
              class:error={directoryNotice.tone === 'error'}
              class:warning={directoryNotice.tone === 'warning'}
              role="status"
            >{directoryNotice.text}</p>
          {/if}
        </div>
      {/if}
    </div>
    <div class="folder" bind:this={refs.folder} aria-hidden="true">
      <div class="fbloom"></div>
      <div class="fscene">
        <svg class="fback" viewBox="0 0 176 136" preserveAspectRatio="none">
          <defs>
            <linearGradient id="hq-welcome-fbackfill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#5ea6ef" /><stop offset="1" stop-color="#5197e6" />
            </linearGradient>
          </defs>
          <path d="M.5 30.5 a12 12 0 0 1 12 -12 h44 a10 10 0 0 1 7 2.8 l9.5 9.2 h91.5 a11.5 11.5 0 0 1 11.5 11.5 v79.5 a14 14 0 0 1 -14 14 H14.5 a14 14 0 0 1 -14 -14 z" />
        </svg>
        <div class="fsheets"><div class="fsheet s2"></div><div class="fsheet s1"></div></div>
        <div class="ffront"><i class="fsheen"></i></div>
      </div>
    </div>
    <div class="nav" class:on={scene === 'folder' && navRevealed} bind:this={refs.navFolder}>
      <button
        class="btn btn-primary"
        type="button"
        data-testid="welcome-install-here"
        disabled={!replay && (!installPath || directoryBusy)}
        onclick={forward}
      >{replay ? 'Next' : 'Install here'}</button>
    </div>
  </section>

  <!-- 2 · local folder, cloud team: the orbit -->
  <section
    class="scene s-cloud"
    class:on={scene === 'cloud'}
    data-scene="cloud"
    data-testid="welcome-cloud"
    aria-labelledby="welcome-title-cloud"
  >
    <svg class="rings" bind:this={ringsEl} aria-hidden="true"><g><ellipse bind:this={ringA} /><ellipse bind:this={ringB} /></g></svg>
    <svg class="core" bind:this={coreEl} viewBox="0 0 280 161" aria-hidden="true">
      <path d={HQ_MARK_H} /><path fill-rule="evenodd" d={HQ_MARK_Q} />
    </svg>
    <div class="corelabel" bind:this={refs.corelabel} aria-hidden="true">company cloud</div>
    <div class="copy" bind:this={refs.cloudCopy}>
      <h2 class="h h-lg" id="welcome-title-cloud" tabindex="-1" data-scene-heading>Your folder is local. Your team is not.</h2>
      <p class="body">Every machine syncs to the same company cloud. People and bots share one context.</p>
    </div>
    {#each ORBIT_INNER as name, i (name)}
      <div class="pill tool" aria-hidden="true" bind:this={innerChips[i]}>{name}</div>
    {/each}
    {#each RAIL as card, i (card.name)}
      <div class="pill" aria-hidden="true" bind:this={outerChips[i]}>{card.name}</div>
    {/each}
    <ul class="rail" bind:this={refs.rail} aria-label="What the company cloud does">
      {#each RAIL as card, i (card.name)}
        <li class="rail-row" bind:this={railRows[i]}>
          <svg class="ri" viewBox="0 0 256 256" aria-hidden="true"><path fill="currentColor" d={card.icon} /></svg>
          <span class="rn">{card.name}</span>
          <span class="rm">{card.meaning}</span>
        </li>
      {/each}
    </ul>
    <div class="nav" class:on={scene === 'cloud' && navRevealed} bind:this={refs.navCloud}>
      <button class="btn btn-primary" type="button" onclick={forward}>Next</button>
    </div>
  </section>

  <!-- 3 · one shortcut: the board draws in, then the chord lights -->
  <section
    class="scene s-shortcut"
    class:on={scene === 'shortcut'}
    data-scene="shortcut"
    data-testid="welcome-shortcut"
    aria-labelledby="welcome-title-shortcut"
  >
    <div class="glow" bind:this={refs.glow} aria-hidden="true"></div>
    <div class="copy" bind:this={refs.shortcutCopy}>
      <h2 class="h h-lg" id="welcome-title-shortcut" tabindex="-1" data-scene-heading>One shortcut to remember</h2>
      <p class="body">From anywhere on {yourComputer}, this opens the HQ desktop view.</p>
    </div>
    <div class="keyboard" bind:this={refs.kb} aria-hidden="true">
      {#each keyboardRows as row, ri (ri)}
        <div class="krow">
          {#each row as key, ki (key.id)}
            <div
              class={key.glyph ? 'key mod' : 'key'}
              data-id={key.id}
              style:--w={key.w ?? 1}
              style:--kd={`${(ri * 0.05 + ki * 0.012).toFixed(3)}s`}
              use:registerKey={key.id}
            >
              {#if key.glyph}<span class="kglyph">{key.glyph}</span>{/if}<span class="klabel">{key.label}</span>
            </div>
          {/each}
        </div>
      {/each}
    </div>
    <p class="chordline" bind:this={refs.chordline}>
      <span class="sr-only">{chordSpoken}:</span>
      {#each chordKeys as key (key)}<kbd aria-hidden="true">{key}</kbd>{/each}
      <span class="chordcap">Open the HQ desktop view</span>
    </p>
    <div class="nav" class:on={scene === 'shortcut' && navRevealed} bind:this={refs.navShortcut}>
      <button
        class="btn btn-primary"
        type="button"
        disabled={leavingExplainers}
        aria-busy={leavingExplainers}
        onclick={forward}
      >{replay ? 'Done' : leavingExplainers ? 'One moment…' : 'Next'}</button>
    </div>
  </section>

  {#if !replay}
    {#if consentOnly}
    <!-- The consent-only runs (US-005 re-prompt, an installed machine missing
         its answer): the usage-data question as its own blocking screen.
         First-run onboarding asks it as a checkbox on the ready screen. -->
    <section
      class="scene s-consent"
      class:on={scene === 'consent'}
      data-scene="consent"
      data-testid="onboarding-consent"
      aria-labelledby="onboarding-title-consent"
    >
      <div class="copy" bind:this={refs.consentCopy}>
        <h2 class="h h-lg" id="onboarding-title-consent" tabindex="-1" data-scene-heading>Help make HQ better?</h2>
        <p class="body">
          HQ can share anonymous usage data with us, so we can see what helps and what gets in the way. Setup is the same either way, and you can change your mind any time in Settings.
        </p>
      </div>
      <fieldset class="form" bind:this={refs.consentForm}>
        <legend class="sr-only">Share anonymous usage data</legend>
        <div class="choice-wrap" bind:this={consentChoices[0]}>
          <label class="choice" class:selected={telemetryChoice === 'share'}>
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
            <span>
              <span class="ct">Share usage data</span>
              <span class="cd">Which features get used, and how often.</span>
            </span>
          </label>
        </div>
        <div class="choice-wrap" bind:this={consentChoices[1]}>
          <label class="choice" class:selected={telemetryChoice === 'decline'}>
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
            <span>
              <span class="ct">Don’t share</span>
              <span class="cd">Everything works exactly the same.</span>
            </span>
          </label>
        </div>
        <!-- The prototype's one-line fine print ("We never collect your files,
             names, messages...") is not accurate: repository, branch and MCP
             service names ARE collected. The precise disclosure stays. -->
        <div class="fine" bind:this={refs.consentFine}>
          <p>
            <span class="label">What we collect:</span>
            which skills you run, the AI model, token and session counts, and the
            names of your repositories, branches, and connected MCP services.
          </p>
          <p>
            <span class="label">What we never collect:</span>
            the words in your prompts, the contents of your files, or what you
            pass into and get back from your tools.
          </p>
          <p>
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
                  : 'See exactly what’s collected.'}</button>
            {#if privacyOpenError}
              <span class="consent-link-error" role="alert">Couldn’t open the page.</span>
            {/if}
          </p>
        </div>
        {#if consentFailure}
          <div
            class="note consent-error"
            class:offline={consentFailure.kind === 'offline'}
            role="alert"
            data-testid="consent-error"
          >
            {#if consentFailure.kind === 'offline'}
              <p>
                You appear to be offline, so your choice couldn't be sent yet.
                It's saved on this machine and HQ will send it automatically the
                next time you're connected. You can finish setting up now.
              </p>
            {:else}
              <p>
                We couldn't save your choice to the server just now. Nothing was
                lost, your answer is held on this machine. Try again in a moment.
              </p>
            {/if}
          </div>
        {/if}
        {#if finishError}
          <div class="note finish-action-error" role="alert" data-testid="consent-finish-error">
            <p>Couldn’t finish setup. Your progress is safe.</p>
            <div class="note-actions">
              <button
                class="btn btn-secondary"
                type="button"
                onclick={handleFinish}
                disabled={finishing}
                aria-busy={finishing}
              >{finishing ? 'Retrying…' : 'Retry'}</button>
            </div>
          </div>
        {/if}
      </fieldset>
      <div class="nav" class:on={scene === 'consent' && (navRevealed || consentOnly)} bind:this={refs.navConsent}>
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
            ><RailIcon name="check" />Finish setup, send later</button>
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
            ><RailIcon name="x" />Not now</button>
          {/if}
        {/if}
      </div>
    </section>
    {/if}

    <!-- Optional, flag-gated: sync the HQ folder, offered once the install is
         done. The section is always there so its panel engine can register;
         its content renders only when the rollout flag is on. -->
    <section
      class="scene s-follow-on s-first-folder"
      class:on={scene === 'first-folder'}
      data-scene="first-folder"
      aria-labelledby="onboarding-title-first-folder-sync"
    >
      <div class="panel-block" bind:this={refs['panel:first-folder']}>
        {#if showFirstFolderSyncStep}
          <div
            class="follow-on"
            class:on={scene === 'first-folder'}
            data-testid="onboarding-first-folder-sync"
          >
            <h2 class="h" id="onboarding-title-first-folder-sync" tabindex="-1" data-scene-heading>Sync your first folder</h2>
            <p class="body">Start syncing {installDisplayPath} so it is available across your HQ devices.</p>
            {#if firstFolderSelfHealing}
              <p class="note inline-note" role="status" aria-live="polite" data-testid="onboarding-first-folder-finishing-setup">Finishing setup…</p>
            {:else if firstFolderSyncBusy}
              <p class="note inline-note" role="status" aria-live="polite">Syncing your first folder…</p>
            {:else if firstFolderSyncError}
              <p class="note inline-note warning" role="alert">HQ could not sync this folder. Try again or skip for now.</p>
            {/if}
            <div class="btns split">
              <button
                class="btn btn-primary"
                type="button"
                data-testid="onboarding-first-folder-sync-start"
                disabled={firstFolderSyncBusy || firstFolderSyncCompleted}
                aria-busy={firstFolderSyncBusy}
                onclick={() => void startFirstFolderSync()}
              >{firstFolderSyncBusy ? 'Syncing…' : 'Sync this folder'}</button>
              <button
                class="btn btn-secondary"
                type="button"
                data-testid="onboarding-first-folder-sync-skip"
                onclick={() => advanceTo(nextAfterFirstFolderSync(), 'skipped')}
              >Skip for now</button>
            </div>
          </div>
        {/if}
      </div>
    </section>

    <!-- Optional, flag-gated: invite a teammate, offered to the sole active
         member of a company once the install is done. -->
    <section
      class="scene s-follow-on s-invite"
      class:on={scene === 'invite'}
      data-scene="invite"
      aria-labelledby="onboarding-title-invite-teammate"
    >
      <div class="panel-block" bind:this={refs['panel:invite']}>
        {#if showInviteTeammateStep}
          <div
            class="follow-on"
            class:on={scene === 'invite'}
            data-testid="onboarding-invite-teammate"
          >
            <h2 class="h" id="onboarding-title-invite-teammate" tabindex="-1" data-scene-heading>Invite a teammate</h2>
            <p class="body">
              Invite someone to work with you in HQ. This is optional, and you can
              invite people later.
            </p>
            {#if inviteSent}
              <p class="note inline-note" role="status" aria-live="polite">{inviteResent
                  ? 'This person was already invited. HQ sent the invitation again.'
                  : 'Invitation sent.'}</p>
            {:else if inviteErrorKind}
              <p
                class="note inline-note"
                data-testid="onboarding-invite-error"
                data-error-kind={inviteErrorKind}
                role="alert"
              >{inviteErrorMessage(inviteErrorKind)}</p>
            {/if}
            <form
              class="invite-form"
              onsubmit={(event) => {
                event.preventDefault();
                void sendTeammateInvite();
              }}
            >
              <label for="onboarding-invite-email">Teammate’s email</label>
              <input
                id="onboarding-invite-email"
                data-testid="onboarding-invite-email"
                type="email"
                bind:value={inviteEmail}
                autocomplete="email"
                maxlength="254"
                required
                disabled={inviteSending || inviteSent}
              />
              <div class="btns split">
                <button
                  class="btn btn-primary"
                  type="submit"
                  data-testid="onboarding-invite-send"
                  disabled={inviteSending || inviteSent || !inviteEmail.trim()}
                  aria-busy={inviteSending}
                >{inviteSending ? 'Sending…' : 'Send'}</button>
                <button
                  class="btn btn-secondary"
                  type="button"
                  data-testid="onboarding-invite-skip"
                  onclick={leaveInviteTeammate}
                >{inviteSent ? 'Continue' : 'Skip for now'}</button>
              </div>
            </form>
          </div>
        {/if}
      </div>
    </section>

    <!-- Optional: Claude Desktop connectors, offered once the install is done.
         Shows itself only when there is something to offer. -->
    <section
      class="scene s-connectors"
      class:on={scene === 'connectors'}
      data-scene="connectors"
      data-testid="onboarding-connector-import"
      aria-labelledby="onboarding-title-connector-import"
    >
      <div class="panel-block" bind:this={refs['panel:connectors']}>
        {#if currentStep === CONNECTOR_IMPORT_STEP_INDEX}
          <ConnectorImportStep
            company={connectorImportCompany}
            oncomplete={() => advanceTo(READY_STEP_INDEX, null)}
            onoffer={() => (scene = 'connectors')}
            onTelemetry={(event) =>
              recordStep(CONNECTOR_IMPORT_STEP_INDEX, event.action, {
                ...(event.detectedToolCount === undefined
                  ? {}
                  : { detectedToolCount: event.detectedToolCount }),
                ...(event.detectedSourceSet === undefined
                  ? {}
                  : { detectedSourceSet: event.detectedSourceSet }),
                ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
                ...(event.errorCategory === undefined
                  ? {}
                  : { errorCategory: event.errorCategory }),
              })}
          />
        {/if}
      </div>
    </section>

    <!-- 4 · ready: the skyline returns to close the loop -->
    <section
      class="scene s-ready"
      class:on={scene === 'ready'}
      data-scene="ready"
      data-testid="onboarding-summary"
      aria-labelledby="onboarding-title-ready"
    >
      <canvas bind:this={refs.readyCanvas} aria-hidden="true"></canvas>
      <div class="copy" bind:this={refs.readyCopy}>
        <h2 class="h h-lg" id="onboarding-title-ready" tabindex="-1" data-scene-heading>
          {installPending || blockingRetryRunning
            ? returningAccount && returningCompanyNames
              ? `Welcome back. Bringing ${returningCompanyNames} to this Mac.`
              : 'Almost ready.'
            : requiredFailureHeading ?? (accountLookupFailed ? 'Almost ready.' : returningReadyHeading ?? 'HQ is ready.')}
        </h2>
        <!-- The menu-bar sentence says setup is done, so it waits for Try again. -->
        {#if !requiredFailureHeading}
          <p class="body">
            HQ lives in your {setupHostOs === 'macos' ? 'menu bar' : 'system tray'} now and keeps everything in sync.
          </p>
        {/if}
        {#if requiredFailureHeading}
          <button
            class="btn btn-secondary ready-retry"
            type="button"
            data-testid="ready-required-retry"
            onclick={() => void retryFailedBlocking?.()}
          >Try again</button>
        {/if}
      </div>
      <div class="prog" class:done={!installPending && !blockingRetryRunning} bind:this={refs.readyProg} aria-live="polite">
        {#if installPending || blockingRetryRunning}
          <div class="pwrap">
            <i class="pi" data-testid="onboarding-completion-success-indicator" aria-hidden="true"></i>
            <span class="pl">{readyLine}</span>
            <span class="pbar" aria-hidden="true"><b style:width={`${installCard.percent}%`}></b></span>
          </div>
        {:else if installActivityRunning && currentInstallActivity}
          <span class="pl finishing-activity">Finishing setup: {currentInstallActivity}</span>
        {/if}
      </div>
      <!-- Nav stays empty. The screen finishes by itself once blocking setup
           is done (the AUTO-FINISH effect), unless a required step failed:
           then Try again sits in the copy block. This element stays because
           the ready engine measures it (refs.navReady). -->
      <div class="nav ready-options" class:on={scene === 'ready' && navRevealed} bind:this={refs.navReady} data-testid="onboarding-launchers"></div>
      <div class="alt-block" bind:this={refs.readyAlt}>
        {#if deferredConsent?.phase === 'failed'}
          <div class="note consent-error" role="alert" data-testid="consent-deferred-error">
            {#if deferredConsent.kind === 'offline'}
              <p>
                You appear to be offline, so your usage data choice couldn't be sent yet.
                It's saved on this machine and HQ will send it automatically the next
                time you're connected.
              </p>
            {:else}
              <p>
                We couldn't save your usage data choice to the server just now. Nothing
                was lost, your answer is held on this machine. Try again in a moment.
              </p>
            {/if}
            <div class="note-actions">
              <button
                class="btn btn-secondary"
                type="button"
                data-testid="consent-deferred-retry"
                onclick={() => void flushDeferredConsent()}
              ><RailIcon name="refresh" />Retry</button>
            </div>
          </div>
        {/if}
        <div class="ready-notes">
          {#if accountLookupFailed}
            <div class="note account-lookup-error" role="alert" data-testid="account-lookup-error">
              <p>We couldn't check your account. Check your connection and try again.</p>
              <div class="note-actions">
                <button
                  class="btn btn-secondary"
                  type="button"
                  data-testid="account-lookup-retry"
                  disabled={accountLookupRetrying}
                  aria-busy={accountLookupRetrying}
                  onclick={() => void retryAccountLookup()}
                >Try again</button>
              </div>
            </div>
          {/if}
          {#if returningAccount && companyPullRows.length > 0}
            <div class="note company-pull" role="status" aria-live="polite" data-testid="company-pull">
              <p class="company-pull-label">Bringing your companies to this Mac</p>
              <ul class="company-pull-rows">
                {#each companyPullRows as row (row.companyUid)}
                  <li class="company-pull-row" data-testid="company-pull-row" data-company={row.slug} data-status={row.status}>
                    {#if row.status === 'failed'}
                      {#if companyPullContinued}
                        <span>Couldn't bring {row.name} yet. HQ keeps trying.</span>
                      {:else}
                        <span>{companyPullRowLabel(row)}</span>
                        <button
                          class="btn btn-secondary"
                          type="button"
                          data-testid="company-pull-retry"
                          disabled={companyPullRunning}
                          onclick={() => void runReturningCompanyPull([row.companyUid])}
                        >Try again</button>
                      {/if}
                    {:else}
                      <span class="company-pull-name">{row.name}</span>
                      <span class="company-pull-state">{companyPullRowLabel(row)}</span>
                    {/if}
                  </li>
                {/each}
              </ul>
              {#if companyPullSettled && companyPullFailedRows.length > 0 && !companyPullContinued}
                <div class="note-actions">
                  <button
                    class="btn btn-secondary"
                    type="button"
                    data-testid="company-pull-continue"
                    onclick={() => (companyPullContinued = true)}
                  >Continue</button>
                </div>
              {/if}
            </div>
          {/if}
          {#if (finishError || readyWatchdogFired) && !blockingRetryRunning}
            <div class="note finish-action" role="status" data-testid="launcher-finish-error">
              <p>Finish HQ setup here when you’re ready.</p>
              <div class="note-actions">
                <button
                  class="btn btn-secondary"
                  type="button"
                  onclick={handleFinish}
                  disabled={finishing}
                  aria-busy={finishing}
                >{finishing ? 'Retrying…' : 'Finish setup'}</button>
              </div>
            </div>
          {/if}
        </div>
        <!-- Usage data: one quiet line, recorded when the person finishes.
             Not asked of an outpost: a fleet agent has no consent dialog. -->
        {#if consentOnReady}
        <div class="alt ready-consent" class:on={scene === 'ready' && navRevealed} data-testid="ready-consent">
          <label class="rc-check">
            <input
              type="checkbox"
              data-testid="ready-consent-share"
              checked={telemetryChoice === 'share'}
              disabled={readyConsentRecorded || consentSubmitting || finishing}
              onpointerdown={restartReadyDwell}
              onfocus={restartReadyDwell}
              onchange={(event) => {
                telemetryChoice = event.currentTarget.checked ? 'share' : 'decline';
                consentFailure = null;
                restartReadyDwell();
              }}
            />
            <span>Share anonymous usage data</span>
          </label>
          <span class="rc-sep" aria-hidden="true">·</span>
          <button
            type="button"
            class="consent-link"
            disabled={privacyOpening}
            aria-busy={privacyOpening}
            onclick={() => void handleOpenPrivacy()}
          >{privacyOpening ? 'Opening…' : privacyOpenError ? 'Retry opening what’s collected' : 'What’s collected'}</button>
          {#if hqAnywhereRuntimeEnabled}
            <label class="rc-check rc-check-next">
              <input
                type="checkbox"
                data-testid="ready-hq-anywhere"
                checked={hqAnywhereEnabled}
                disabled={!hqAnywhereSettingLoaded || hqAnywhereLoading || hqAnywhereSaving || hqAnywhereSettingUp || finishing}
                aria-busy={hqAnywhereLoading || hqAnywhereSaving || hqAnywhereSettingUp}
                onpointerdown={restartReadyDwell}
                onfocus={restartReadyDwell}
                onchange={(event) => {
                  restartReadyDwell();
                  void saveHqAnywhereSetting(event.currentTarget.checked);
                }}
              />
              <span>Enable HQ Anywhere</span>
            </label>
            {#if hqAnywhereLoading}
              <span role="status" aria-live="polite">Loading…</span>
            {:else if hqAnywhereSaving}
              <span role="status" aria-live="polite" data-testid="hq-anywhere-setting-saving">Saving…</span>
            {:else if hqAnywhereSettingUp}
              <span role="status" aria-live="polite" data-testid="hq-anywhere-setting-up">Setting up…</span>
            {/if}
            {#if hqAnywhereLoadError || hqAnywhereSettingError}
              <span data-testid="hq-anywhere-setting-error">
                <button
                  type="button"
                  class="consent-link hq-anywhere-retry"
                  data-testid="hq-anywhere-setting-retry"
                  disabled={hqAnywhereLoading || hqAnywhereSaving || finishing}
                  aria-busy={hqAnywhereLoading || hqAnywhereSaving}
                  onclick={retryHqAnywhereSetting}
                >Tap to retry</button>
              </span>
            {/if}
          {/if}
          {#if privacyOpenError}
            <span class="consent-link-error" role="alert">Couldn’t open the page.</span>
          {/if}
        </div>
        {/if}
        {#if consentFailure}
          <div
            class="note consent-error"
            class:offline={consentFailure.kind === 'offline'}
            role="alert"
            data-testid="consent-error"
          >
            {#if consentFailure.kind === 'offline'}
              <p>
                You appear to be offline, so your usage data choice couldn't be sent yet.
                It's saved on this machine and HQ will send it automatically the next
                time you're connected. You can finish setting up now.
              </p>
            {:else}
              <p>
                We couldn't save your usage data choice to the server just now. Nothing
                was lost, your answer is held on this machine. Try again in a moment.
              </p>
            {/if}
            <div class="note-actions">
              <button
                class="btn btn-secondary"
                type="button"
                data-testid="consent-retry"
                disabled={consentSubmitting || finishing}
                onclick={() => void handleFinish()}
              >{consentSubmitting ? 'Retrying…' : 'Retry'}</button>
              {#if consentFailure.kind === 'offline'}
                <button
                  class="btn btn-secondary"
                  type="button"
                  data-testid="consent-finish-offline"
                  disabled={consentSubmitting || finishing}
                  onclick={() => void finishOffline()}
                ><RailIcon name="check" />Finish setup, send later</button>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </section>

    <!-- After ready: the in-tool walkthrough, reachable by resume only. -->
    <section class="scene s-tutorial" class:on={scene === 'trust'} data-scene="trust" data-testid="onboarding-trust" aria-labelledby="onboarding-title-trust">
      <div class="panel-block" bind:this={refs['panel:trust']}>
        <div class="graphic" aria-hidden="true">{@render TrustMock()}</div>
        <h2 class="h h-md" id="onboarding-title-trust" tabindex="-1" data-scene-heading>Trust your workspace</h2>
        <p class="body">Claude Code will open with your hq folder selected and /setup ready to run. Choose “Yes, trust this workspace.” Just check that hq is still the folder it’s pointing at.</p>
        <div class="btns split"><button class="btn btn-secondary" type="button" onclick={() => goBackTo(READY_STEP_INDEX)}><RailIcon name="arrow-left" />Back</button><button class="btn btn-primary" type="button" onclick={() => advanceTo(SETTINGS_STEP_INDEX)}>Continue</button></div>
      </div>
    </section>

    <section class="scene s-tutorial" class:on={scene === 'settings'} data-scene="settings" data-testid="onboarding-settings" aria-labelledby="onboarding-title-settings">
      <div class="panel-block" bind:this={refs['panel:settings']}>
        <div class="graphic" aria-hidden="true">{@render SettingsMock()}</div>
        <h2 class="h h-md" id="onboarding-title-settings" tabindex="-1" data-scene-heading>Dial in your settings</h2>
        <p class="body">For the best results, use the latest models (Opus 4.8 or GPT-5.5), set thinking to “High” or above, and turn on auto mode (bypass permissions). You might need to flip that last one on in settings.</p>
        <div class="btns split"><button class="btn btn-secondary" type="button" onclick={() => goBackTo(TRUST_STEP_INDEX)}><RailIcon name="arrow-left" />Back</button><button class="btn btn-primary" type="button" onclick={() => advanceTo(RUN_SETUP_STEP_INDEX)}>Continue</button></div>
      </div>
    </section>

    <section class="scene s-tutorial" class:on={scene === 'run-setup'} data-scene="run-setup" data-testid="onboarding-run-setup" aria-labelledby="onboarding-title-run-setup">
      <div class="panel-block" bind:this={refs['panel:run-setup']}>
        <div class="graphic" aria-hidden="true">{@render SetupPromptMock()}</div>
        <h2 class="h h-md" id="onboarding-title-run-setup" tabindex="-1" data-scene-heading>Press enter to run /setup</h2>
        <p class="body">Hit ⏎ in the message box to start setup.</p>
        <div class="btns split"><button class="btn btn-secondary" type="button" onclick={() => goBackTo(SETTINGS_STEP_INDEX)}><RailIcon name="arrow-left" />Back</button><button class="btn btn-primary" type="button" onclick={() => advanceTo(HANDOFF_STEP_INDEX)}>Continue</button></div>
      </div>
    </section>

    <section class="scene s-tutorial" class:on={scene === 'handoff'} data-scene="handoff" data-testid="onboarding-handoff" aria-labelledby="onboarding-title-handoff">
      <div class="panel-block" bind:this={refs['panel:handoff']}>
        <div class="graphic" aria-hidden="true">{@render HandoffMock()}</div>
        <h2 class="h h-md" id="onboarding-title-handoff" tabindex="-1" data-scene-heading>Answer, then run /handoff</h2>
        <p class="body">Work through every question until it says setup is finished, then send “/handoff” to save everything to HQ’s memory. You’ll do this at the end of every session.</p>
        <div class="btns split"><button class="btn btn-secondary" type="button" onclick={() => goBackTo(RUN_SETUP_STEP_INDEX)}><RailIcon name="arrow-left" />Back</button><button class="btn btn-primary" type="button" onclick={() => advanceTo(BUILD_STEP_INDEX)}>Continue</button></div>
      </div>
    </section>

    <section class="scene s-tutorial" class:on={scene === 'build'} data-scene="build" data-testid="onboarding-build" aria-labelledby="onboarding-title-build">
      <div class="panel-block" bind:this={refs['panel:build']}>
        <div class="graphic" aria-hidden="true">{@render BuildMock()}</div>
        <h2 class="h h-md" id="onboarding-title-build" tabindex="-1" data-scene-heading>Open a fresh session and build</h2>
        <p class="body">Start with “/brainstorm” to get going. Working on a specific company? Send “/startwork acme” and describe what you want. Then it’s the same rhythm every time: start work, handoff, repeat.</p>
        {#if finishError}
          <p class="body" role="status" data-testid="onboarding-finish-error">
            Setup is saved on disk. Tap Retry to close this window.
          </p>
        {/if}
        <div class="btns split"><button class="btn btn-secondary" type="button" onclick={() => goBackTo(HANDOFF_STEP_INDEX)}><RailIcon name="arrow-left" />Back</button><button class="btn btn-primary" type="button" onclick={handleFinish} disabled={finishing} aria-busy={finishing}><RailIcon name="check" />{finishing ? 'Finishing…' : finishError ? 'Retry' : 'Done'}</button></div>
      </div>
    </section>
  {/if}

  {#if !consentOnly}
    <!-- chrome: progress ticks + Skip top-right, Back bottom-left -->
    <div class="topbar" class:on={chromeBooted && (chrome.ticks || chrome.skip !== null)}>
      <div class="ticks" aria-hidden="true">
        {#each Array.from({ length: chrome.tickCount }, (_, i) => i) as i (i)}
          <span class="tick" class:done={i < chrome.currentTick} class:cur={i === chrome.currentTick}>
            <span class="fill" bind:this={tickFills[i]}></span>
          </span>
        {/each}
      </div>
      {#if chrome.ticks}
        <span class="sr-only">Screen {chrome.currentTick + 2} of {chrome.tickCount + 1}</span>
      {/if}
      {#if chrome.skip}
        <button class="btn btn-ghost skip" type="button" data-testid="welcome-skip" disabled={leavingExplainers} onclick={skipIntro}>Skip intro</button>
      {/if}
    </div>
    <button
      class="btn btn-ghost back"
      class:on={chrome.back}
      type="button"
      data-testid="welcome-back"
      aria-hidden={!chrome.back}
      tabindex={chrome.back ? 0 : -1}
      onclick={goBack}
    >
      <svg class="barrow" viewBox="0 0 256 256" aria-hidden="true"><path fill="currentColor" d="M224,128a8,8,0,0,1-8,8H59.31l58.35,58.34a8,8,0,0,1-11.32,11.32l-72-72a8,8,0,0,1,0-11.32l72-72a8,8,0,0,1,11.32,11.32L59.31,120H216A8,8,0,0,1,224,128Z" /></svg>Back
    </button>
  {/if}

  {#if !replay && !consentOnly}
    <!-- The install, running in the background behind screens 2-4. The visible
         card is a one-line summary; the full checklist is for screen readers. -->
    <div
      class="setup"
      class:on={chrome.installCard && setupStarted && !installCardRetired}
      class:done={installCard.state === 'done'}
      class:retrying={installCard.state === 'retrying'}
      data-state={installCard.state}
      data-testid="onboarding-setup"
    >
      <i class="spin" aria-hidden="true"></i>
      <div aria-hidden="true">
        <span class="st">{installCard.title}</span>
        <span class="ss-stack">
          {#each installCardLines as line (line)}<span class="ss ghost">{line}</span>{/each}
          {#if installCard.line}<span class="ss live">{installCard.line}</span>{/if}
        </span>
      </div>
      <span
        class="bar"
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={overallPercent}
        data-testid="onboarding-setup-progress"
      ><i style:width={`${installCard.percent}%`}></i></span>
      <div class="sr-only">
        <p data-testid="onboarding-setup-expectation" data-host-os={setupHostOs}>{setupExpectation}</p>
        <ul aria-label="Setup checklist">
          {#each setupBands as band}
            <li class="li" data-band-status={band.status}>
              {band.label}:
              {#if band.status === 'active'}
                in progress
              {:else if band.status === 'done'}
                done
              {:else}
                waiting
              {/if}
              {#if band.status === 'active' && setupSubStatusModel.text}
                <span
                  class="li-sub"
                  role="status"
                  aria-live="polite"
                  data-testid="onboarding-setup-substatus"
                >
                  <span class="sub-text">{setupSubStatusModel.text}</span>
                  {#if setupSubStatusModel.elapsedLabel}
                    <span
                      class="sub-elapsed"
                      data-testid="onboarding-setup-elapsed"
                    >{setupSubStatusModel.elapsedLabel}</span>
                  {/if}
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    </div>
  {/if}
</div>

{#snippet GoogleMark()}
  <!-- the official Google G geometry, filled monochrome -->
  <svg viewBox="0 0 120 120" aria-hidden="true"><g fill="currentColor"><path d="M117.6,61.36c0-4.25-.38-8.35-1.09-12.27H60v23.21h32.29c-1.39,7.5-5.62,13.85-11.97,18.11v15.06h19.39c11.35-10.45,17.89-25.83,17.89-44.1Z" /><path d="M60,120c16.2,0,29.78-5.37,39.71-14.54l-19.39-15.05c-5.37,3.6-12.25,5.73-20.32,5.73-15.63,0-28.85-10.55-33.57-24.74H6.38v15.55C16.25,106.55,36.55,120,60,120Z" /><path d="M26.43,71.4c-1.2-3.6-1.88-7.45-1.88-11.4s.68-7.8,1.88-11.4V33.05H6.38C2.32,41.15,0,50.32,0,60s2.32,18.85,6.38,26.95l20.05-15.55Z" /><path d="M60,23.86c8.81,0,16.72,3.03,22.94,8.98l17.21-17.21C89.75,5.95,76.17,0,60,0,36.55,0,16.25,13.45,6.38,33.05l20.05,15.55C31.15,34.42,44.37,23.86,60,23.86Z" /></g></svg>
{/snippet}

{#snippet MicrosoftMark()}
  <svg viewBox="0 0 21 21" aria-hidden="true"><g fill="currentColor"><rect x="1" y="1" width="9" height="9" /><rect x="1" y="11" width="9" height="9" /><rect x="11" y="1" width="9" height="9" /><rect x="11" y="11" width="9" height="9" /></g></svg>
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
  .link-inline {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
  .hq-anywhere-retry {
    opacity: 0.68;
    font-size: 11px;
  }
  /* The welcome flow's own styles live in ./welcome/welcome.css (plain CSS,
     because its motion engines add classes Svelte cannot see). What stays
     here is scoped to the post-ready walkthrough's product mockups. */
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


  @keyframes sp { to { transform: rotate(360deg); } }

  @media (prefers-reduced-motion: reduce) {
    .mspin2 i,
    .caret {
      animation: none !important;
    }
    .caret {
      opacity: 1;
    }
  }
</style>
