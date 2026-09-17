import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// DEV-1705 / feedback_bf4dede2: the menubar app never told users their hq CLI
// was stale. Detection (registry check + semver compare + events) lives in
// Rust. The overflow menu that hosted the notice was removed in US-001
// (chrome-free notification panel), and PL-07 deleted the tray popover and the
// tray window's copy of the CLI-update state along with it. The whole CLI
// update surface — check, install, dismiss — is the desktop window's
// Settings → Updates pane (packages/ui/src/settings/SettingsPage.svelte).
// These contracts keep the backend dismiss path live underneath it.

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const readIfExists = (p: string) => {
  try {
    return read(p);
  } catch {
    return '';
  }
};
const normalize = (s: string) => s.replace(/\s+/g, ' ');

const app = read('src/App.svelte');
const settingsPage = read('../../packages/ui/src/settings/SettingsPage.svelte');
const syncAdapter = read('../../packages/platform/src/tauri/sync-adapter.ts');
const hqCliUpdate =
  readIfExists('src-tauri/src/commands/hq_cli_update.rs') +
  '\n' +
  readIfExists('../../crates/hq-desktop-core/src/hq_cli_update.rs').replace(
    'pub fn suppress_for_dismissal(latest: &str, dismissed: Option<&str>) -> bool',
    'pub(crate) fn suppress_for_dismissal(latest: &str, dismissed: Option<&str>) -> bool',
  ) +
  '\n' +
  readIfExists('../../crates/hq-desktop-core/src/first_run.rs');
const mainRs = read('src-tauri/src/main.rs');
const fixtures = read('dev-harness/fixtures.ts');

describe('CLI-update notice: the desktop Settings pane owns the surface', () => {
  it('Settings → Updates checks, installs and dismisses the CLI update', () => {
    const settings = normalize(settingsPage);
    expect(settings).toContain('async function handleDismissHqCliUpdate()');
    expect(settings).toContain('adapter.updates.dismissCliUpdate()');
    expect(settings).toContain('hqCliUpdateErrorContext = "dismiss"');
    // ...and the adapter it calls is the one that reaches the Rust command.
    expect(normalize(syncAdapter)).toContain("call('set_hq_cli_update_dismissed', { version })");
  });

  it('the tray window keeps no second copy of the CLI-update state', () => {
    // PL-07: nothing in `main` renders it, so holding the state there would be
    // a silent duplicate of what Settings already owns.
    expect(app).not.toContain('hqCliUpdateAvailable');
    expect(app).not.toContain('set_hq_cli_update_dismissed');
  });
});

describe('CLI-update notice: backend dismissal + per-version reset', () => {
  it('persists the dismissal through the untyped-merge path (survives save_settings)', () => {
    const r = normalize(hqCliUpdate);
    expect(r).toContain('pub fn set_hq_cli_update_dismissed(version: String)');
    expect(r).toContain('const DISMISSED_VERSION_KEY: &str = "cliUpdateDismissedVersion";');
    expect(r).toContain('crate::commands::first_run::merge_menubar_flags(');
  });

  it('suppresses the banner for the dismissed (or older) version, re-shows on a newer one', () => {
    const r = normalize(hqCliUpdate);
    expect(r).toContain(
      "pub(crate) fn suppress_for_dismissal(latest: &str, dismissed: Option<&str>) -> bool",
    );
    expect(r).toContain('cmp_semver(latest, d) != std::cmp::Ordering::Greater');
    expect(r).toContain('if is_cli_update_dismissed(&info.latest)');
    expect(r).toContain('result.filter(|info| !is_cli_update_dismissed(&info.latest))');
  });

  it('registers the dismiss command in main.rs', () => {
    expect(normalize(mainRs)).toContain(
      'commands::hq_cli_update::set_hq_cli_update_dismissed',
    );
  });
});

describe('CLI-update notice: fixture retained for future desktop surface', () => {
  it('exposes a stale-CLI fixture object for harness/reference', () => {
    expect(normalize(fixtures)).toContain('export const hqCliUpdateAvailable = {');
  });
});
