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

  // The window is transparent so the card floats over the real desktop. Give a
  // small margin around the 640x460 card so its 18px rounded corners render
  // anti-aliased against transparency (not clipped hard at the window edge) and
  // the card's own soft drop shadow can breathe. The native window shadow stays
  // OFF (below), so this margin shows only the desktop + the card's soft CSS
  // shadow — no hard rectangular outline.
  const ONBOARDING_SIZE = new LogicalSize(780, 620);
  const POPOVER_SIZE = new LogicalSize(296, 360);

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
      // Drop the native window shadow so only the card's own CSS shadow shows —
      // otherwise the transparent window's shadow traces a rectangle on the desktop.
      await win.setShadow(false).catch(() => {});
      await win.setSize(ONBOARDING_SIZE);
      await win.center();
    } catch {
      // Non-Tauri / test environment.
    }
  }

  async function restorePopoverSize() {
    await setWindowVibrancy(true);
    try {
      const win = getCurrentWindow();
      await win.setShadow(true).catch(() => {});
      await win.setSize(POPOVER_SIZE);
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
    // Hand off from the centered installer card to the compact popover anchored
    // next to the menu-bar tray icon.
    if (typeof invoke === 'function') {
      await invoke('show_main_window_at_tray').catch(() => {});
    }
    onfinish?.();
  }
</script>

<OnboardingWizard {initialStep} onfinish={handleFinish} />
