import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

function cssRule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? '';
}

describe('visual QA batch 3 regressions', () => {
  const knowledge = readRepoFile('src/desktop-alt/panels/CompanyKnowledgePanel.svelte');
  const scopedFiles = readRepoFile('src/desktop-alt/panels/CompanyScopedFilesPanel.svelte');
  const palette = readRepoFile('src/desktop-alt/components/CommandPalette.svelte');
  const widget = readRepoFile('src/components/Widget.svelte');

  it('renders a high-contrast, accessible Knowledge selection prompt', () => {
    expect(knowledge).toContain('directory="knowledge"');
    expect(scopedFiles).toContain('data-testid={`company-${directory}-empty`}');
    expect(scopedFiles).toContain('role="status"');
    expect(scopedFiles).toContain('aria-labelledby={`${directory}-empty-title`}');
    expect(scopedFiles).toContain('aria-describedby={`${directory}-empty-description`}');
    expect(scopedFiles).toContain('Choose a file to preview');
    expect(cssRule(scopedFiles, '.scoped-empty-title')).toContain(
      'color: var(--v4-text-1)',
    );
});
  it('contains palette results in a bounded internal scroller', () => {
    const shell = cssRule(palette, '.command-palette');
    const list = cssRule(palette, '.command-list');
    expect(shell).toContain('display: flex');
    expect(shell).toContain('flex-direction: column');
    expect(shell).toContain('max-height: min(640px, calc(100dvh - 96px))');
    expect(list).toContain('flex: 1 1 auto');
    expect(list).toContain('min-height: 0');
    expect(list).toContain('overflow-y: auto');
    expect(list).toContain('overscroll-behavior: contain');
    expect(list).toContain('scroll-padding-block: 6px');
    expect(palette).toContain("scrollIntoView({ block: 'nearest' })");
  });

  it('keeps communications glass legible and the open-state wordmark subordinate', () => {
    expect(widget).toContain('class:surface-open={hoverOpen || contextMenuOpen}');
    expect(widget).toContain(
      '--row-bg: rgb(245 245 245 / clamp(0.82, calc(1 - var(--hq-window-transparency-factor, 0.65) * 0.277), 1))',
    );
    expect(widget).toContain(
      '--row-bg: rgb(24 24 24 / clamp(0.78, calc(1 - var(--hq-window-transparency-factor, 0.65) * 0.338), 1))',
    );
    expect(widget).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(widget).toContain('--row-bg: rgb(245 245 245)');
    expect(widget).toContain('--row-bg: rgb(24 24 24)');
    expect(widget).toContain('-webkit-backdrop-filter: none');
    expect(widget).toContain('backdrop-filter: none');
    expect(cssRule(widget, '.hover-list')).toContain('margin-bottom: 14px');
    expect(cssRule(widget, '.wg.surface-open .wm')).toContain('opacity: 0.58');
    expect(cssRule(widget, '.wg.surface-open .wm :global(svg)')).toContain('width: 44px');
  });
});
