import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolvePendingDesktopRoute,
  SETTINGS_SECTIONS,
} from '../../src/desktop-alt/route';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const source = (...parts: string[]) => readFileSync(root(...parts), 'utf8');

describe('Settings > Appearance', () => {
  it('is a routed first-class Settings section', () => {
    expect(SETTINGS_SECTIONS).toContainEqual({
      id: 'appearance',
      label: 'Appearance',
    });
    expect(resolvePendingDesktopRoute('settings:appearance')).toEqual({
      kind: 'settings',
      tab: 'appearance',
    });
  });

  it('offers theme, full-range window opacity, and global interface size without a card shell', () => {
    const page = source('src/desktop-alt/pages/SettingsPage.svelte');

    expect(page).toContain('data-testid="settings-appearance"');
    expect(page).toContain('<strong>Theme</strong>');
    expect(page).toContain('<strong>Window opacity</strong>');
    expect(page).toContain('100% is fully solid');
    expect(page).toContain('aria-label="Window opacity"');
    expect(page).toContain('windowTransparencyFromOpacity(');
    expect(page).toContain('<strong>Interface size</strong>');
    expect(page).toContain('requestAppearancePreferenceChange');
    expect(page).toContain('requestDesktopZoom');
    expect(page).toMatch(
      /\.settings-card\s*\{[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*transparent;/,
    );
  });

  it('persists appearance durably in MenubarPrefs and hydrates it on load (US-016)', () => {
    const page = source('src/desktop-alt/pages/SettingsPage.svelte');

    // The saveSettings patch carries the three durable appearance fields …
    expect(page).toMatch(/theme:\s*appearance\.colorTheme/);
    expect(page).toMatch(
      /windowOpacity:\s*windowOpacityFromTransparency\(/,
    );
    expect(page).toMatch(
      /interfaceSize:\s*Math\.round\(interfaceZoom \* 100\)/,
    );
    // … and load hydration applies persisted values back to the live stores,
    // treating absent fields as "no constraint" for old menubar.json files.
    expect(page).toContain('settings.theme ?? null');
    expect(page).toContain('settings.windowOpacity ?? null');
    expect(page).toContain('settings.interfaceSize ?? null');
    expect(page).toContain('normalizeColorTheme(wireTheme)');
    expect(page).toContain('windowTransparencyFromOpacity(wireOpacity)');
    expect(page).toContain('normalizeDesktopZoom(wireSize / 100)');

    // The Rust side models the same three fields with serde defaults so old
    // configs load and absent fields stay absent (pass-through, no coercion).
    const config = readFileSync(
      root('..', '..', 'crates', 'hq-desktop-core', 'src', 'config.rs'),
      'utf8',
    );
    expect(config).toContain('pub theme: Option<String>');
    expect(config).toContain('pub window_opacity: Option<u8>');
    expect(config).toContain('pub interface_size: Option<u16>');
    const settingsCmd = source('src-tauri/src/commands/settings.rs');
    expect(settingsCmd).toContain('theme: prefs.theme');
    expect(settingsCmd).toContain('window_opacity: prefs.window_opacity');
    expect(settingsCmd).toContain('interface_size: prefs.interface_size');
  });

  it('spans the US-016 slider ranges: opacity 35–100%, interface size 75–150%', async () => {
    const page = source('src/desktop-alt/pages/SettingsPage.svelte');
    expect(page).toMatch(/aria-label="Window opacity"[\s\S]{0,400}/);
    expect(page).toMatch(/min="35"\s*\n\s*max="100"/);

    const zoom = await import('../../src/lib/desktopZoom');
    expect(zoom.MIN_DESKTOP_ZOOM).toBe(0.75);
    expect(zoom.MAX_DESKTOP_ZOOM).toBe(1.5);
  });

  it('installs native theme propagation before both desktop hosts mount', () => {
    const main = source('src/main.ts');
    const desktopMain = source('src/desktop-alt/main.ts');
    const defaultCapability = source(
      'src-tauri/capabilities/default.json',
    );
    const desktopCapability = source(
      'src-tauri/capabilities/desktop-alt.json',
    );

    for (const entry of [main, desktopMain]) {
      expect(entry).toContain('installAppearancePreferences');
      expect(entry).toContain('setTheme(theme)');
    }
    expect(defaultCapability).toContain('core:app:allow-set-app-theme');
    expect(desktopCapability).toContain('core:app:allow-set-app-theme');
  });

  it('drives broad neutral materials while keeping reduced-transparency fallbacks solid', () => {
    const tokens = source('src/desktop-alt/v4/tokens.css');
    const shared = source('src/styles/design-system.css');

    expect(tokens).toContain('--hq-window-transparency-factor');
    expect(tokens).toMatch(
      /--v4-ground:\s*rgb\(242 242 242 \/[^\n]+--hq-window-transparency-factor/,
    );
    expect(tokens).toContain(
      '@media (prefers-reduced-transparency: reduce)',
    );
    expect(tokens).toContain('--v4-ground: #f2f2f2');
    expect(shared).toContain('--compact-glass-bg:rgb(');
  });
});
