import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-010 — Project status writes (local persist + optimistic UI).
 *
 * Source-contract style (matching the desktop-alt harness): assert that the
 * status dropdown is now WRITABLE — selecting a status calls the projects-store
 * write with optimistic-paint + rollback, the store invokes the registered Rust
 * write command, and the new command is registered + capability-allowed.
 */

describe('desktop-alt project status write — store contract (US-010)', () => {
  const store = readRepoFile('src/desktop-alt/lib/projects-store.svelte.ts');
  const adapter = readRepoFile('src/desktop-alt/lib/local-projects.ts');

  it('the store invokes the registered Rust write commands', () => {
    // The adapter is the single place that calls the Tauri write commands, with
    // the camelCased args Tauri v2 exposes.
    expect(adapter).toContain(
      "invoke('set_local_project_status', { boardPath, projectId, prdPath, status })",
    );
    expect(adapter).toContain("invoke('set_local_story_passes', { prdPath, storyId, passes })");
    // The store routes status writes through that adapter.
    expect(store).toContain('saveLocalProjectStatus');
  });

  it('applies the change optimistically and rolls back on failure', () => {
    // Optimistic: the overlay is set to `next` BEFORE awaiting the write.
    expect(store).toContain('statusOverride.set(key, next)');
    // The write is awaited after the optimistic set.
    const optimisticIdx = store.indexOf('statusOverride.set(key, next)');
    const awaitIdx = store.indexOf('await saveLocalProjectStatus');
    expect(optimisticIdx).toBeGreaterThan(-1);
    expect(awaitIdx).toBeGreaterThan(optimisticIdx);
    // Rollback: on catch, the overlay is restored to the last status that
    // reached disk and a clear user-facing error is returned.
    expect(store).toContain('statusOverride.set(key, rollbackStatus)');
    expect(store).toContain('Could not save the status change');
    // Same-identity writes are serialized and expose pending state so navigating
    // away and back cannot launch an overlapping stale write.
    expect(store).toContain('statusWriteTail.get(boardPath)');
    expect(store).toContain('statusPending(project');
    expect(store).toContain('let statusStateVersion = $state(0)');
    expect(store).toContain('void statusStateVersion');
    // Board path is derived from companies/<company>/board.json.
    expect(store).toContain('companies/${company}/board.json');
  });

  it('exposes the story-passes optimistic toggle too', () => {
    expect(store).toContain('export async function setStoryPasses');
    expect(store).toContain('passesOverride.set(key, next)');
    expect(store).toContain('passesOverride.set(key, previous)');
  });
});

describe('desktop-alt status dropdown wires onStatusChange → write (US-010)', () => {
  const detail = readRepoFile('src/desktop-alt/pages/ProjectDetailView.svelte');
  // The detail view's status writes are hosted by the per-company board panel
  // (US-011) now that the top-level BoardPage is gone.
  const board = readRepoFile('src/desktop-alt/panels/CompanyBoardPanel.svelte');
  const goals = readRepoFile('src/desktop-alt/pages/CompanyGoalsPage.svelte');

  it('selecting a status calls the store write through an onclick handler', () => {
    // The dropdown options now call selectStatus (was a no-op menu-close in 009).
    expect(detail).toContain('onclick={() => selectStatus(status)}');
    expect(detail).toContain('async function selectStatus');
    expect(detail).toContain(
      "import { projectsStore, setProjectStatus } from '../lib/projects-store.svelte'",
    );
    expect(detail).toContain('await setProjectStatus(');
  });

  it('paints optimistically and rolls back the rendered status on failure', () => {
    // Local override drives the rendered status (optimistic), defaulting to the
    // raw project status.
    expect(detail).toContain('statusOverride ?? toEditableStatus(project.status)');
    // Optimistic set before await; store rehydration + error surface on failure.
    expect(detail).toContain('statusOverride = next');
    expect(detail).toContain('projectsStore.statusOverride(project)');
    expect(detail).toContain('projectsStore.statusPending(project)');
    expect(detail).toContain('statusError = result.error');
    expect(detail).toContain('data-testid="status-error"');
  });

  it('notifies the board via onStatusChange so the list row refreshes', () => {
    expect(detail).toContain('const mutationIdentity = projectIdentity(project)');
    expect(detail).toContain('rehydrateCurrentStatus(mutationIdentity)');
    expect(detail).toContain('onStatusChange?.(mutationIdentity, next)');
    expect(board).toContain('onStatusChange={onProjectStatusChange}');
    expect(board).toContain('function onProjectStatusChange');
    expect(board).toContain('withProjectStatus(selected, changedIdentity, status)');
  });

  it('uses the same composite identity on the Goals linked-project surface', () => {
    expect(goals).toContain(
      'function onProjectStatusChange(changedIdentity: string, status: string)',
    );
    expect(goals).toContain(
      'selected = withProjectStatus(selected, changedIdentity, status)',
    );
    expect(goals).toContain(
      'withProjectStatus(project, changedIdentity, status)',
    );
    expect(goals).not.toContain('selected.id === projectId');
  });
});

describe('desktop-alt status write — registration + capability (US-010)', () => {
  it('registers the write commands in main.rs', () => {
    const main = readRepoFile('src-tauri/src/main.rs');
    expect(main).toContain('commands::projects_local::set_local_project_status');
    expect(main).toContain('commands::projects_local::set_local_story_passes');
  });

  it('documents the write commands in the desktop-alt capability', () => {
    const cap = readRepoFile('src-tauri/capabilities/desktop-alt.json');
    expect(cap).toContain('set_local_project_status');
    expect(cap).toContain('set_local_story_passes');
  });

  it('the Rust write command guards membership + canonical path + atomic write', () => {
    const rust = readRepoFile('src-tauri/src/commands/projects_local.rs');
    const core = readRepoFile('../../crates/hq-desktop-core/src/projects_local.rs');
    const scopedFs = readRepoFile('../../crates/hq-desktop-core/src/desktop_alt.rs');
    // The command wrapper enforces the signed-in gate, hydrates live workspace
    // membership, and authorizes the canonical company target before delegating.
    expect(rust).toContain('pub async fn set_local_project_status');
    expect(rust).toContain('desktop_features_enabled().await');
    expect(rust).toContain('hydrated_project_context().await');
    expect(rust).toContain('authorize_project_target(');
    expect(rust).toContain('prd_path.as_deref()');
    expect(core).toContain('normalize_project_identity_path');
    // Strict HQ-relative + canonical company guards, no-symlink write targets,
    // sink-adjacent revalidation, and a linearizable atomic exchange all live
    // in the core library with focused regressions.
    expect(core).toContain('resolve_project_write_path');
    expect(core).toContain('reject_project_write_symlinks');
    expect(core).toContain('require_same_project_write_target');
    expect(core).toContain('expected_filename');
    expect(core).toContain('fn commit_json_mutation_with_exchange');
    expect(core).toContain('fn prepare_atomic_json_write');
    expect(core).toContain('fn atomic_exchange_file');
    expect(core).toContain('.exchange_files(&self.temp_name, &target.target_name)');
    expect(scopedFs).toContain('rustix::fs::renameat_with');
    expect(scopedFs).toContain('RenameFlags::EXCHANGE');
    expect(scopedFs).toContain('self.descriptor.as_ref()');
    expect(core).toContain('ReplaceFileW(');
    expect(core).toContain('DisplacedAtomicJsonWrite::capture');
    expect(core).toContain('OFlags::NOFOLLOW');
    expect(scopedFs).toContain('FILE_FLAG_OPEN_REPARSE_POINT');
    expect(scopedFs).toContain('FILE_OPEN_REPARSE_POINT');
    expect(scopedFs).toContain('NtCreateFile(');
    expect(core).toContain('file.write_all(&serialized).and_then(|()| file.sync_all())');
    expect(core).not.toContain('std::fs::rename(&tmp_path, target)');
  });
});
