import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * The Rust runner reports conflicts through sync:complete aggregates. The
 * deprecated sync:conflict event may never arrive, so desktop recovery must
 * never depend on per-file cards alone.
 */
describe('desktop aggregate conflict recovery', () => {
  const app = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const home = readRepoFile('src/desktop-alt/pages/HomePage.svelte');
  const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');
  const model = readRepoFile('src/desktop-alt/v4/model.ts');

  it('accumulates and resets conflict totals from sync:complete', () => {
    expect(app).toContain('let syncConflictCount = $state(0)');
    expect(app).toContain('syncConflictCount = 0');
    expect(app).toContain('syncConflictCount += event.payload.conflicts');
    expect(app).toContain("if (event.payload.conflicts > 0 || event.payload.aborted)");
  });

  it('keeps the aggregate workflow visible on Home when detailed events do not exist', () => {
    expect(app).toContain('aggregateConflictCount={syncConflictCount}');
    expect(app).toContain('aggregateConflictCompany={syncConflictCompany}');
    expect(home).toContain('getAggregateConflictCardModel');
    expect(home).toContain('onresolveaggregateconflicts');
  });

  it('routes recovery through the canonical resolve-conflicts prompt', () => {
    expect(app).toContain("kind: 'sync-conflict'");
    expect(app).toContain("openAgentWorkflow(prompt, 'conflict resolution')");
    expect(titleBar).toContain('Resolve conflicts');
    expect(titleBar).toContain("kind: 'sync-conflict'");
  });

  it('never labels Sync as the conflict action', () => {
    expect(model).toContain("action: { id: 'resolve', label: 'Resolve' }");
    expect(titleBar).toContain("model.action.id === 'resolve'");
  });
});
