import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const titleBar = readFileSync(
  new URL('./v4/V4TitleBar.svelte', import.meta.url),
  'utf8',
);
const versionPopout = readFileSync(
  new URL('./components/VersionPopout.svelte', import.meta.url),
  'utf8',
);
const tokens = readFileSync(
  new URL('./v4/tokens.css', import.meta.url),
  'utf8',
);

describe('desktop visual hierarchy regressions', () => {
  it('keeps pressed global controls neutral while preserving aria-pressed selection', () => {
    expect(titleBar).toContain("aria-pressed={!sidebarCollapsed}");
    const selectedRule = titleBar.match(
      /\.v4-icon-btn\[aria-pressed='true'\]\s*\{([\s\S]*?)\}/,
    )?.[1];
    expect(selectedRule).toContain('var(--v4-control-border)');
    expect(selectedRule).toContain('var(--v4-text-1)');
    expect(selectedRule).not.toMatch(
      /purple|violet|indigo|#[456789a-f][0-9a-f]{5}/i,
    );
  });

  it('uses a stronger neutral glass material and comfortable update-popout spacing', () => {
    expect(tokens).toContain(
      '--v4-glass-filter-popover: blur(40px) saturate(124%) contrast(104%);',
    );
    expect(tokens).toContain(
      '--v4-popover-strong: rgba(250, 250, 250, 0.8);',
    );
    expect(tokens).toContain(
      '--v4-popover-strong: rgba(36, 36, 36, 0.82);',
    );
    expect(versionPopout).toContain('width: 336px;');
    expect(versionPopout).toContain('padding: 16px;');
    expect(versionPopout).toContain('min-height: 34px;');
    expect(versionPopout).toContain('transform-origin: top right;');
  });
});
