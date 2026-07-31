import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? '';
}

describe('Settings and updater visual perfection', () => {
  const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');
  const versionPopout = readRepoFile(
    'src/desktop-alt/components/VersionPopout.svelte',
  );
  const commandPalette = readRepoFile(
    'src/desktop-alt/components/CommandPalette.svelte',
  );
  const settings = readRepoFile('src/desktop-alt/pages/SettingsPage.svelte');
  const widget = readRepoFile('src/components/WidgetSettings.svelte');

  it('stacks the titlebar above the desktop canvas so the updater popout is visible', () => {
    const titlebarRule = rule(titleBar, '.v4-titlebar');

    expect(titlebarRule).toContain('position: relative');
    expect(titlebarRule).toContain('z-index: 10');
    expect(titlebarRule).toContain('overflow: visible');
    expect(rule(commandPalette, '.command-backdrop')).toContain('z-index: 50');
  });

  it('keeps settings failures visible after section navigation auto-scrolls', () => {
    const errorRule = rule(settings, '.error');

    expect(errorRule).toContain('position: sticky');
    expect(errorRule).toContain('top:');
    expect(errorRule).toContain('border-bottom: 1px solid var(--v4-rowline)');
    expect(errorRule).toContain(
      'background: color-mix(in srgb, var(--v4-ground) 68%, transparent)',
    );
    expect(errorRule).toContain('backdrop-filter: var(--v4-glass-filter-soft)');
    expect(errorRule).not.toContain('border-left:');
    expect(errorRule).not.toContain('border-inline-start:');
  });

  it('does not repeat the page-level load failure inside the Widget section', () => {
    expect(settings).toContain('<WidgetSettings showLoadError={false} />');
    expect(widget).toContain('showLoadError = true');
    expect(widget).toContain('{:else if loadError && showLoadError}');
  });

  it('uses the same compact semantic switch treatment for Widget as Settings', () => {
    const toggleRule = rule(widget, '.toggle');
    const activeRule = rule(widget, '.toggle.active');
    const knobRule = rule(widget, '.toggle-knob');

    expect(toggleRule).toContain('width: 26px');
    expect(toggleRule).toContain('height: 16px');
    expect(activeRule).toContain('background: var(--v4-ok');
    expect(knobRule).toContain('width: 12px');
    expect(knobRule).toContain('height: 12px');
    expect(widget).toContain('.toggle:focus-visible');
    expect(widget).toContain('.display-picker:focus-visible');
  });

  it('shows keyboard focus on every interactive updater control', () => {
    expect(versionPopout).toContain('.vp-btn:focus-visible');
    expect(versionPopout).toContain('.vp-settings-link:focus-visible');
    expect(versionPopout).toContain(
      ".vp-toggle-row input[type='checkbox']:focus-visible",
    );
  });

  it('uses the same compact switch treatment inside the updater popout', () => {
    const toggleRule = rule(
      versionPopout,
      ".vp-toggle-row input[type='checkbox']",
    );
    const checkedRule = rule(
      versionPopout,
      ".vp-toggle-row input[type='checkbox']:checked",
    );

    expect(toggleRule).toContain('appearance: none');
    expect(toggleRule).toContain('width: 26px');
    expect(toggleRule).toContain('height: 16px');
    expect(checkedRule).toContain('background: var(--v4-ok');
  });

  it('stacks updater recovery actions before they can overflow a compact desktop', () => {
    expect(rule(settings, '.settings-main')).toContain(
      'container-type: inline-size',
    );
    expect(settings).toContain('@container settings-main (max-width: 760px)');
    expect(settings).toMatch(
      /#updates \.setting-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
    expect(settings).toMatch(
      /#updates \.row-actions\s*\{[\s\S]*?width:\s*100%;[\s\S]*?justify-content:\s*flex-start/,
    );
    expect(rule(settings, '.row-actions')).toContain('flex-wrap: wrap');
    expect(rule(settings, '.row-actions')).toContain('min-width: 0');
  });
});
