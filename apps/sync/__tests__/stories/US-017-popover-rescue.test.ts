import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// US-017 (hq-desktop-v2): Popover, banners, and the conflict/drift rescue card.
//
// Source-contract assertions (same style as conflict-banner-dead-end.test.ts)
// so a dropped wire fails fast without a macOS Tauri build:
//   1. the rescue card lives in the popover status area with per-file
//      Keep local / Keep cloud + Open-in-editor, resolving through the
//      existing resolve_conflict command and clearing when empty;
//   2. the HQ core version/drift row and Desktop app version/Update row
//      render below the conflicts and route to the existing drift-detail /
//      core-restore / updater-install flows;
//   3. all four banner kinds stay routed and token-styled, and the
//      Copy-diagnose-prompt affordances on error notices are preserved.
//
// Consciously documented drop (AC allows it): there is NO "Discard" per-file
// action. The backend strategy validator
// (crates/hq-desktop-core/src/conflicts.rs VALID_STRATEGIES) accepts only
// `keep-local` / `keep-remote`; a client-side Discard would fake a resolution
// the CLI never performs. Open-in-editor is kept as the secondary affordance.

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const normalize = (s: string) => s.replace(/\s+/g, ' ');

const popover = read('src/components/Popover.svelte');
const app = read('src/App.svelte');
const modal = read('src/components/ConflictModal.svelte');
const row = read('src/components/ConflictRow.svelte');
const banner = read('src/components/BannerNotification.svelte');
const conflictsStore = read('src/stores/conflicts.ts');
const bannerRs = read('src-tauri/src/commands/banner.rs');

describe('US-017: conflict rescue card', () => {
  it('renders the rescue card in the popover status area, gated on live conflicts', () => {
    const p = normalize(popover);
    // The card mounts only while the modal state is active AND conflicts exist,
    // so it clears when the list empties.
    expect(p).toContain('const conflictModalActive = $derived(showConflictModal && conflicts.length > 0)');
    expect(popover).toContain('data-testid="popover-rescue-card"');
    // The rescue card renders BEFORE the Messages row (status area, not the
    // notification feed).
    expect(popover.indexOf('popover-rescue-card')).toBeLessThan(
      popover.indexOf('popover-open-messages'),
    );
  });

  it('headers the card as "N conflicts need you"', () => {
    expect(modal).toContain('data-testid="rescue-card-header"');
    const m = normalize(modal);
    expect(m).toContain("conflict{headerCount === 1 ? '' : 's'} need{headerCount === 1 ? 's' : ''} you");
  });

  it('per-file rows show filename + company path with Keep local / Keep cloud plus Open-in-editor', () => {
    expect(row).toContain('data-testid="conflict-row-path"');
    expect(row).toContain('Keep local');
    expect(row).toContain('Keep cloud');
    // Secondary affordance retained.
    expect(row).toContain('Open in editor');
    // Actions route through the existing strategies (the resolve_conflict
    // command validates exactly these).
    expect(row).toContain("'keep-local'");
    expect(row).toContain("'keep-remote'");
  });

  it('documents the conscious drop of the Discard affordance', () => {
    expect(row).toContain('CONSCIOUSLY DROPPED');
    expect(row).toContain('VALID_STRATEGIES');
  });

  it('resolution rides the existing resolve_conflict + open_in_editor commands', () => {
    expect(conflictsStore).toContain("invoke('resolve_conflict', { path, strategy })");
    expect(conflictsStore).toContain("invoke('open_in_editor', { path })");
  });
});

describe('US-017: HQ core drift + desktop app update rows', () => {
  it('popover renders both version rows with drift pill and update action', () => {
    expect(popover).toContain('data-testid="popover-core-row"');
    expect(popover).toContain('data-testid="popover-app-row"');
    expect(popover).toContain('data-testid="popover-drift-count"');
    expect(popover).toContain('data-testid="popover-no-drift"');
    expect(popover).toContain('data-testid="popover-core-restore"');
    expect(popover).toContain('data-testid="popover-app-update"');
    const p = normalize(popover);
    expect(p).toContain('{coreDriftCount} drifted');
    expect(p).toContain('No drift');
  });

  it('drift count opens the drift detail flow; Restore runs the core rescue', () => {
    const a = normalize(app);
    // Drift pill → open_drift_detail with the live report.
    expect(a).toContain("await invoke('open_drift_detail', { report: coreState.driftReport })");
    expect(a).toContain('onopendrift={handleOpenDriftDetail}');
    // Restore → the existing unified rescue dispatcher.
    expect(a).toContain('oninstallcore={handleInstallCore}');
    expect(app).toContain("'install_hq_core_update'");
    expect(app).toContain("'run_replace_from_staging'");
    // Drift count + needs-update derive from the unified core state.
    expect(a).toContain('coreDriftCount={coreState?.driftReport.count ?? 0}');
  });

  it('the app Update button rides the existing updater install flow', () => {
    const p = normalize(popover);
    expect(p).toContain('data-testid="popover-app-update"');
    const a = normalize(app);
    expect(a).toContain('oninstallupdate={handleInstallUpdate}');
  });
});

describe('US-017: banners on V2 tokens, four kinds, diagnose prompts preserved', () => {
  it('all four banner kinds are emitted by the backend', () => {
    expect(bannerRs).toContain('kind: "dm".to_string()');
    expect(bannerRs).toContain('kind: "share".to_string()');
    expect(bannerRs).toContain('kind: "meeting".to_string()');
    expect(bannerRs).toContain('kind: "update".to_string()');
    // Dev previews stay available for visual QA.
    expect(bannerRs).toContain('preview_dm_banner');
    expect(bannerRs).toContain('preview_share_banner');
    expect(bannerRs).toContain('preview_update_banner');
  });

  it('the banner surface is styled on the shared V2 token layer', () => {
    // The banner imports the canonical token sheet and uses tokenized colors
    // (no hard-coded brand colors on text/surfaces).
    expect(banner).toContain("import '../styles/popover.css'");
    expect(banner).toContain('var(--popover-bg)');
    expect(banner).toContain('var(--popover-text)');
    expect(banner).toContain('data-kind={payload.kind}');
  });

  it('App routes every banner kind action (open / copy / record / update)', () => {
    expect(app).toContain("if (action === 'copy')");
    expect(app).toContain("if (action === 'record' && windowId)");
    expect(app).toContain("if (action === 'update')");
    expect(app).toContain("if (action === 'open')");
  });

  it('Copy-diagnose-prompt actions on error notices are preserved', () => {
    expect(popover).toContain('Copy diagnose prompt');
    expect(popover).toContain('Copy fix prompt');
    expect(popover).toContain("kind: 'cloud-unreachable'");
    expect(popover).toContain("kind: 'manifest-error'");
    expect(popover).toContain("kind: 'sync-failed'");
  });
});
