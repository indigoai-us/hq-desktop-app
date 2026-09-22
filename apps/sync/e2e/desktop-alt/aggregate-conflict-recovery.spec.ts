import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * The Rust runner reports conflicts two ways: a per-file sync:conflict event
 * per conflicted path, and the sync:complete aggregate. The aggregate is the
 * one that always arrives (an older runner, or a conflict the engine reports
 * only in the count), so desktop recovery must never depend on per-file cards
 * alone — while the per-file path must stay wired for the rows that can be
 * resolved individually.
 */
describe('desktop aggregate conflict recovery', () => {
  const app = readRepoFile('../../packages/ui/src/shell/DesktopApp.svelte');
  const home = readRepoFile('../../packages/ui/src/home/HomePage.svelte');
  const titleBar = readRepoFile('../../packages/ui/src/home/V4TitleBar.svelte');
  const model = readRepoFile('../../packages/ui/src/home/model.ts');
  const popoverApp = readRepoFile('src/App.svelte');
  const syncModel = readRepoFile('../../packages/ui/src/common/sync-model.ts');
  const events = readRepoFile('../../crates/hq-desktop-core/src/events.rs');
  const syncCommands = readRepoFile('src-tauri/src/commands/sync.rs');
  const daemonCommands = readRepoFile('src-tauri/src/commands/daemon.rs');

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

  it('forwards the runner per-file conflict event the shell rows read', () => {
    // The shell lists a conflicted path only if Rust re-emits the runner's
    // `conflict` ndjson line as `sync:conflict`. Both consumers forward it —
    // manual "Sync Now" and the watch daemon, which is where most conflicts
    // actually arrive. Dropping either wire empties the rows again.
    expect(events).toContain('Conflict(SyncConflictEvent)');
    expect(syncCommands).toContain(
      'SyncEvent::Conflict(payload) => app.emit(EVENT_SYNC_CONFLICT, payload.clone())',
    );
    expect(daemonCommands).toContain('app.emit(EVENT_SYNC_CONFLICT, payload.clone())');
    // The shell keys rows off `path` and reads `canAutoResolve`, so the
    // payload must serialize camelCase (`#[serde(rename_all = "camelCase")]`
    // on the struct turns `can_auto_resolve` into the key the shell reads).
    expect(events).toContain('pub can_auto_resolve: bool');
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
