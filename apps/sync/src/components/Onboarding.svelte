<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
  import { isPermissionGranted, sendNotification } from '@tauri-apps/plugin-notification';
  import { open as openExternal } from '@tauri-apps/plugin-shell';
  import { createScreenTimer, FIRST_RUN_TIMING_TAG } from '@hq/ui/first-run-timing';
  import { onDestroy, onMount, untrack } from 'svelte';
  import {
    HEADS_UP_SCREEN_ID,
    HEADS_UP_WINDOW_SIZE,
    runHeadsUpAction,
    startSessionScan,
    type HeadsUpAction,
  } from '../lib/heads-up';
  import {
    CONSENT_STEP_INDEX,
    initialStepForLifecycle,
    isMissingRootRecovery,
    WELCOME_SIGNIN_STEP_INDEX,
    type WizardMode,
  } from '../lib/onboarding-wizard';
  import type { StartupSetupEvidence } from '../lib/unexpected-startup-surface';
  import type { OnboardingFlow } from '../lib/onboarding-step-telemetry';
  import HeadsUpWindow from './onboarding/HeadsUpWindow.svelte';
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

  /**
   * A genuine first install opens on a small heads-up window before the flow
   * takes the screen (install-flow-rethink US-002). Resumes, folder recovery,
   * consent-only runs and the replay go straight to the wizard. Read once at
   * mount: the window setup in onMount depends on it.
   */
  const opensOnHeadsUp = untrack(
    () =>
      mode === 'onboarding' &&
      lifecycleStateProp !== 'InstallResume' &&
      lifecycleStateProp !== 'NeedsAuthForInstall' &&
      !isMissingRootRecovery(lifecycleStateProp, setupEvidence) &&
      initialStepForLifecycle(lifecycleStateProp, setupEvidence) === WELCOME_SIGNIN_STEP_INDEX,
  );
  let showHeadsUp = $state(opensOnHeadsUp);

  const headsUpTimer = createScreenTimer('welcome', (message) => {
    if (typeof invoke !== 'function') return;
    void invoke('frontend_log', { tag: FIRST_RUN_TIMING_TAG, message }).catch((error) => {
      console.warn('onboarding: first-run timing line failed', error);
    });
  });

  // The main window carries the frosted popover vibrancy. The welcome flow
  // takes it off and re-applies it on the hand-back.
  async function setWindowVibrancy(enabled: boolean) {
    if (typeof invoke !== 'function') return;
    await invoke('set_main_window_vibrancy', { enabled }).catch((error) => {
      console.error('onboarding: window vibrancy failed', error);
    });
  }

  async function setWelcomeBackdrop(enabled: boolean) {
    if (typeof invoke !== 'function') return;
    await invoke('set_welcome_backdrop', {
      enabled,
      fadeMs: WELCOME_BACKDROP_FADE_MS,
    }).catch((error) => {
      console.error('onboarding: welcome backdrop failed', error);
    });
  }

  async function setWelcomeWindow(enabled: boolean) {
    if (typeof invoke !== 'function') return;
    await invoke('set_welcome_window', { enabled }).catch((error) => {
      console.error('onboarding: welcome window failed', error);
    });
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
      await win.setShadow(true).catch((error) => {
        console.error('onboarding: window shadow failed', error);
      });
      await win.setSize(COMPACT_WINDOW_SIZE);
      await win.center();
    } catch {
      // Non-Tauri / test environment.
    }
  }

  /**
   * Show the heads-up as a small centred card. The native side may already
   * have fitted the window to the screen for the first run, so hand that back
   * first, then size and centre it.
   */
  async function enterHeadsUpWindow() {
    await setWelcomeWindow(false);
    if (destroyed) return;
    try {
      const win = getCurrentWindow();
      await win.setSize(new LogicalSize(HEADS_UP_WINDOW_SIZE.width, HEADS_UP_WINDOW_SIZE.height));
      await win.center();
    } catch (error) {
      console.warn('onboarding: could not size the heads-up window', error);
    }
  }

  async function notify(title: string, body: string) {
    if (await isPermissionGranted()) {
      sendNotification({ title, body });
    } else {
      console.warn('onboarding: notifications are off; the setup reminder only reopens the window');
    }
  }

  async function handleHeadsUpAction(action: HeadsUpAction) {
    await runHeadsUpAction(action, {
      startFlow: async () => {
        headsUpTimer.close();
        showHeadsUp = false;
        await enterWelcomeWindow();
      },
      hideToTray: async () => {
        if (typeof invoke !== 'function') return;
        await invoke('hide_main_window');
      },
      openUrl: async (url) => {
        await openExternal(url);
      },
      notify,
      bringToFront: async () => {
        if (typeof invoke !== 'function') return;
        await invoke('bring_main_window_to_front');
      },
      storage: typeof localStorage === 'undefined' ? null : localStorage,
    });
  }

  onMount(() => {
    if (opensOnHeadsUp) {
      headsUpTimer.show(HEADS_UP_SCREEN_ID);
      void startSessionScan(typeof invoke === 'function' ? invoke : undefined);
      void enterHeadsUpWindow();
    } else {
      void enterWelcomeWindow();
    }
  });

  onDestroy(() => {
    destroyed = true;
    headsUpTimer.close();
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

{#if showHeadsUp}
  <HeadsUpWindow onaction={handleHeadsUpAction} />
{:else}
  <OnboardingWizard
    {initialStep}
    {onboardingFlow}
    recoveringMissingRoot={isMissingRootRecovery(lifecycleStateProp, setupEvidence)}
    {mode}
    {repromptPersonUid}
    {wallpaper}
    onfinish={handleFinish}
  />
{/if}
