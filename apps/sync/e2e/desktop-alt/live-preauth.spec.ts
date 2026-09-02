import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLivePreAuthProbe, type LiveDesktopAltProbe } from './live-driver';

/**
 * Live Windows smoke against a real built/installed binary, scoped to what a
 * signed-out machine can actually reach.
 *
 * WHY PRE-AUTH: a GitHub runner has no Cognito session, and there is no honest
 * way to give it one — a fabricated token or a CI login secret would be a fake
 * user, and loosening `feature_gate::desktop_features_enabled` to let the test
 * through would delete the very check this suite is supposed to protect. So the
 * signed-out state is not a limitation worked around here, it is the subject:
 * this file asserts that the shipped binary boots, paints its sign-in surface
 * cleanly, and that the desktop-alt gate refuses an unauthenticated caller in
 * the exact way the Rust code says it does.
 *
 * The signed-in desktop-alt surfaces (Home / Meetings / Company) stay covered
 * by `smoke-pages.spec.ts` in the scripted `Desktop-alt E2E` job — this file
 * does not replace that coverage and must not be pointed at those routes.
 *
 * ONE SESSION FOR THE WHOLE FILE: `tauri_plugin_single_instance` folds a second
 * launch of the app into the already-running process, so a per-test WebDriver
 * session attaches to a webview that never got a Tauri bridge ("Tauri invoke
 * bridge is not exposed to WebDriver"). The app is booted once in `beforeAll`
 * and every test shares it.
 */

/** The literal the Rust gate returns — `commands/desktop_alt.rs`. */
const SIGNED_OUT_GATE_ERROR = 'desktop-alt requires a signed-in user';

// A full TermSrv recovery takes 10 seconds, may need its one final retry, and
// the built binary needs startup margin before the single shared driver can
// invoke a command. This bound is intentionally larger than that complete
// failure-recovery path without becoming an open-ended CI wait.
const OBSERVER_READY_DEADLINE_MS = 30_000;
const OBSERVER_READY_POLL_MS = 200;
// ExitRequested gives the observer and child-process teardown 500ms each. Five
// seconds leaves a generous runner margin while still catching a stalled quit.
const APP_EXIT_DEADLINE_MS = 5_000;

let app: LiveDesktopAltProbe;

describe('desktop-alt live pre-auth smoke (Windows)', () => {
  beforeAll(async () => {
    // Throws (never degrades to the scripted harness) when the driver, the
    // app path, or the WebView2 automation switches are missing. Session
    // creation itself is the proof that msedgedriver attached to the real
    // `msedgewebview2.exe` — see `assertWebviewAutomationSwitches`.
    app = await createLivePreAuthProbe();
  });

  afterAll(async () => {
    await app?.dispose();
  });

  it('boots the real binary and paints the signed-out popover with no console errors', async () => {
    // Not "a handle exists": wait for the app's own rendered text. Both
    // pre-auth surfaces the app can land on — the install wizard's
    // welcome/sign-in step and the bare `SignInPrompt` — offer exactly these
    // two identity providers, and no post-auth surface offers either.
    await app.waitForBodyText(/(Log in|Continue) with Google/);

    const surface = await app.evaluate<{
      windowLabel: string | null;
      readyState: string;
      signedInPopoverRendered: boolean;
      preAuthSurface: string | null;
      signInButtonLabels: string[];
      renderedTextLength: number;
    }>(`
      const root = document.documentElement;
      const wizardPanel = document.querySelector('[data-testid="onboarding-signin"]');
      const signInCard = document.querySelector('.sign-in-card');
      const preAuthSurface = wizardPanel && wizardPanel.classList.contains('on')
        ? 'onboarding-signin'
        : (signInCard ? 'sign-in-prompt' : null);
      const signInButtonLabels = Array.from(document.querySelectorAll('button'))
        .map((button) => (button.textContent || '').replace(/\\s+/g, ' ').trim())
        .filter((label) => /Google|Microsoft/.test(label));
      return {
        windowLabel: root.dataset.window || null,
        readyState: document.readyState,
        signedInPopoverRendered: Boolean(document.querySelector('[data-testid="popover-root"]')),
        preAuthSurface,
        signInButtonLabels,
        renderedTextLength: (document.body.innerText || '').trim().length,
      };
    `);

    expect(surface.windowLabel).toBe('main');
    expect(surface.readyState).toBe('complete');
    // The Svelte app mounted and chose a pre-auth branch — a blank/white
    // webview, a crashed mount, or a bundle that failed to load all fail here.
    expect(surface.preAuthSurface).not.toBeNull();
    expect(surface.renderedTextLength).toBeGreaterThan(40);
    // Real, clickable sign-in affordances, not just matching page text.
    expect(surface.signInButtonLabels.some((label) => /Google/.test(label))).toBe(true);
    expect(surface.signInButtonLabels.some((label) => /Microsoft/.test(label))).toBe(true);
    // The authenticated popover must never render for a signed-out user.
    expect(surface.signedInPopoverRendered).toBe(false);

    const consoleErrors = await app.consoleErrors();
    if (consoleErrors.length > 0) {
      console.log(`[desktop-alt-e2e] pre-auth console errors:\n${consoleErrors.join('\n')}`);
    }
    expect(consoleErrors).toEqual([]);
  });

  it('reports a genuinely signed-out backend', async () => {
    // Without this the gate assertions below would pass just as well against
    // an app that *was* signed in but broken — the refusal only proves the
    // gate works if there really is no session on this machine.
    expect(await app.invokeCommand<boolean>('has_stored_token')).toBe(false);
    expect(
      await app.invokeCommand<{ authenticated: boolean }>('get_auth_state'),
    ).toMatchObject({ authenticated: false });
  });

  it('registers the session-end observer in the real Windows binary', async () => {
    const deadline = Date.now() + OBSERVER_READY_DEADLINE_MS;
    let status = 'unavailable';
    do {
      status = await app.invokeCommand<string>('session_end_observer_status');
      if (status === 'registered') {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, OBSERVER_READY_POLL_MS));
    } while (Date.now() < deadline);

    throw new Error(
      `session-end observer did not register within ${OBSERVER_READY_DEADLINE_MS}ms; last status=${status}`,
    );
  });

  it('reports the live OS as not tearing down through the teardown probe (HQ-DESKTOP-4N)', async () => {
    // The r2 pull-based teardown probe reads the real OS shutdown flag
    // (`GetSystemMetrics(SM_SHUTTINGDOWN)`) rather than waiting for a window
    // message. On a healthy runner that is genuinely not shutting down, the real
    // built binary must report exactly `no`. This is what proves the probe
    // answers to the OS state and not to any message: nothing short of a real
    // session teardown can make it read `yes`, so a bare `WM_QUERYENDSESSION`
    // delivered to the app can never manufacture a confirmed teardown.
    const status = await app.invokeCommand<string>('session_end_teardown_probe_status');
    expect(status, `teardown probe reported ${status} on a healthy runner`).toBe('no');
  });

  it('reports the durable session-end latch as unset on a healthy runner (HQ-DESKTOP r3)', async () => {
    // The r3 durable latch is written ONLY from positive OS session-end evidence
    // (a committed WM_ENDSESSION / WTS logoff, or the app's own session-end exit
    // branch). On a healthy runner where no session end was delivered, the real
    // built binary must report the latch as NOT set — proving the read-only
    // surface is wired into the shipped invoke handler and that nothing short of
    // a real session end can make it read `latched`. The value is always one of
    // the three fixed, content-safe tokens.
    const status = await app.invokeCommand<string>('session_end_latch_status');
    expect(['latched', 'absent', 'unavailable'], `latch reported ${status}`).toContain(status);
    expect(status, `latch reported ${status} without a session end`).not.toBe('latched');
  });

  it('refuses to open the desktop window for a signed-out user', async () => {
    // `desktop_alt_enabled` is what App.svelte, the tray and the notification
    // deep-links consult before offering the surface at all.
    expect(await app.invokeCommand<boolean>('desktop_alt_enabled')).toBe(false);

    // Defense in depth: the command re-enters the gate itself, so a caller
    // that ignores the flag still gets refused — by this exact message.
    await expect(app.invokeCommand('open_desktop_alt_window')).rejects.toThrow(
      SIGNED_OUT_GATE_ERROR,
    );

    // The refusal has to be real. If a regression ever built the window before
    // (or despite) the gate, a desktop-alt webview would now be attached to
    // this session and this assertion is what catches it.
    expect(await app.hasDesktopAltWindow()).toBe(false);
  });

  it('runs the real quit path and exits the Windows process within its bound', async () => {
    await app.quitAndAssertExited(APP_EXIT_DEADLINE_MS);
  });
});
