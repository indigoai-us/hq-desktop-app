import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ACL, native sizing, and the repo-wide listener wiring stay source guards.
// The unit suite does not boot a native Tauri webview, so these facts cannot
// be observed by calling the listener helpers.
const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));

const mainCapability = JSON.parse(
  readFileSync(root('src-tauri/capabilities/default.json'), 'utf8'),
) as { windows: string[]; permissions: string[] };
const onboarding = readFileSync(root('src/components/Onboarding.svelte'), 'utf8');
const nativeMain = readFileSync(root('src-tauri/src/main.rs'), 'utf8');
const nativeWelcome = readFileSync(root('src-tauri/src/welcome_window.rs'), 'utf8');
const app = readFileSync(root('src/App.svelte'), 'utf8');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|svelte)$/.test(entry.name) ? [path] : [];
  });
}

describe('HQ-DESKTOP-38: main-window resize ACL', () => {
  it('authorizes the main window to resize itself', () => {
    expect(mainCapability.windows).toContain('main');
    expect(mainCapability.permissions).toContain('core:window:allow-set-size');
  });

  it('keeps the permission paired with its one remaining caller, onboarding', () => {
    // PL-07 deleted the tray popover, which was the other `setSize` caller.
    // The welcome flow now fills the work area natively (`set_welcome_window`)
    // and Onboarding shrinks the window back to the compact size when it hands
    // it back, so `core:window:allow-set-size` stays required for that.
    expect(onboarding).toContain("invoke('set_welcome_window', { enabled })");
    expect(onboarding).toContain('win.setSize(COMPACT_WINDOW_SIZE)');
  });

  it('caps first-run onboarding to the active monitor work area on every platform', () => {
    // One native helper sizes the welcome window for first run, the consent
    // re-prompt and the replay: the current monitor's work area, not the
    // full display.
    expect(nativeWelcome).toContain('pub fn fit_to_work_area(');
    expect(nativeWelcome).toContain('current_monitor()');
    expect(nativeWelcome).toContain('monitor.work_area()');
    expect(nativeMain).toContain('welcome_window::fit_to_work_area(&window)');
  });
});

describe('HQ-DESKTOP-39: listener wiring guards', () => {
  it('wires the shared ListenerRegistry into the app-surface lifecycle', () => {
    expect(app).toMatch(
      /import \{[^}]*\bListenerRegistry\b[^}]*\} from '\.\/lib\/listener-registry'/,
    );
    expect(app).toContain('async function setupTrayListeners(unlisteners: ListenerRegistry)');
    expect(app).toContain('void setupTrayListeners(listenerRegistry)');
    // Surface teardown must invalidate and cancel the channel-unread retry
    // before disposing Tauri listeners so no late timer can re-register work.
    expect(app).toMatch(
      /return \(\) => \{[\s\S]*?channelUnreadDisposed = true;[\s\S]*?clearChannelUnreadRetry\(\);[\s\S]*?listenerRegistry\.dispose\(\);[\s\S]*?\};/,
    );
  });

  it('routes every Tauri listener surface through safeUnlisten or ListenerRegistry', () => {
    const listenerSurfaces = sourceFiles(root('src')).filter((path) => {
      if (path.endsWith('.test.ts')) return false;
      const source = readFileSync(path, 'utf8');
      return (
        (source.includes('@tauri-apps/api/event') ||
          source.includes('this.listen(') ||
          // A focus surface no longer has to import the event module itself —
          // `subscribeWindowFocus` owns that registration now — but it is still
          // a listener surface and still needs the teardown boundary.
          source.includes('subscribeWindowFocus(')) &&
        (source.includes('listen(') || source.includes('subscribeWindowFocus('))
      );
    });

    expect(listenerSurfaces).not.toEqual([]);
    for (const path of listenerSurfaces) {
      const source = readFileSync(path, 'utf8');
      expect(
        source.includes('safeUnlisten') ||
          source.includes('ListenerRegistry') ||
          source.includes('subscribeWindowFocus'),
        `${path} registers a Tauri listener without the shared teardown boundary`,
      ).toBe(true);
    }
  });

  it('routes the US-010 repair-notice listener through the throw-safe boundary', () => {});
});
