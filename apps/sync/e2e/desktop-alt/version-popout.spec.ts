import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-017 — version + updates live in the title bar, not a bottom status bar.
 *
 * Rewritten when the in-app Sessions subsystem removed the unreachable
 * desktop-alt tree. The surface this used to assert — `VersionPopout`, with
 * its own test-ids, `top: 48px`, `z-index: 10000` — is not what ships: the
 * title bar renders `CorePopover`, and the @hq/ui `VersionPopout` is an
 * orphan nothing mounts. The old file asserted that orphan's internals in
 * detail, which is coverage of a component no user can reach.
 *
 * What survives here is the CAPABILITY the story was about, asserted against
 * the component that actually renders it: app and Core versions visible from
 * the title bar, a check-for-updates action, an install action, and the Core
 * drift/restore affordance. Structural details (exact offsets, z-index) are
 * deliberately not re-asserted — they pinned one component's layout, not a
 * user-visible contract, and re-creating them against a different component
 * would be inventing a requirement rather than guarding one.
 */
describe('version and updates surface (US-017)', () => {
  const titleBar = readRepoFile('../../packages/ui/src/home/V4TitleBar.svelte');
  const popover = readRepoFile('../../packages/ui/src/home/CorePopover.svelte');
  const shell = readRepoFile('../../packages/ui/src/shell/DesktopApp.svelte');

  it('lives in the title bar and did not restore the bottom status bar', () => {
    expect(shell).not.toContain('<DesktopStatusBar');
    expect(titleBar).toContain('import CorePopover from "./CorePopover.svelte"');
    expect(titleBar).toContain('coreOpen');
    expect(titleBar).toContain('aria-expanded');
  });

  it('shows both the app version and the HQ core version', () => {
    expect(popover).toContain('data-testid="core-popover"');
    expect(popover).toContain('data-testid="core-popover-app-row"');
    expect(popover).toContain('data-testid="core-popover-core-row"');
  });

  it('offers an update check and an install action for each', () => {
    expect(popover).toContain('data-testid="core-popover-check-updates"');
    expect(popover).toContain('data-testid="core-popover-download-install"');
    expect(popover).toContain('data-testid="core-popover-core-check"');
  });

  it('surfaces Core drift with a restore affordance', () => {
    expect(popover).toContain('data-testid="core-popover-drift-count"');
    expect(popover).toContain('data-testid="core-popover-core-restore"');
    expect(popover).toContain('Restore');
  });

  it('keeps the conflict rescue path on the same surface', () => {
    // A conflict must remain reachable from the chrome rather than only from
    // Home — this is the rescue route when the board is not in front of you.
    expect(popover).toContain('data-testid="core-popover-conflict-row"');
    expect(popover).toContain('data-testid="core-popover-keep-local"');
    expect(popover).toContain('data-testid="core-popover-keep-cloud"');
  });
});
