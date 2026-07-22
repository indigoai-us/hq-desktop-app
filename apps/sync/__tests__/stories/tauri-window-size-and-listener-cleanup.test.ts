import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Source-contract coverage for Sentry HQ-DESKTOP-38 and HQ-DESKTOP-39. The
// unit suite does not boot a native Tauri webview, so pin the frontend calls,
// window label, and ACL permission together.
const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));

const mainCapability = JSON.parse(
  readFileSync(root('src-tauri/capabilities/default.json'), 'utf8'),
) as { windows: string[]; permissions: string[] };
const popover = readFileSync(root('src/components/Popover.svelte'), 'utf8');
const onboarding = readFileSync(root('src/components/Onboarding.svelte'), 'utf8');
const app = readFileSync(root('src/App.svelte'), 'utf8');

describe('HQ-DESKTOP-38: main-window resize ACL', () => {
  it('authorizes the main window to resize itself', () => {
    expect(mainCapability.windows).toContain('main');
    expect(mainCapability.permissions).toContain('core:window:allow-set-size');
  });

  it('keeps the permission paired with the legitimate resize callers', () => {
    // The popover resize is guarded to the main window and its async rejection
    // is caught, so a denied resize in a non-main window (new-files-detail,
    // messages) can never become an UnhandledRejection (HQ-DESKTOP-38).
    expect(popover).toContain('isPopoverResizeWindow(win.label)');
    expect(popover).toMatch(/\.setSize\(new LogicalSize\(POPOVER_WIDTH, height\)\)\s*\.catch\(/);
    expect(onboarding).toContain('win.setSize(ONBOARDING_SIZE)');
    expect(onboarding).toContain('win.setSize(POPOVER_SIZE)');
  });
});

describe('HQ-DESKTOP-39: late main-window listener cleanup', () => {
  it('unlistens handles that resolve after the app surface is disposed', () => {
    expect(app).toMatch(/class ListenerRegistry[\s\S]*?if \(this\.disposed\)[\s\S]*?unlisten\(\)/);
    expect(app).toContain('async function setupTrayListeners(unlisteners: ListenerRegistry)');
    expect(app).toContain('void setupTrayListeners(listenerRegistry)');
    expect(app).toContain('return () => listenerRegistry.dispose();');
  });
});
