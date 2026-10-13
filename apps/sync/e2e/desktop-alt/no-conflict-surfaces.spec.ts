import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * Owner decision, 2026-10-13: a sync conflict has no desktop surface at all.
 * hq-cloud parks the losing copy under `.hq/conflict-backups/` and keeps the
 * cloud copy live; the desktop app does not tell the user about it. No macOS
 * notification, no toast, no Review list, no badge, no tray state, no Core
 * popover card, no Home card, no title-bar "Resolve conflicts".
 *
 * The behavioral proof is packages/ui/src/shell/DesktopApp.no-conflict-surface.test.ts,
 * which mounts the shell, delivers a conflict both ways the runner reports one,
 * and finds nothing on screen. This spec pins the wiring so a surface cannot
 * come back through a path that test does not mount (the HQ Work shell, the
 * tray, the OS notification).
 */
// Same root the harness reads from (the spec runs from apps/sync).
const repoRoot = process.cwd();

describe('no conflict surfaces in the desktop app', () => {
  const workShell = readRepoFile('src/desktop-alt/HqWorkWorkShell.svelte');
  const popoverApp = readRepoFile('src/App.svelte');
  const passWatch = readRepoFile('src-tauri/src/commands/sync_progress_watch.rs');
  const daemonHost = readRepoFile('src-tauri/src/commands/hq_daemon_host.rs');
  const daemonCommands = readRepoFile('src-tauri/src/commands/daemon.rs');
  const syncCommands = readRepoFile('src-tauri/src/commands/sync.rs');
  const tray = readRepoFile('src-tauri/src/tray.rs');
  const mainRs = readRepoFile('src-tauri/src/main.rs');
  const coreLib = readRepoFile('../../crates/hq-desktop-core/src/lib.rs');
  const coreEvents = readRepoFile('../../crates/hq-desktop-core/src/events.rs');
  const desktopApp = readRepoFile('../../packages/ui/src/shell/DesktopApp.svelte');
  const titleBar = readRepoFile('../../packages/ui/src/home/V4TitleBar.svelte');
  const corePopover = readRepoFile('../../packages/ui/src/home/CorePopover.svelte');
  const homePage = readRepoFile('../../packages/ui/src/home/HomePage.svelte');
  const syncStatus = readRepoFile('../../packages/ui/src/home/sync-status.ts');
  const syncToast = readRepoFile('../../packages/ui/src/shell/sync-toast.ts');

  it('posts no OS notification and sends no parked-copy list to the window', () => {
    expect(passWatch).not.toContain('notify_new_conflict_batch');
    expect(passWatch).not.toContain('sync:conflict-notices');
    expect(daemonHost).not.toContain('fn notify_new_conflict_batch');
    expect(coreLib).not.toMatch(/pub mod conflict_notify\b/);
    expect(existsSync(join(repoRoot, '../../crates/hq-desktop-core/src/conflict_notify.rs'))).toBe(
      false,
    );
  });

  it('registers no conflict-notice commands', () => {
    for (const command of [
      'get_pending_conflict_notices',
      'acknowledge_conflict_notice',
      'show_conflict_backup',
    ]) {
      expect(mainRs, command).not.toContain(command);
      expect(daemonHost, command).not.toContain(`fn ${command}`);
    }
  });

  it('has no parked-copy toast or Review list in the HQ Work shell', () => {
    expect(workShell).not.toContain('ConflictParkedNotice');
    expect(workShell).not.toContain('sync:conflict-notices');
    expect(workShell).not.toContain('get_pending_conflict_notices');
    expect(existsSync(join(repoRoot, 'src/components/ConflictParkedNotice.svelte'))).toBe(false);
    expect(existsSync(join(repoRoot, 'src/lib/conflictNotices.ts'))).toBe(false);
  });

  it('never forwards a per-file conflict line to the window', () => {
    // The runner still writes `conflict` ndjson lines; Rust drops them so no
    // window can turn one into a surface.
    expect(coreEvents).not.toContain('EVENT_SYNC_CONFLICT');
    expect(daemonCommands).not.toContain('EVENT_SYNC_CONFLICT');
    expect(syncCommands).not.toContain('EVENT_SYNC_CONFLICT');
    expect(desktopApp).not.toContain('"sync:conflict"');
    expect(syncStatus).not.toContain('"sync:conflict"');
  });

  it('has no conflict tray state', () => {
    expect(tray).not.toContain('TrayState::Conflict');
    expect(tray).not.toContain('tray-conflict');
    expect(popoverApp).not.toContain("state: 'conflict'");
  });

  it('renders no conflict card, badge, toast or resolve action in the shell', () => {
    expect(corePopover).not.toContain('core-popover-rescue-card');
    expect(corePopover).not.toContain('ResolveConflictsDoor');
    expect(titleBar).not.toContain('Resolve conflicts');
    expect(titleBar).not.toContain('sync-conflict');
    expect(homePage).not.toContain('getConflictCardModel');
    expect(homePage).not.toContain('getAggregateConflictCardModel');
    expect(syncToast).not.toContain('Sync needs a decision');
    expect(desktopApp).not.toContain('resolveConflictFile');
  });
});
