import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

// The V4 safety flows (US-012) are handled INLINE on Home rather than by
// dedicated pages: conflicts + core drift surface as NEEDS YOU cards
// (NeedsYouCard, built from home-model) whose actions are wired to the Tauri
// commands in DesktopApp. The earlier dedicated ConflictResolutionPage /
// DriftDetailPage / CoreUpdateCard / SyncHaltedCard components shipped orphaned
// (never mounted) and were removed — this spec asserts the real, mounted path.
describe('desktop-alt V4 safety flows (US-012)', () => {
  const homeModel = readRepoFile('../../packages/ui/src/home/home-model.ts');
  const needsYouCard = readRepoFile('../../packages/ui/src/home/NeedsYouCard.svelte');
  const desktopApp = readRepoFile('../../packages/ui/src/shell/DesktopApp.svelte');
  const syncModel = readRepoFile('../../packages/ui/src/common/sync-model.ts');
  const homePage = readRepoFile('../../packages/ui/src/home/HomePage.svelte');
  const driftDetail = readRepoFile('src/components/DriftDetail.svelte');

  it('conflicts surface as a NeedsYou card with keep-local / keep-remote / compare actions', () => {
    // Card model (home-model) carries the action ids + labels from the spec.
    // prettier expands these object literals across lines in @hq/ui
    expect(homeModel).toMatch(/id: ['"]keep-local['"],\s*label: ['"]Keep mine['"]/);
    expect(homeModel).toMatch(/id: ['"]keep-remote['"],\s*label: ['"]Take theirs['"]/);
    expect(homeModel).toMatch(/id: ['"]compare['"],\s*label: ['"]Compare['"]/);
    // The card is actually rendered on Home.
    expect(homePage).toContain('NeedsYouCard');
    expect(needsYouCard).toContain('data-testid="needs-you-card"');
  });

  it('conflict actions are wired to resolve_conflict (keep-local/keep-remote) + open_in_editor', () => {
    // The desktop shell owns the resolve path now. It used to rely on the
    // menubar popover, which left the Core popover's per-file Resolve controls
    // inert in the desktop window. Asserted on DesktopApp, not the popover, so
    // this stays true once the popover is deleted. The behavioural proof is
    // packages/ui/src/shell/DesktopApp.conflict-resolve.test.ts, which mounts
    // the shell and clicks the row.
    expect(desktopApp).toContain('adapter.sync.resolveConflict(path, strategy)');
    expect(desktopApp).toContain('onresolveconflict=');
    expect(desktopApp).toContain('onopenconflict=');
    expect(desktopApp).toMatch(/['"]keep-local['"]/);
    expect(desktopApp).toMatch(/['"]keep-remote['"]/);
    expect(desktopApp).toContain('adapter.shell.openInEditor(path)');
  });

  it('core drift surfaces as a NeedsYou card restored via restore_from_upstream', () => {
    expect(homeModel).toMatch(/id: ['"]restore['"]/);
    expect(homeModel).toMatch(/label: ['"]Keep edit['"]/);
    expect(homeModel).toMatch(/id: ['"]view-diff['"]/);
    expect(homeModel).toContain('drifted from v');
    expect(driftDetail).toContain("await invoke('restore_from_upstream', {");
  });

  it('a conflict aborts the sync — abort-only, with NO force / override / "sync anyway" affordance', () => {
    // Hard policy hq-sync-bulk-asymmetry-breaker-means-abort: the breaker is
    // abort-only. The sync stops and surfaces an attention item; there is no UI
    // path to force/override/continue past it.
    expect(syncModel).toContain('Sync stopped because a conflict needs attention.');
    for (const surface of [homeModel, needsYouCard, desktopApp, syncModel, homePage]) {
      // Scoped to sync-forcing phrasing: a bare /override/ matches unrelated
      // state names such as replyCountOverride and would make this vacuous.
      expect(surface).not.toMatch(
        /sync anyway|force[ -]?sync|continue anyway|override the (conflict|breaker|abort)/i,
      );
    }
  });
});
