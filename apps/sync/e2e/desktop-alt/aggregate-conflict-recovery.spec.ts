import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * The Rust runner reports conflicts through sync:complete aggregates. The
 * deprecated sync:conflict event may never arrive, so desktop recovery must
 * never depend on per-file cards alone.
 */
describe('desktop aggregate conflict recovery', () => {
  const app = readRepoFile('../../packages/ui/src/shell/DesktopApp.svelte');
  const home = readRepoFile('../../packages/ui/src/home/HomePage.svelte');
  const titleBar = readRepoFile('../../packages/ui/src/home/V4TitleBar.svelte');
  const model = readRepoFile('../../packages/ui/src/home/model.ts');
  const popoverApp = readRepoFile('src/App.svelte');
  const syncModel = readRepoFile('../../packages/ui/src/common/sync-model.ts');

  it('accumulates and resets conflict totals from sync:complete', () => {
    // Conflict accounting moved out of the shell into the shared sync model
    // when the desktop window adopted the @hq/ui shell; the shell now renders
    // the model's running total rather than keeping its own counter.
    expect(syncModel).toContain('conflicts: number');
    expect(syncModel).toContain('conflicts: 0');
    expect(syncModel).toMatch(/stats\.conflicts > 0/);
    // The sync:complete consumer stayed in the menubar app when the desktop
    // window adopted the @hq/ui shell; the shell renders the resulting total.
    expect(popoverApp).toContain("'sync:complete'");
    expect(popoverApp).toContain('conflicts: number');
    expect(popoverApp).toContain('event.payload.aborted');
  });

  it('keeps the aggregate workflow visible on Home when detailed events do not exist', () => {
    expect(app).toContain('conflictCount={liveSync.conflicts}');
    expect(home).toContain('getAggregateConflictCardModel');
    expect(home).toContain('onresolveaggregateconflicts');
  });

  it('routes recovery through the canonical resolve-conflicts affordance', () => {
    // The prompt-building moved with the old shell; what must not drift is
    // that the title bar offers a dedicated resolve action for the conflict
    // state rather than a bare Sync.
    expect(titleBar).toContain('Resolve conflicts');
    expect(titleBar).toMatch(/kind: ['"]sync-conflict['"]/);
    expect(titleBar).toContain('onresolveconflicts');
  });

  it('never labels Sync as the conflict action', () => {
    // @hq/ui is prettier-formatted with double quotes.
    expect(model).toMatch(/action: \{ id: ['"]resolve['"], label: ['"]Resolve['"] \}/);
  });
});
