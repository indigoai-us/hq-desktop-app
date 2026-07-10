import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// DEV-1705 / feedback_bf4dede2: the menubar app never told users their hq CLI
// was stale. Detection (registry check + semver compare + events) lives in
// App + Rust. The overflow menu that hosted the notice was removed in US-001
// (chrome-free notification panel); CLI update UI relocates with settings in
// US-005. These contracts keep the backend dismiss path and App handlers live.

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const readIfExists = (p: string) => {
  try {
    return read(p);
  } catch {
    return '';
  }
};
const normalize = (s: string) => s.replace(/\s+/g, ' ');

const popover = read('src/components/Popover.svelte');
const app = read('src/App.svelte');
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

describe('CLI-update notice: removed from chrome-free popover (US-001)', () => {
  it('does not host the overflow CLI-update copy/dismiss UI in Popover', () => {
    const p = normalize(popover);
    expect(p).not.toContain('HQ_CLI_UPGRADE_CMD');
    expect(p).not.toContain('copyHqCliCommand');
    expect(p).not.toContain('hqCliCmdCopied');
    expect(p).not.toContain('ondismisshqcliupdate');
    expect(p).not.toContain('hqCliUpdateAvailable');
    expect(p).not.toContain('<code class="cli-cmd">');
  });
});

describe('CLI-update notice: App + backend dismiss path stay wired', () => {
  it('App.svelte persists the dismissal per-version then hides the state', () => {
    const a = normalize(app);
    expect(a).toContain('async function handleDismissHqCliUpdate()');
    expect(a).toContain('hqCliUpdateAvailable = null;');
    expect(a).toContain("invoke('set_hq_cli_update_dismissed', { version: latest })");
    // No longer passed into the chrome-free Popover.
    expect(a).not.toContain('ondismisshqcliupdate={handleDismissHqCliUpdate}');
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
