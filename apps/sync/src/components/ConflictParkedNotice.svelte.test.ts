import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'svelte/server';
import ConflictParkedNotice from './ConflictParkedNotice.svelte';
import type { ConflictParkedNotice as Notice } from '../lib/conflictNotices';

const notice: Notice = {
  id: 'a'.repeat(64),
  scope: 'company',
  companySlug: 'indigo',
  relativePath: 'boards/primary.md',
  backupPath: '.hq/conflict-backups/boards/primary.md.backup',
  winnerReason: 'remote-newer',
  sideKept: 'remote',
  parkedAt: '2026-10-08T15:00:00.000Z',
};

const many = (count: number): Notice[] =>
  Array.from({ length: count }, (_, index) => ({
    ...notice,
    id: String(index).repeat(64).slice(0, 64),
    relativePath: 'boards/file-' + index + '.md',
  }));

const readSource = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const componentSource = readSource('./ConflictParkedNotice.svelte');
const styleBlock = componentSource.slice(componentSource.indexOf('<style>'));

/** Body of the first CSS rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styleBlock.match(new RegExp('(^|\\n)\\s*' + escaped + '\\s*\\{([^}]*)\\}'));
  return match?.[2] ?? '';
}

const renderNotices = (notices: Notice[]) =>
  render(ConflictParkedNotice, {
    props: { notices, busyIds: new Set<string>(), onShowInFinder: vi.fn(), onAcknowledge: vi.fn() },
  }).body;

describe('ConflictParkedNotice rendering', () => {
  it('names the file and provides Finder and acknowledgement actions', () => {
    const html = renderNotices([notice]);

    expect(html).toContain('Conflict copy parked');
    expect(html).toContain('boards/primary.md');
    expect(html).toContain('Show in Finder');
    expect(html).toContain('Dismiss');
  });

  it('bounds the notice list and keeps overflow scrollable', () => {
    expect(styleBlock).toMatch(/max-height:\s*34vh/);
    expect(styleBlock).toMatch(/overflow-y:\s*auto/);
  });

  // Regression (0.11.0): one full-width row per conflict, so five conflicts
  // stacked five rows across the top of the main window.
  it('collapses several conflicts into one grouped notice with a count', () => {
    const html = renderNotices(many(5));

    expect(html.match(/data-testid="conflict-parked-notices"/g)).toHaveLength(1);
    expect(html).toContain('5 conflict copies parked');
    // Collapsed by default: no per-file rows until the person opens the list.
    expect(html).not.toContain('data-testid="conflict-parked-notice"');
    expect(html).toContain('Review');
  });

  // Regression (0.11.0): the region sat in document flow above WorkShell, so it
  // pushed the shell down and painted under the macOS traffic lights.
  it('lays out as a fixed overlay below the title bar, not in document flow', () => {
    const root = ruleBody('.conflict-notices');
    expect(root).toMatch(/position:\s*fixed/);
    expect(root).toMatch(/top:\s*calc\(var\(--titlebar-height,\s*48px\)/);
    expect(root).toMatch(/right:\s*\d+px/);
    expect(root).not.toMatch(/(^|[\s;])left:/);
    expect(root).toMatch(/z-index:\s*\d+/);
  });

  // Regression (0.11.0): HqWorkWorkShell mounts the notice above WorkShell,
  // outside `.desktop-shell` where the app font and the --v4-* tokens are
  // defined, and `body` sets no font-family. Inherited text fell back to Times
  // and the --v4-* backgrounds and borders resolved to nothing.
  it('carries its own typography and only uses tokens defined at :root', () => {
    const root = ruleBody('.conflict-notices');
    expect(root).toMatch(/font-family:\s*var\(--font-sans,/);
    expect(root).toMatch(/font-size:\s*\d+px/);
    expect(styleBlock).not.toMatch(/font:\s*inherit/);
    expect(styleBlock).not.toMatch(/--v4-/);

    const designSystem = readSource('../styles/design-system.css');
    const rootTokens = new Set([...designSystem.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const unresolved = [...styleBlock.matchAll(/var\((--[a-z0-9-]+)\s*([,)])/g)]
      .filter(([, name, next]) => next === ')' && !rootTokens.has(name))
      .map(([, name]) => name);
    expect(unresolved).toEqual([]);
  });

  it('is mounted by the desktop shell', () => {
    const shell = readSource('../desktop-alt/HqWorkWorkShell.svelte');
    expect(shell).toMatch(/<ConflictParkedNotice\b/);
  });
});
