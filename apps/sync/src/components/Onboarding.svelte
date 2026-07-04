<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
  import { onDestroy, onMount } from 'svelte';
  import type { FailedStageDetail, SetupCompletionResult } from '../lib/onboarding-setup';
  import {
    createWizardRouter,
    initialStepForLifecycle,
    WIZARD_STEPS,
    type WizardState,
  } from '../lib/onboarding-wizard';
  import DirectoryScreen from './onboarding/DirectoryScreen.svelte';
  import SetupScreen from './onboarding/SetupScreen.svelte';
  import SignInScreen from './onboarding/SignInScreen.svelte';
  import SummaryScreen from './onboarding/SummaryScreen.svelte';
  import WelcomeScreen from './onboarding/WelcomeScreen.svelte';
  import WizardShell from './onboarding/WizardShell.svelte';

  interface Props {
    state: string;
    onfinish?: () => void;
  }

  let { state: lifecycleStateProp, onfinish }: Props = $props();

  type LocalWizardState = WizardState & {
    telemetryEnabled: boolean;
    setupFailures: FailedStageDetail[];
  };

  let router = $state(createWizardRouter());
  let currentStep = $state(1);
  let activeLifecycleState = $state<string | null>(null);
  let wizardState = $state<LocalWizardState>({
    installPath: null,
    telemetryEnabled: true,
    setupFailures: [],
  });

  const canBack = $derived.by(() => {
    currentStep;
    return router.canGoBack;
  });
  const canNext = $derived.by(() => {
    currentStep;
    return router.canGoNext({
      installPath: wizardState.installPath,
    });
  });
  const nextLabel = $derived(currentStep === 1 ? 'Get Started' : 'Continue');

  function syncCurrentStep() {
    currentStep = router.currentStep;
  }

  // Onboarding runs as a full-page installer wizard, not the compact tray
  // popover. Grow + centre the window on entry so the left step rail and wide
  // content have room (matching the hq-installer look); the tray handoff
  // (handleFinish) restores the popover size.
  const ONBOARDING_SIZE = new LogicalSize(940, 600);
  const POPOVER_SIZE = new LogicalSize(320, 480);

  async function sizeForOnboarding() {
    try {
      const win = getCurrentWindow();
      await win.setSize(ONBOARDING_SIZE);
      await win.center();
    } catch {
      // Non-Tauri / test environment — nothing to size.
    }
  }

  async function restorePopoverSize() {
    try {
      await getCurrentWindow().setSize(POPOVER_SIZE);
    } catch {
      // Non-Tauri / test environment.
    }
  }

  onMount(() => {
    void sizeForOnboarding();
  });

  // Safety net: whatever exit path unmounts onboarding (finish, or a
  // lifecycle change from underneath us), always restore the popover size so
  // the tray window never stays stuck at the large installer size.
  onDestroy(() => {
    void restorePopoverSize();
  });

  $effect(() => {
    if (activeLifecycleState === lifecycleStateProp) return;

    activeLifecycleState = lifecycleStateProp;
    router = createWizardRouter({
      start: initialStepForLifecycle(lifecycleStateProp),
    });
    syncCurrentStep();
  });

  function handleBack() {
    router.back();
    syncCurrentStep();
  }

  function handleNext() {
    if (!router.canGoNext({ installPath: wizardState.installPath })) return;
    router.next();
    syncCurrentStep();
  }

  function handleTelemetryChange(enabled: boolean) {
    wizardState.telemetryEnabled = enabled;
  }

  function handleSignedIn() {
    router.next();
    syncCurrentStep();
  }

  function handleSetupComplete(result: SetupCompletionResult) {
    wizardState.setupFailures = result.failedStages;
    router.next();
    syncCurrentStep();
  }

  async function handleFinish() {
    if (typeof invoke === 'function') {
      await invoke('mark_first_run_complete').catch(() => {});
    }
    await restorePopoverSize();
    onfinish?.();
  }
</script>

<div class="onboarding-wizard" data-testid="onboarding-wizard">
  <WizardShell
    currentStep={currentStep}
    steps={WIZARD_STEPS}
    canBack={canBack}
    canNext={canNext}
    nextLabel={nextLabel}
    showFooter={currentStep !== 5}
    onback={handleBack}
    onnext={handleNext}
  >
    {#if currentStep === 1}
      <WelcomeScreen
        telemetryEnabled={wizardState.telemetryEnabled}
        ontelemetrychange={handleTelemetryChange}
      />
    {:else if currentStep === 2}
      <DirectoryScreen
        installPath={wizardState.installPath}
        oninstallpathchange={(path) => {
          wizardState.installPath = path;
        }}
      />
    {:else if currentStep === 3}
      <SignInScreen
        telemetryEnabled={wizardState.telemetryEnabled}
        onsignedin={handleSignedIn}
      />
    {:else if currentStep === 4}
      <SetupScreen
        installPath={wizardState.installPath}
        onsetupcomplete={handleSetupComplete}
      />
    {:else}
      <SummaryScreen
        installPath={wizardState.installPath}
        failedStages={wizardState.setupFailures}
        onfinish={handleFinish}
      />
    {/if}
  </WizardShell>
</div>

<style>
  /* Onboarding is a full-page installer wizard with the hq-installer look:
     always the dark zinc theme regardless of OS appearance. We pin every
     --popover-* token to its dark value here so the light-mode media query in
     popover.css can't flip the wizard to a white surface. */
  .onboarding-wizard {
    --popover-bg: #0b0b0e;
    --popover-surface: rgba(255, 255, 255, 0.06);
    --popover-surface-strong: rgba(255, 255, 255, 0.12);
    --popover-border: rgba(255, 255, 255, 0.12);
    --popover-highlight: rgba(255, 255, 255, 0.16);
    --popover-text: rgba(255, 255, 255, 0.86);
    --popover-text-muted: rgba(255, 255, 255, 0.5);
    --popover-text-heading: #ffffff;
    --popover-primary: #ffffff;
    --popover-primary-hover: #f4f4f5;
    --popover-primary-active: rgba(255, 255, 255, 0.82);
    --popover-primary-text: #09090b;
    --popover-danger: #f2a6a6;
    --popover-notice: rgba(255, 255, 255, 0.62);
    --popover-notice-strong: #ffffff;
    --popover-notice-bg: rgba(255, 255, 255, 0.05);
    --popover-notice-border: rgba(255, 255, 255, 0.14);
    --popover-divider: rgba(255, 255, 255, 0.08);
    --popover-action-hover: rgba(255, 255, 255, 0.08);
    --popover-progress-track: rgba(255, 255, 255, 0.12);
    --popover-progress-fill: #ffffff;

    display: flex;
    width: 100vw;
    height: 100vh;
    box-sizing: border-box;
    overflow: hidden;
    /* zinc-950 base with a subtle top glow, matching the installer's
       black/70 backdrop over a zinc field. */
    background:
      radial-gradient(120% 80% at 50% -20%, rgba(255, 255, 255, 0.05), transparent 60%),
      #09090b;
    color: var(--popover-text);
    font-family:
      -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  }
</style>
