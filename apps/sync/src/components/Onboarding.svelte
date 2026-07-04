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

  // The window is transparent so the card floats over the real desktop. Size it
  // generously around the 640x460 card + dot rail so the card's soft drop shadow
  // (70px blur) fades into transparency instead of being clipped into a visible
  // box at the window edge.
  const ONBOARDING_SIZE = new LogicalSize(860, 720);
  const POPOVER_SIZE = new LogicalSize(320, 480);

  let initialStep = $state(0);
  let activeLifecycleState = $state<string | null>(null);

  // The main window carries the frosted popover vibrancy. Onboarding is a
  // transparent floating card over the real desktop, so clear that material
  // while onboarding is up (otherwise it shows through the transparent webview
  // as a panel around the card) and re-apply it on the tray handoff.
  async function setWindowVibrancy(enabled: boolean) {
    if (typeof invoke !== 'function') return;
    await invoke('set_main_window_vibrancy', { enabled }).catch(() => {});
  }

  async function sizeForOnboarding() {
    await setWindowVibrancy(false);
    try {
      const win = getCurrentWindow();
      await win.setSize(ONBOARDING_SIZE);
      await win.center();
    } catch {
      // Non-Tauri / test environment.
    }
  }

  async function restorePopoverSize() {
    await setWindowVibrancy(true);
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
