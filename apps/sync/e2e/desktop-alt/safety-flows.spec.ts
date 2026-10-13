import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

// The V4 safety flows (US-012) are handled INLINE on Home rather than by
// dedicated pages: core drift surfaces as a NEEDS YOU card (NeedsYouCard,
// built from home-model) whose actions are wired to the Tauri commands in
// DesktopApp. Sync conflicts have no desktop surface at all (owner decision
// 2026-10-13); e2e/desktop-alt/no-conflict-surfaces.spec.ts pins that. The
// earlier dedicated ConflictResolutionPage / DriftDetailPage / CoreUpdateCard /
// SyncHaltedCard components shipped orphaned (never mounted) and were removed —
// this spec asserts the real, mounted path.
describe('desktop-alt V4 safety flows (US-012)', () => {
  const homeModel = readRepoFile('../../packages/ui/src/home/home-model.ts');
  const needsYouCard = readRepoFile('../../packages/ui/src/home/NeedsYouCard.svelte');
  const desktopApp = readRepoFile('../../packages/ui/src/shell/DesktopApp.svelte');
  const syncModel = readRepoFile('../../packages/ui/src/common/sync-model.ts');
  const homePage = readRepoFile('../../packages/ui/src/home/HomePage.svelte');
  const driftDetail = readRepoFile('src/components/DriftDetail.svelte');

  it('core drift surfaces as a NeedsYou card restored via restore_from_upstream', () => {
    expect(homeModel).toMatch(/id: ['"]restore['"]/);
    expect(homeModel).toMatch(/label: ['"]Keep edit['"]/);
    expect(homeModel).toMatch(/id: ['"]view-diff['"]/);
    expect(homeModel).toContain('drifted from v');
    expect(driftDetail).toContain("await invoke('restore_from_upstream', {");
  });

  it('an aborted sync stops — abort-only, with NO force / override / "sync anyway" affordance', () => {
    // Hard policy hq-sync-bulk-asymmetry-breaker-means-abort: the breaker is
    // abort-only. The sync stops and surfaces an attention item; there is no UI
    // path to force/override/continue past it.
    expect(syncModel).toContain('Sync stopped before it finished.');
    for (const surface of [homeModel, needsYouCard, desktopApp, syncModel, homePage]) {
      // Scoped to sync-forcing phrasing: a bare /override/ matches unrelated
      // state names such as replyCountOverride and would make this vacuous.
      expect(surface).not.toMatch(
        /sync anyway|force[ -]?sync|continue anyway|override the (conflict|breaker|abort)/i,
      );
    }
  });
});
