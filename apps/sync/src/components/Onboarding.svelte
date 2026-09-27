<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { currentMonitor, getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
  import { onDestroy, onMount } from 'svelte';
  import { initialStepForLifecycle, CONSENT_STEP_INDEX, WELCOME_SIGNIN_STEP_INDEX, type WizardMode } from '../lib/onboarding-wizard';
  import type { OnboardingFlow } from '../lib/onboarding-step-telemetry';
  import OnboardingWizard from './onboarding/OnboardingWizard.svelte';

  interface Props {
    state: string;
    onfinish?: () => void | Promise<void>;
    /**
     * `'onboarding'` (default) runs the full first-run welcome flow. `'consent'`
     * shows ONLY the consent step for a machine that is installed and signed
     * in but has no consent answer on record, then marks first run complete.
     * `'reprompt'` (US-005) shows ONLY the consent step to re-ask a person
     * whose recorded answer is stale, and must NOT mark first run complete on
     * finish (that already happened long ago). `'replay'` plays the welcome
     * story screens only (menu-bar "Replay welcome intro") and calls
     * `onfinish` when it ends: no sign-in, folder, install or consent, and no
     * flag writes.
     */
    mode?: WizardMode | 'replay';
    /** The `prs_*` the re-prompt is keyed to (reprompt mode only). */
    repromptPersonUid?: string | null;
  }

  let {
    state: lifecycleStateProp,
    onfinish,
    mode = 'onboarding',
    repromptPersonUid = null,
  }: Props = $props();

  /**
   * The welcome flow is a full-bleed window (designer prototype: ~800x900)
   * over a native blur of the person's own desktop. It shrinks to fit a
   * smaller screen, keeping a small margin so the rounded corners and the
   * window shadow never touch the screen edge.
   */
  const WELCOME_WINDOW_SIZE = new LogicalSize(800, 900);
  const COMPACT_WINDOW_SIZE = new LogicalSize(288, 360);
  /** The blur settles over the desktop with the prototype's veil timing. */
  const WELCOME_BACKDROP_FADE_MS = 1800;

  async function responsiveWelcomeSize(
    target: LogicalSize = WELCOME_WINDOW_SIZE,
  ): Promise<LogicalSize> {
    try {
      const monitor = await currentMonitor();
      if (!monitor) return target;
      const workArea = monitor.workArea.size.toLogical(monitor.scaleFactor);
      return new LogicalSize(
        Math.max(360, Math.min(target.width, workArea.width - 32)),
        Math.max(420, Math.min(target.height, workArea.height - 32)),
      );
    } catch {
      return target;
    }
  }

  let initialStep = $state(0);
  let onboardingFlow = $state<OnboardingFlow>('first_install');
  let activeLifecycleState = $state<string | null>(null);

  // The main window carries the frosted popover vibrancy. The welcome flow
  // replaces it with its own dark behind-window blur (`set_welcome_backdrop`)
  // and re-applies the popover material on the tray handoff.
  async function setWindowVibrancy(enabled: boolean) {
    if (typeof invoke !== 'function') return;
    await invoke('set_main_window_vibrancy', { enabled }).catch(() => {});
  }

  async function setWelcomeBackdrop(enabled: boolean) {
    if (typeof invoke !== 'function') return;
    await invoke('set_welcome_backdrop', {
      enabled,
      fadeMs: WELCOME_BACKDROP_FADE_MS,
    }).catch(() => {});
  }

  /**
   * Size the window to the welcome flow and put the blurred desktop behind it.
   * The window stays transparent; the renderer draws only the veil and the
   * content, so there is no rectangle of wallpaper or card to see.
   */
  async function sizeForWelcome() {
    await setWindowVibrancy(false);
    try {
      const win = getCurrentWindow();
      await win.setSize(await responsiveWelcomeSize(WELCOME_WINDOW_SIZE));
      await win.center();
    } catch {
      // Non-Tauri / test environment.
    }
    await setWelcomeBackdrop(true);
  }

  async function restorePopoverSize() {
    await setWelcomeBackdrop(false);
    await setWindowVibrancy(true);
    try {
      const win = getCurrentWindow();
      await win.setShadow(true).catch(() => {});
      await win.setSize(COMPACT_WINDOW_SIZE);
    } catch {
      // Non-Tauri / test environment.
    }
  }

  onMount(() => {
    void sizeForWelcome();
  });

  onDestroy(() => {
    void restorePopoverSize();
  });

  $effect(() => {
    if (activeLifecycleState === lifecycleStateProp) return;
    activeLifecycleState = lifecycleStateProp;
    // Consent-only runs open straight on the consent step: there is no
    // sign-in, directory or setup to run. The replay opens on the welcome.
    initialStep =
      mode === 'onboarding'
        ? initialStepForLifecycle(lifecycleStateProp)
        : mode === 'replay'
          ? WELCOME_SIGNIN_STEP_INDEX
          : CONSENT_STEP_INDEX;
    onboardingFlow =
      lifecycleStateProp === 'InstallResume' || lifecycleStateProp === 'NeedsAuthForInstall'
        ? 'resume'
        : 'first_install';
  });

  async function handleFinish() {
    // Nothing follows a replay, and it writes no flags. Unmounting restores
    // the popover material and size (onDestroy), then the parent hides the
    // window or brings back whatever was on screen before.
    if (mode === 'replay') {
      await onfinish?.();
      return;
    }
    // The re-prompt is NOT first-run: the person has been running HQ for a while.
    // Marking first run complete again would be a lie, and its side effects
    // (writing realtimeSync/personalSyncEnabled defaults) are not wanted here.
    if (mode !== 'reprompt' && typeof invoke === 'function') {
      await invoke('mark_first_run_complete');
    }
    // Hand off from the welcome window to the desktop workspace.
    // `show_main_window_at_tray` opens the desktop window and only then
    // dismisses this one, so a failed open leaves the welcome on screen.
    if (typeof invoke === 'function') {
      try {
        await invoke('show_main_window_at_tray');
      } catch {
        await restorePopoverSize();
      }
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
