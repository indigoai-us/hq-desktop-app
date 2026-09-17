import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const app = read('src/App.svelte');
const tray = read('src-tauri/src/tray.rs');
const mainRs = read('src-tauri/src/main.rs');
const trayHelper = read('src-tauri/src/tray_helper.rs');

/** Everything after the component's `</script>` — what the window paints. */
const markup = app.slice(app.lastIndexOf('</script>'));
/** The markup with its explanatory comments stripped. */
const markupCode = markup.replace(/<!--[\s\S]*?-->/g, '');
/** Everything before it — the controller that runs whether or not we paint. */
const script = app.slice(0, app.lastIndexOf('</script>'));

describe('PL-07: the tray popover is gone', () => {
  it('deletes the popover, its feed and its popover-only libs', () => {
    for (const path of [
      'src/components/Popover.svelte',
      'src/components/NotificationFeed.svelte',
      'src/lib/popover-window-size.ts',
      'src/lib/popover-refresh.ts',
      'src/lib/nativePopoverMaterial.ts',
    ]) {
      expect(existsSync(resolve(process.cwd(), path)), `${path} still exists`).toBe(false);
    }
  });

  it('leaves no import of a deleted module anywhere in the app', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'target') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(?:ts|svelte)$/.test(entry.name)) continue;
        const source = readFileSync(full, 'utf8');
        if (full === import.meta.filename) continue;
        if (
          /from\s+'[^']*(?:components\/Popover\.svelte|components\/NotificationFeed\.svelte|lib\/popover-window-size|lib\/popover-refresh|lib\/nativePopoverMaterial)'/.test(
            source,
          ) ||
          /\bbuildNotificationGroups\s*\(/.test(source)
        ) {
          offenders.push(full);
        }
      }
    };
    for (const dir of ['src', '__tests__', 'e2e', 'dev-harness']) {
      walk(resolve(process.cwd(), dir));
    }
    expect(offenders).toEqual([]);
  });

  it('keeps notificationFeedData and notificationGroups for the share-detail consumers', () => {
    expect(existsSync(resolve(process.cwd(), 'src/lib/notificationFeedData.ts'))).toBe(true);
    expect(existsSync(resolve(process.cwd(), 'src/lib/notificationGroups.ts'))).toBe(true);
    const pane = read('src/components/QuickWindowSidePane.svelte');
    expect(pane).toContain("from '../lib/notificationGroups'");
    expect(pane).toContain("from '../lib/notificationFeedData'");
  });

  it('keeps the window-resize capability, which onboarding still needs', () => {
    const capability = read('src-tauri/capabilities/default.json');
    expect(capability).toContain('core:window:allow-set-size');
    expect(read('src/components/Onboarding.svelte')).toContain('win.setSize(');
  });
});

describe('PL-06: the tray window stays hidden for a signed-in person', () => {
  it('renders nothing in the authenticated branch', () => {
    const branch = markup.slice(
      markup.indexOf('{:else if authenticated}'),
      markup.indexOf('{:else}'),
    );
    expect(branch).not.toBe('');
    // The popover mount is gone from the markup...
    expect(markup).not.toContain('<Popover');
    expect(script).not.toContain("from './components/Popover.svelte'");
    // ...and nothing else took its place: the branch is comment-only.
    expect(branch.replace(/<!--[\s\S]*?-->/g, '').replace(/\{:else if authenticated\}/, '').trim())
      .toBe('');
  });

  it('keeps the onboarding, consent and sign-in surfaces on `main`', () => {
    expect(markup).toContain('{:else if isOnboardingState(lifecycleState)}');
    expect(markup).toContain('<Onboarding');
    expect(markup).toContain('mode="reprompt"');
    expect(markup).toContain('<SignInPrompt');
  });

});

describe('PL-06: `main` keeps running as the controller while it renders nothing', () => {
  it('publishes the macOS menu-bar unread badge from the script, not the markup', () => {
    expect(script).toContain('new TrayMessageBadgePublisher(');
    expect(script).toContain("invoke<void>('set_tray_message_badge', { count })");
    expect(script).toMatch(
      /\$effect\(\(\) => \{\s*void trayMessageBadgePublisher\.publish\(\s*authenticated \? messagesUnreadCount : 0,/,
    );
    // The effect is component-level, so it runs in the authenticated-hidden
    // state exactly as it did when the popover was mounted.
    expect(markupCode).not.toContain('trayMessageBadgePublisher');
  });

  it('keeps driving the tray icon state and tooltip', () => {
    const trayStateCalls = script.match(/invoke\(\s*'set_tray_state'/g) ?? [];
    expect(trayStateCalls.length).toBeGreaterThan(5);
    expect(markupCode).not.toContain('set_tray_state');
    // The icon swap itself is Rust-side and reads the same command.
    expect(tray).toContain('pub fn update_tray_icon');
  });

  it('still derives the Messages count the badge publishes', () => {
    // Moved here from popover-notifications-redesign.test.ts, which PL-07
    // deleted with the popover it described. The derivation and its event
    // sources are live controller behaviour: they feed the macOS menu-bar
    // badge whether or not anything is painted.
    expect(script).toContain('const messagesUnreadCount = $derived(');
    expect(script).toContain('Math.max(0, unreadSummary.unreadDms)');
    expect(script).toContain('Math.max(0, unreadSummary.pendingRequests)');
    expect(script).toContain('Math.max(0, unreadSummary.channelUnread)');
    expect(script).toContain("invoke<ChannelsUnreadResponse | null>('list_channels')");
    expect(script).toContain("'channel:unread-changed'");
    expect(script).toContain("'channel:updated'");
    expect(markupCode).not.toContain('messagesUnreadCount');
  });

  it('keeps handling the tray menu commands', () => {
    for (const event of [
      'tray:sync-now',
      'tray:open-settings',
      'tray:open-desktop',
      'tray:sign-out',
      'tray:check-for-updates',
    ]) {
      expect(script).toContain(`listen('${event}'`);
    }
  });
});

describe('PL-06: no activation path can show an empty `main`', () => {
  it('routes tray left-click, the Dock icon and a second launch through the setup guard', () => {
    expect(tray).toMatch(
      /pub fn activate_primary_surface[\s\S]*?onboarding_window_requires_blur_suppression\(app\)[\s\S]*?show_popover_window\(app\)[\s\S]*?show_desktop_window\(app\)/,
    );
    // Tray left-click (in-process icon) and the macOS helper both take it.
    expect(tray).toContain('activate_primary_surface(&app_handle)');
    expect(trayHelper).toContain('crate::tray::activate_primary_surface(&app_main)');
    // Dock click + second launch.
    expect(mainRs).toContain('tray::activate_primary_surface(_app_handle)');
    expect(mainRs).toContain('tray::activate_primary_surface(app)');
  });

  it('gives the desktop global shortcut no popover fallback', () => {
    // Opt+Shift+O toggles `desktop-alt` and hides `main`; the retired
    // Opt+Shift+H popover toggle stayed retired in PL-05.
    expect(mainRs).not.toContain('toggle_popover_window');
    expect(mainRs).not.toContain('show_popover_window');
    expect(mainRs).toMatch(/desktop_visible[\s\S]*?open_desktop_alt_window_inner/);
  });

  it('guards the last remaining popover fallback on whether `main` has any UI', () => {
    expect(tray).toContain('pub(crate) fn main_window_has_ui(setup_owns_main: bool, authenticated: bool) -> bool');
    const toggleAt = tray.indexOf('pub fn toggle_desktop_window');
    const toggle = tray.slice(toggleAt, tray.indexOf('\n/// Show + focus the desktop workspace'));
    expect(toggle).toContain('get_auth_state');
    expect(toggle).toMatch(/if !main_window_has_ui\([\s\S]*?\{[\s\S]*?return;/);
    // The show call is still there, behind the guard, for onboarding/sign-in.
    expect(toggle).toContain('show_popover_window(&app_main)');
  });

  it('leaves exactly two callers of show_popover_window, both guarded', () => {
    const callers = (tray.match(/(?<!fn )show_popover_window\(&?app/g) ?? []).length;
    expect(callers).toBe(2);
    // PL-05 removed the tray-anchored show helper; nothing reintroduced it.
    expect(tray).not.toContain('pub fn show_window_at_tray');
  });
});
