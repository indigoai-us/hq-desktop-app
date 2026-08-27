/**
 * US-107 — Combined-app live smoke checklist (source-contract).
 * Live Results are filled by a real-machine run, not this file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd());
function readRepo(...parts: string[]): string {
  return readFileSync(resolve(repoRoot, ...parts), 'utf8');
}

describe('US-107: Single-app E2E smoke checklist on a real machine', () => {
  const smokePath = resolve(repoRoot, 'docs/hq-work-embedded-smoke.md');
  const twoAppQa = readRepo('docs/hq-work-handoff-qa.md');

  it('commits apps/sync/docs/hq-work-embedded-smoke.md', () => {
    expect(existsSync(smokePath)).toBe(true);
  });

  it('supersedes the two-app US-007 qa doc', () => {
    const smoke = readRepo('docs/hq-work-embedded-smoke.md');
    expect(smoke).toMatch(/supersedes/i);
    expect(smoke).toContain('hq-work-handoff-qa.md');
    expect(twoAppQa).toMatch(/Superseded for the combined-app embed/);
    expect(twoAppQa).toContain('hq-work-embedded-smoke.md');
  });

  it('covers combined-app scenarios (no co-install / card / second app)', () => {
    const smoke = readRepo('docs/hq-work-embedded-smoke.md');
    expect(smoke).toMatch(/Cold start/i);
    expect(smoke).toMatch(/sign-in reuse/i);
    expect(smoke).toMatch(/Notification/i);
    expect(smoke).toMatch(/widget tap/i);
    expect(smoke).toMatch(/Flag-off rollback/i);
    expect(smoke).toMatch(/Update-in-place/i);
    expect(smoke).not.toMatch(/silent co-installs from the same signed feed/);
    expect(smoke).not.toMatch(/desktop view moved/i);
  });

  it('has a live Results table that starts unexecuted', () => {
    const smoke = readRepo('docs/hq-work-embedded-smoke.md');
    expect(smoke).toContain('## Results (live machine)');
    expect(smoke).toContain('**not executed**');
  });

  it('desktop-alt entry avoids top-level await (safari13 vite target)', () => {
    const main = readRepo('src/desktop-alt/main.ts');
    expect(main).not.toMatch(/^\s*const app = await bootDesktopAltWindow/m);
    expect(main).toContain('const app = bootDesktopAltWindow(');
  });
});
