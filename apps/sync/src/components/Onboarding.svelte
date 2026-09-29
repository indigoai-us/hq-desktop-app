<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
  import { onDestroy, onMount } from 'svelte';
  import {
    CONSENT_STEP_INDEX,
    initialStepForLifecycle,
    isMissingRootRecovery,
    WELCOME_SIGNIN_STEP_INDEX,
    type WizardMode,
  } from '../lib/onboarding-wizard';
  import type { StartupSetupEvidence } from '../lib/unexpected-startup-surface';
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
    /** Persisted setup markers used to route a missing-root install to recovery. */
    setupEvidence?: StartupSetupEvidence | null;
    /** The `prs_*` the re-prompt is keyed to (reprompt mode only). */
    repromptPersonUid?: string | null;
  }

  let {
    state: lifecycleStateProp,
    onfinish,
    mode = 'onboarding',
    setupEvidence = null,
    repromptPersonUid = null,
  }: Props = $props();

  /** Size of the `main` window once the welcome flow hands it back. */
  const COMPACT_WINDOW_SIZE = new LogicalSize(288, 360);
  /** The native fallback blur settles with the prototype's veil timing. */
  const WELCOME_BACKDROP_FADE_MS = 1800;

  /**
   * The person's desktop wallpaper (a JPEG data URL), painted behind the flow
   * and blurred and dimmed by its veil. `null` until read, and for good when it
   * cannot be read, in which case the native behind-window blur stands in.
   */
  let wallpaper = $state<string | null>(null);
  let destroyed = false;

  let initialStep = $state(0);
  let onboardingFlow = $state<OnboardingFlow>('first_install');
  let activeLifecycleState = $state<string | null>(null);

  // The main window carries the frosted popover vibrancy. The welcome flow
  // takes it off and re-applies it on the hand-back.
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

  async function setWelcomeWindow(enabled: boolean) {
    if (typeof invoke !== 'function') return;
    await invoke('set_welcome_window', { enabled }).catch(() => {});
  }

  async function readWallpaper(): Promise<string | null> {
    if (typeof invoke !== 'function') return null;
    try {
      const url = await invoke<string | null>('get_desktop_wallpaper');
      return typeof url === 'string' && url.startsWith('data:image/') ? url : null;
    } catch {
      return null;
    }
  }

  /**
   * Give the window to the welcome flow: it fills the work area of the current
   * monitor (native, `set_welcome_window`), and the person's wallpaper goes
   * behind it. Without a wallpaper, the native blur of whatever is behind the
   * window stands in, as before.
   */
  async function enterWelcomeWindow() {
    await setWindowVibrancy(false);
    if (destroyed) return;
    await setWelcomeWindow(true);
    const url = await readWallpaper();
    if (destroyed) return;
    if (url) {
      wallpaper = url;
    } else {
      await setWelcomeBackdrop(true);
    }
  }

  async function restorePopoverSize() {
    await setWelcomeBackdrop(false);
    await setWelcomeWindow(false);
    await setWindowVibrancy(true);
    try {
      const win = getCurrentWindow();
      await win.setShadow(true).catch(() => {});
      await win.setSize(COMPACT_WINDOW_SIZE);
      await win.center();
    } catch {
      // Non-Tauri / test environment.
    }
  }

  onMount(() => {
    void enterWelcomeWindow();
  });

  onDestroy(() => {
    destroyed = true;
    void restorePopoverSize();
  });

  $effect(() => {
    if (activeLifecycleState === lifecycleStateProp) return;
    activeLifecycleState = lifecycleStateProp;
    // Consent-only runs open straight on the consent step: there is no
    // sign-in, directory or setup to run. The replay opens on the welcome.
    initialStep =
      mode === 'onboarding'
        ? initialStepForLifecycle(lifecycleStateProp, setupEvidence)
        : mode === 'replay'
          ? WELCOME_SIGNIN_STEP_INDEX
          : CONSENT_STEP_INDEX;
    onboardingFlow =
      lifecycleStateProp === 'InstallResume' ||
      lifecycleStateProp === 'NeedsAuthForInstall' ||
      isMissingRootRecovery(lifecycleStateProp, setupEvidence)
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
  recoveringMissingRoot={isMissingRootRecovery(lifecycleStateProp, setupEvidence)}
  {mode}
  {repromptPersonUid}
  {wallpaper}
  onfinish={handleFinish}
/>
