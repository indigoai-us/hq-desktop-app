import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * Full-window sub-page headers (Library overlay, Settings, …) must share the
 * titlebar's traffic-light inset and height so the Back control is not drawn
 * under the macOS window controls.
 */

const PAGE_HEADER = '../../packages/ui/src/shell/PageHeader.svelte';
const TITLEBAR = '../../packages/ui/src/home/V4TitleBar.svelte';
const TOKENS = '../../packages/ui/src/home/tokens.css';
const LAYOUT = '../../packages/ui/src/home/titlebar-layout.ts';
const LIBRARY = '../../packages/ui/src/library/LibraryOverlay.svelte';
const SHELL_SETTINGS = '../../packages/ui/src/settings/ShellSettings.svelte';
const SETTINGS_PAGE = '../../packages/ui/src/settings/SettingsPage.svelte';
const MEETINGS = '../../packages/ui/src/meetings/MeetingsPage.svelte';
const NOTIFICATIONS = '../../packages/ui/src/inbox/NotificationsView.svelte';
const SHARED_FILES = '../../packages/ui/src/inbox/SharedFilesOverlay.svelte';

describe('sub-page headers reserve the window-controls inset', () => {
  it('defines one shared height and leading-inset CSS variable', () => {
    const tokens = readRepoFile(TOKENS);
    const layout = readRepoFile(LAYOUT);
    expect(layout).toContain('export const TITLEBAR_HEIGHT_PX = 48');
    expect(layout).toContain('export const TITLEBAR_TRAFFIC_LIGHT_GUTTER_PX = 78');
    expect(layout).toContain('export const TITLEBAR_WINDOWS_LEADING_INSET_PX = 12');
    expect(layout).toContain('--titlebar-height');
    expect(layout).toContain('--titlebar-leading-inset');
    expect(tokens).toContain('--titlebar-height: 48px');
    expect(tokens).toContain('--titlebar-leading-inset: 16px');
    expect(tokens).toMatch(
      /\.has-window-controls\s*\{[\s\S]*--titlebar-leading-inset:\s*78px/,
    );
    expect(tokens).toMatch(
      /html\[data-platform=["']windows["']\]\s*\{[\s\S]*--titlebar-leading-inset:\s*12px/,
    );
  });

  it('titlebar and PageHeader consume those variables (no hardcoded 78px gutter)', () => {
    const titleBar = readRepoFile(TITLEBAR);
    const pageHeader = readRepoFile(PAGE_HEADER);
    expect(titleBar).toContain('var(--titlebar-height');
    expect(titleBar).toContain('var(--titlebar-leading-inset)');
    expect(titleBar).not.toMatch(/padding-left:\s*78px/);
    expect(pageHeader).toContain('var(--titlebar-height');
    expect(pageHeader).toContain('var(--titlebar-leading-inset');
    expect(pageHeader).toContain('data-tauri-drag-region');
    expect(pageHeader).not.toMatch(/padding-left:\s*\d+px/);
  });

  it('every Back-header destination uses PageHeader', () => {
    for (const file of [
      LIBRARY,
      SHELL_SETTINGS,
      SETTINGS_PAGE,
      MEETINGS,
      NOTIFICATIONS,
      SHARED_FILES,
    ]) {
      const source = readRepoFile(file);
      expect(source, file).toContain('<PageHeader');
      expect(source, file).not.toMatch(/padding-left:\s*\d+px/);
    }
  });
});
