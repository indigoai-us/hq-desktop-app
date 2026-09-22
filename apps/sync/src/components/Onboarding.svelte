<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { currentMonitor, getCurrentWindow, LogicalSize } from '@tauri-apps/api/window';
  import { onDestroy, onMount } from 'svelte';
  import { initialStepForLifecycle, CONSENT_STEP_INDEX, type WizardMode } from '../lib/onboarding-wizard';
  import type { OnboardingFlow } from '../lib/onboarding-step-telemetry';
  import OnboardingWizard from './onboarding/OnboardingWizard.svelte';
  import CinematicIntro from './onboarding/CinematicIntro.svelte';
  import { enterIntroFullscreen, exitIntroFullscreen } from '../lib/intro-window';

  interface Props {
    state: string;
    onfinish?: () => void | Promise<void>;
    /**
     * `'onboarding'` (default) runs the full first-run wizard. `'consent'`
     * shows ONLY the consent step for a machine that is installed and signed
     * in but has no consent answer on record, then marks first run complete.
     * `'reprompt'` (US-005) shows ONLY the consent step to re-ask a person
     * whose recorded answer is stale — same floating-card chrome, but it must
     * NOT mark first run complete on finish (that already happened long ago).
     * `'replay'` plays ONLY the cinematic intro (menu-bar "Replay welcome
     * intro") and calls `onfinish` when it ends — no wizard, no flag writes.
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

  // The window is transparent so the card floats over the real desktop. Give a
  // small margin around the 640x460 card so its 18px rounded corners render
  // anti-aliased against transparency (not clipped hard at the window edge) and
  // the card's own soft drop shadow can breathe. The native window shadow stays
  // OFF (below), so this margin shows only the desktop + the card's soft CSS
  // shadow — no hard rectangular outline.
  const ONBOARDING_SIZE = new LogicalSize(780, 620);
  const COMPACT_WINDOW_SIZE = new LogicalSize(288, 360);

  /**
   * The film plays once per install. A person who quits partway through setup
   * and reopens HQ is resuming a task, not arriving for the first time —
   * replaying four beats of brand copy at them would be a tax, not a welcome.
   */
  const INTRO_SEEN_KEY = 'hq.onboarding.introSeen';

  function introAlreadySeen(): boolean {
    try {
      return window.localStorage.getItem(INTRO_SEEN_KEY) === '1';
    } catch (err) {
      // Private mode / disabled storage: treat as seen so nobody can be trapped
      // re-watching the intro on every launch.
      console.warn('onboarding: intro-seen flag unreadable', err);
      return true;
    }
  }

  function markIntroSeen(): void {
    try {
      window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    } catch (err) {
      console.warn('onboarding: intro-seen flag not persisted', err);
    }
  }

  async function responsiveOnboardingSize(
    target: LogicalSize = ONBOARDING_SIZE,
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

  // Whether the cinematic intro is currently on screen. Only a genuine first
  // install opens on it; `reprompt` and resumed installs go straight to the form.
  let showIntro = $state(false);
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

  /**
   * Size the window to the floating setup card. The native material stays OFF
   * here: the frosted popover panel would show through the transparent webview
   * as a rectangle around the card. The intro does not come through this path
   * at all — it takes the whole screen through `set_intro_fullscreen`, which
   * owns its own material, level and frame.
   */
  async function sizeForOnboarding(target: LogicalSize = ONBOARDING_SIZE) {
    await setWindowVibrancy(false);
    try {
      const win = getCurrentWindow();
      // Drop the native window shadow so only the card's own CSS shadow shows —
      // otherwise the transparent window's shadow traces a rectangle on the desktop.
      await win.setShadow(false).catch(() => {});
      await win.setSize(await responsiveOnboardingSize(target));
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
      await win.setSize(COMPACT_WINDOW_SIZE);
    } catch {
      // Non-Tauri / test environment.
    }
  }

  /** True while the window is the full-screen film rather than the card. */
  let introOwnsWindow = false;

  async function enterIntroWindow() {
    introOwnsWindow = true;
    await enterIntroFullscreen(introInvoke);
  }

  /**
   * Hand the screen back. Resolves only once the window is its old size, level
   * and decorations again, so everything after this line acts on the card
   * window rather than on a full-screen one.
   */
  async function exitIntroWindow() {
    if (!introOwnsWindow) return;
    introOwnsWindow = false;
    await exitIntroFullscreen(introInvoke);
  }

  const introInvoke = (command: string, args?: Record<string, unknown>) =>
    typeof invoke === 'function' ? invoke(command, args) : Promise.resolve(undefined);

  onMount(() => {
    showIntro =
      mode === 'replay' ||
      (mode === 'onboarding' &&
        lifecycleStateProp === 'NeedsInstall' &&
        !introAlreadySeen());
    void (showIntro ? enterIntroWindow() : sizeForOnboarding(ONBOARDING_SIZE));
  });

  /**
   * The film is decoration in front of setup, so it must never be able to
   * block setup. If `CinematicIntro` throws while mounting or rendering — a
   * driver that cannot give a canvas at all, a shader that will not compile
   * on this GPU — the sheet would otherwise sit there as a black rectangle
   * with no way forward. Drop straight to the wizard instead, and treat the
   * intro as seen so a deterministic failure on this machine cannot re-trap
   * the person on every launch.
   */
  function handleIntroError(error: unknown) {
    console.error('onboarding: cinematic intro failed, falling through', error);
    if (mode === 'replay') {
      void exitIntroWindow().then(() => onfinish?.());
      return;
    }
    markIntroSeen();
    showIntro = false;
    // Give the screen back BEFORE sizing the card — otherwise the card is set
    // on a window that is still full screen and still above the menu bar.
    void exitIntroWindow().then(() => sizeForOnboarding(ONBOARDING_SIZE));
  }

  async function handleIntroFinish() {
    // Fade the film (and the desktop blur) out first, then let the window go
    // back to whatever comes next.
    await exitIntroWindow();
    if (mode === 'replay') {
      // Nothing follows a replay. Unmounting restores the popover material
      // and size (onDestroy), then the parent hides the sheet.
      await onfinish?.();
      return;
    }
    markIntroSeen();
    showIntro = false;
    // Shrink back to the wizard card the film was covering.
    await sizeForOnboarding(ONBOARDING_SIZE);
  }

  onDestroy(() => {
    // An unmount mid-film (the sheet torn down under us) still has to hand the
    // screen back before the window becomes the compact popover again.
    void exitIntroWindow().then(() => restorePopoverSize());
  });

  $effect(() => {
    if (activeLifecycleState === lifecycleStateProp) return;
    activeLifecycleState = lifecycleStateProp;
    // Consent-only runs open straight on the consent step — there is no
    // sign-in, directory or setup to run.
    initialStep =
      mode === 'onboarding' ? initialStepForLifecycle(lifecycleStateProp) : CONSENT_STEP_INDEX;
    onboardingFlow =
      lifecycleStateProp === 'InstallResume' || lifecycleStateProp === 'NeedsAuthForInstall'
        ? 'resume'
        : 'first_install';
  });

  async function handleFinish() {
    // The re-prompt is NOT first-run: the person has been running HQ for a while.
    // Marking first run complete again would be a lie, and its side effects
    // (writing realtimeSync/personalSyncEnabled defaults) are not wanted here.
    if (mode !== 'reprompt' && typeof invoke === 'function') {
      await invoke('mark_first_run_complete');
    }
    // Hand off from the centered installer card to the desktop workspace.
    // `show_main_window_at_tray` opens the desktop window and only then
    // dismisses this card, so a failed open leaves the card on screen.
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

{#if showIntro}
  <svelte:boundary onerror={handleIntroError}>
    <CinematicIntro onfinish={handleIntroFinish} />
    {#snippet failed()}
      <!-- `handleIntroError` has already swapped in the wizard; render nothing
           for the frame in between rather than a broken half-film. -->
    {/snippet}
  </svelte:boundary>
{:else}
  <OnboardingWizard
    {initialStep}
    {onboardingFlow}
    mode={mode === 'replay' ? 'onboarding' : mode}
    {repromptPersonUid}
    onfinish={handleFinish}
  />
{/if}
