import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const source = (...parts: string[]) => readFileSync(root(...parts), 'utf8');

describe('Settings > Appearance', () => {

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
