<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
  import { onDestroy, onMount } from 'svelte';
  import { initialStepForLifecycle } from '../lib/onboarding-wizard';
  import OnboardingWizard from './onboarding/OnboardingWizard.svelte';

  interface Props {
    state: string;
    onfinish?: () => void;
  }

  let { state: lifecycleStateProp, onfinish }: Props = $props();

  const ONBOARDING_SIZE = new LogicalSize(760, 560);
  const POPOVER_SIZE = new LogicalSize(320, 480);

  let initialStep = $state(0);
  let activeLifecycleState = $state<string | null>(null);

  async function sizeForOnboarding() {
    try {
      const win = getCurrentWindow();
      await win.setSize(ONBOARDING_SIZE);
      await win.center();
    } catch {
      // Non-Tauri / test environment.
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

  onDestroy(() => {
    void restorePopoverSize();
  });

  $effect(() => {
    if (activeLifecycleState === lifecycleStateProp) return;
    activeLifecycleState = lifecycleStateProp;
    initialStep = initialStepForLifecycle(lifecycleStateProp);
  });

  async function handleFinish() {
    if (typeof invoke === 'function') {
      await invoke('mark_first_run_complete').catch(() => {});
    }
    await restorePopoverSize();
    onfinish?.();
  }
</script>

<OnboardingWizard {initialStep} onfinish={handleFinish} />
