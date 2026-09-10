import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// hq-idea-board / US-001 — capture latency benchmark and E2E harness.
// Story-level contract: the deliverables exist and the suite is wired into
// `pnpm test` at the repo root, so every later capture-path story runs it.
const appRoot = resolve(__dirname, '../..');
const repoRoot = resolve(appRoot, '../..');

describe('hq-idea-board US-001: benchmark + E2E harness wiring', () => {
  it('ships the benchmark script and the idea-board vitest suite', () => {
    expect(existsSync(resolve(appRoot, 'scripts/idea-board-bench.mjs'))).toBe(true);
    expect(existsSync(resolve(appRoot, 'e2e/idea-board/vitest.config.ts'))).toBe(true);
    expect(existsSync(resolve(appRoot, 'e2e/idea-board/smoke.spec.ts'))).toBe(true);
  });

  it('encodes the latency budgets as the acceptance gate', async () => {
    const bench = await import('../../scripts/idea-board-bench.mjs');
    expect(bench.BUDGET_MS).toEqual({ chordToOverlay: 80, releaseToPng: 120 });
  });

  it('is included in `pnpm test` at the repo root', () => {
    const root = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
    const app = JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf8'));
    expect(app.scripts['test:e2e:idea-board']).toBe('vitest run --config e2e/idea-board/vitest.config.ts');
    expect(root.scripts.test).toContain('turbo run test');
    expect(root.scripts.test).toContain('test:e2e:idea-board');
  });

  it('records bench results beside the suite for later stories to diff', () => {
    const results = JSON.parse(readFileSync(resolve(appRoot, 'e2e/idea-board/bench-results.json'), 'utf8'));
    expect(results.budgets).toEqual({ chordToOverlay: 80, releaseToPng: 120 });
    for (const key of ['chordToOverlay', 'releaseToPng']) {
      expect(results[key]).toEqual(expect.objectContaining({ samples: expect.any(Number), budgetMs: expect.any(Number) }));
    }
    expect(typeof results.pass).toBe('boolean');
  });
});
