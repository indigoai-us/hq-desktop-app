import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? '';
}

describe('DESKTOP-015: open Home hierarchy and safe-delete visibility', () => {
  const app = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const home = readRepoFile('src/desktop-alt/pages/HomePage.svelte');

  it('surfaces currency-gated delete refusals persistently on Home', () => {
    expect(app).toContain("listen<{");
    expect(app).toContain("'sync:delete-refused-stale-etag'");
    expect(app).toContain('syncDeleteRefusals');
    expect(app).toContain('deleteRefusals={syncDeleteRefusals}');
    expect(home).toContain('getDeleteRefusalCopy');
    expect(home).toContain('data-testid="home-safe-delete-notices"');
  });

  it('renders safety notices as open rows rather than another box', () => {
    const list = rule(home, '.home-safety-notices');
    expect(list).toContain('border: 0');
    expect(list).toContain('background: transparent');
    expect(list).toContain('border-top: 1px solid var(--v4-rowline)');
  });

  it('opens the Home stats, portfolio, and loading structures', () => {
    // Home currently ships stats / portfolio table / skeleton (no separate
    // agenda or empty card classes in the stylesheet).
    for (const selector of ['.home-stats', '.home-table', '.home-skeleton']) {
      const block = rule(home, selector);
      expect(block, `${selector} should exist`).not.toBe('');
      expect(block, `${selector} retains a closed perimeter`).toContain('border: 0');
      expect(block, `${selector} retains a raised fill`).toContain('background: transparent');
      expect(block, `${selector} retains structural rounding`).toContain('border-radius: 0');
    }
  });
});
