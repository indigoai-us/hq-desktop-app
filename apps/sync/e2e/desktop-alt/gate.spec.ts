import { describe, expect, it } from 'vitest';
import { DesktopAltHarness } from './harness';

// The expanded desktop window graduated from the Indigo-only dogfood to GA:
// `desktop_alt_enabled` is now true for ANY signed-in user (non-empty email
// claim), regardless of domain, and false only when signed out. This mirrors
// the Rust gate `feature_gate::desktop_features_enabled` / `email_present`.
//
// These assert the gate, not a control: the popover's `desktop-alt-toggle`
// button was removed in 3114f6a6 and the desktop view is opened by
// `invoke('open_desktop_alt_window')` from App.svelte, the NotificationFeed
// and the tray.
describe('desktop-alt gate visibility (GA)', () => {
  it('enables the desktop view for an Indigo email', () => {
    const app = new DesktopAltHarness('qa@getindigo.ai');

    expect(app.bootApp().desktopAltEnabled).toBe(true);
  });

  it('enables the desktop view for a non-Indigo email (GA)', () => {
    const app = new DesktopAltHarness('qa@example.com');

    expect(app.bootApp().desktopAltEnabled).toBe(true);
  });

  it('enables the desktop view for the former dogfood look-alike (GA)', () => {
    // `attacker@forgetindigo.ai` was blocked under the Indigo dogfood gate;
    // under GA the gate only checks email presence, so it is now enabled.
    const app = new DesktopAltHarness('attacker@forgetindigo.ai');

    expect(app.bootApp().desktopAltEnabled).toBe(true);
  });

  it('disables the desktop view when signed out (no email)', () => {
    const app = new DesktopAltHarness('');

    expect(app.bootApp().desktopAltEnabled).toBe(false);
  });

  it('disables the desktop view when the email is whitespace-only', () => {
    const app = new DesktopAltHarness('   ');

    expect(app.bootApp().desktopAltEnabled).toBe(false);
  });
});
