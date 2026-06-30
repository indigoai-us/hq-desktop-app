<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
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
  };

  let router = $state(createWizardRouter());
  let currentStep = $state(1);
  let activeLifecycleState = $state<string | null>(null);
  let wizardState = $state<LocalWizardState>({
    installPath: null,
    telemetryEnabled: true,
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

  function handleSetupComplete() {
    router.next();
    syncCurrentStep();
  }

  async function handleFinish() {
    if (typeof invoke === 'function') {
      await invoke('mark_first_run_complete').catch(() => {});
    }
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
      <SignInScreen onsignedin={handleSignedIn} />
    {:else if currentStep === 4}
      <SetupScreen onsetupcomplete={handleSetupComplete} />
    {:else}
      <SummaryScreen installPath={wizardState.installPath} onfinish={handleFinish} />
    {/if}
  </WizardShell>
</div>

<style>
  .onboarding-wizard {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100vw;
    height: 100vh;
    box-sizing: border-box;
    padding: var(--space-4, 16px);
    overflow: hidden;
    border: 1px solid var(--popover-border, rgba(255, 255, 255, 0.18));
    border-radius: var(--radius-xl, 18px);
    background: var(--popover-bg, rgba(18, 18, 20, 0.68));
    color: var(--popover-text, rgba(255, 255, 255, 0.86));
    box-shadow: inset 0 1px 0 var(--popover-highlight, rgba(255, 255, 255, 0.34));
    backdrop-filter: var(--popover-blur, blur(28px) saturate(1.45));
    -webkit-backdrop-filter: var(--popover-blur, blur(28px) saturate(1.45));
  }
</style>
