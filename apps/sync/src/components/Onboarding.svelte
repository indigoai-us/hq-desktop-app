<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { currentMonitor, getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
  import { onDestroy, onMount } from 'svelte';
  import { initialStepForLifecycle, CONSENT_STEP_INDEX } from '../lib/onboarding-wizard';
  import type { OnboardingFlow } from '../lib/onboarding-step-telemetry';
  import OnboardingWizard from './onboarding/OnboardingWizard.svelte';

  interface Props {
    state: string;
    onfinish?: () => void | Promise<void>;
    /**
     * `'onboarding'` (default) runs the full first-run wizard. `'reprompt'`
     * (US-005) shows ONLY the consent step to re-ask a person whose recorded
     * answer is stale — same floating-card chrome, but it must NOT mark first
     * run complete on finish (that already happened long ago).
     */
    mode?: 'onboarding' | 'reprompt';
    /** The `prs_*` the re-prompt is keyed to (reprompt mode only). */
    repromptPersonUid?: string | null;
  }

  let {
    state: lifecycleStateProp,
    onfinish,
    mode = 'onboarding',
    repromptPersonUid = null,
  }: Props = $props();

  // The window is transparent so the card floats over the real desktop. Give a
  // small margin around the 640x460 card so its 18px rounded corners render
  // anti-aliased against transparency (not clipped hard at the window edge) and
  // the card's own soft drop shadow can breathe. The native window shadow stays
  // OFF (below), so this margin shows only the desktop + the card's soft CSS
  // shadow — no hard rectangular outline.
  const ONBOARDING_SIZE = new LogicalSize(780, 620);
  const POPOVER_SIZE = new LogicalSize(296, 360);

  async function responsiveOnboardingSize(): Promise<LogicalSize> {
    try {
      const monitor = await currentMonitor();
      if (!monitor) return ONBOARDING_SIZE;
      const workArea = monitor.workArea.size.toLogical(monitor.scaleFactor);
      return new LogicalSize(
        Math.max(360, Math.min(ONBOARDING_SIZE.width, workArea.width - 32)),
        Math.max(420, Math.min(ONBOARDING_SIZE.height, workArea.height - 32)),
      );
    } catch {
      return ONBOARDING_SIZE;
    }
  }

  let initialStep = $state(0);
  let onboardingFlow = $state<OnboardingFlow>('first_install');
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
      await win.setSize(await responsiveOnboardingSize());
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
    // The re-prompt opens straight on the consent step — there is no sign-in,
    // directory or setup to run.
    initialStep =
      mode === 'reprompt'
        ? CONSENT_STEP_INDEX
        : initialStepForLifecycle(lifecycleStateProp);
    onboardingFlow =
      lifecycleStateProp === 'InstallResume' || lifecycleStateProp === 'NeedsAuthForInstall'
        ? 'resume'
        : 'first_install';
  });

  async function handleFinish() {
    // The re-prompt is NOT first-run: the person has been running HQ for a while.
    // Marking first run complete again would be a lie, and its side effects
    // (writing realtimeSync/personalSyncEnabled defaults) are not wanted here.
    if (mode === 'onboarding' && typeof invoke === 'function') {
      await invoke('mark_first_run_complete');
    }
    await restorePopoverSize();
    // Hand off from the centered installer card to the compact popover anchored
    // next to the menu-bar tray icon.
    if (typeof invoke === 'function') {
      await invoke('show_main_window_at_tray');
    }
    await onfinish?.();
  }
</script>

<OnboardingWizard
  {initialStep}
  {onboardingFlow}
  {mode}
  {repromptPersonUid}
  onfinish={handleFinish}
/>
