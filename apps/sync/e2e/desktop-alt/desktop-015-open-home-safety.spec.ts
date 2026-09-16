import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? '';
}

describe('DESKTOP-015: open Home hierarchy and safe-delete visibility', () => {
  const app = readRepoFile('../../packages/ui/src/shell/DesktopApp.svelte');
  const home = readRepoFile('../../packages/ui/src/home/HomePage.svelte');

  /**
   * KNOWN GAP, pre-existing and NOT introduced by the Sessions removal.
   *
   * Home still RENDERS the safe-delete notices, but nothing produces them:
   * the only `sync:delete-refused-stale-etag` listener lived in the
   * desktop-alt DesktopApp.svelte tree, which had been unreachable for some
   * time and went with the removal, and nothing passes `deleteRefusals` into
   * HomePage. So a delete refused to protect a newer remote copy is currently
   * invisible to the user.
   *
   * The render half is asserted below so the surface cannot be deleted while
   * that is fixed. The producer half is not re-pointed at code that does not
   * exist — that would assert nothing. Filed separately.
   */
  it('still renders the delete-refusal surface on Home', () => {
    expect(home).toContain('getDeleteRefusalCopy');
    expect(home).toContain('data-testid="home-safe-delete-notices"');
    expect(home).toContain('deleteRefusals');
  });

  it('renders safety notices as open rows rather than another box', () => {
    const list = rule(home, '.home-safety-notices');
    expect(list).toContain('border: 0');
    expect(list).toContain('background: transparent');
    expect(list).toContain('border-top: 1px solid var(--v4-rowline)');
  });

  it('opens the Home stats, portfolio, agenda, empty, and loading structures', () => {
    for (const selector of [
      '.home-stats',
      '.home-table',
      '.home-agenda',
      '.home-empty',
      '.home-skeleton',
    ]) {
      const block = rule(home, selector);
      expect(block, `${selector} should exist`).not.toBe('');
      expect(block, `${selector} retains a closed perimeter`).toContain('border: 0');
      expect(block, `${selector} retains a raised fill`).toContain('background: transparent');
      expect(block, `${selector} retains structural rounding`).toContain('border-radius: 0');
    }
  });
});
