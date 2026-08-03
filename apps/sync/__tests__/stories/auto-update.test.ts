import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source-contract assertions for the master "Automatic updates" switch
// (`autoUpdate` pref, default ON): one Settings toggle that silently installs
// the menubar app, the hq CLI, and hq-core without asking. These lock the
// wiring so a dropped gate fails fast without a macOS Tauri build.
//
// The toggle lives in the desktop-view SettingsPage (the popover
// Settings.svelte was retired in US-005 — desktop settings is the canonical
// surface).

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const normalize = (s: string) => s.replace(/\s+/g, ' ');

const app = read('src/App.svelte');
const settings = read('src/desktop-alt/pages/SettingsPage.svelte');
const appUpdater = read('src-tauri/src/updater.rs');
const cliUpdate = read('src-tauri/src/commands/hq_cli_update.rs');
const cliUpdateCore = read('../../crates/hq-desktop-core/src/hq_cli_update.rs');
const settingsRs = read('src-tauri/src/commands/settings.rs');

describe('master automatic-updates switch', () => {
  it('desktop SettingsPage exposes a single "Automatic updates" toggle and drops the CLI-only one', () => {
    const s = normalize(settings);
    expect(s).toContain('id="toggle-auto-update"');
    expect(s).toContain('Automatic updates');
    expect(s).toContain('bind:checked={autoUpdate}');
    // The standalone per-CLI toggle is folded into the master.
    expect(settings).not.toContain('id="toggle-cli-auto-update"');
    expect(settings).not.toContain('handleToggleCliAutoUpdate');
    expect(settings).not.toContain('bind:checked={cliAutoUpdate}');
    // The pref round-trips as a minimal patch through the shared serialized
    // settings helper, so it cannot overwrite Widget/titlebar changes.
    expect(s).toContain('autoUpdate = settings.autoUpdate ?? true');
    expect(settings).toContain(
      "import { updateSettings, type SettingsPatch } from '../../lib/settings-mutations'",
    );
    expect(s).toContain("persistSettingsControl('auto-update', { autoUpdate })");
    expect(s).toContain("disabled={isSettingsControlPending('auto-update')}");
    expect(s).toContain("aria-busy={isSettingsControlPending('auto-update')}");
  });

  it('native Rust installs app updates without depending on a mounted WebView', () => {
    expect(appUpdater).toContain(
      'hq_desktop_core::hq_cli_update::auto_update_enabled()',
    );
    expect(appUpdater).toContain('BackgroundUpdateAction::Install');
    expect(appUpdater).toContain('download_and_install');
    expect(appUpdater).toContain('BackgroundUpdateAction::DeferForSync');
    expect(appUpdater).toContain('UPDATE_SYNC_RETRY_INTERVAL');
    expect(appUpdater).toContain('automatic install failed — offering manual recovery');
    expect(appUpdater).toContain('record_and_announce_update');
    expect(appUpdater).toContain('UpdateAnnouncement::PersistentOnly');
    expect(appUpdater).toContain('UpdateAnnouncement::TransientBanner');
    expect(appUpdater).toContain('should_raise_transient_update_surface');
  });

  it('Windows never installs updates silently in the background (2026-08-02 field failure)', () => {
    // NSIS cannot overwrite files held open by the running app/sidecar, so a
    // silent background install on Windows can destroy the installation.
    // Background discovery must route through the platform gate and Windows
    // must announce instead of install.
    expect(appUpdater).toContain('fn silent_install_supported()');
    expect(appUpdater).toContain('!cfg!(target_os = "windows")');
    expect(appUpdater).toContain('silent_install_supported(),');
    expect(appUpdater).toContain(
      'match (automatic_updates && silent_install_supported, sync_in_progress)',
    );
  });

  it('App keeps the shared preference hydrated for Core updates', () => {
    const a = normalize(app);
    // Reads the pref (default on) + refreshes it on focus.
    expect(a).toContain('async function loadAutoUpdatePref()');
    expect(a).toContain('autoUpdate = s?.autoUpdate ?? true');
    expect(a).not.toContain('autoAppUpdatedVersion');
    // Core update effect: only on a genuine version bump for eligible users,
    // deduped by target version, deferred while syncing.
    expect(a).toContain('if (!s || !s.isEligible || !s.versionBehind) return;');
    expect(a).toContain('if (autoCoreUpdatedVersion === s.targetVersion) return;');
    expect(a).toContain('void handleInstallCore();');
    expect(app).toContain("if (syncState === 'syncing') return;");
  });

  it('the CLI background auto-installer gates on the master switch', () => {
    // The Rust CLI checker now installs when the master `autoUpdate` is on
    // (default), superseding the old `cliAutoUpdate`-only gate.
    expect(cliUpdate).toContain('if auto_update_enabled() {');
    expect(cliUpdate).toContain('auto_update_enabled');
    // The pref defaults ON in both get_settings branches.
    expect(settingsRs).toContain('auto_update: Some(true)');
    expect(settingsRs).toContain('auto_update: Some(prefs.auto_update.unwrap_or(true))');
  });

  it('the CLI auto-installer cannot loop on an install that never converges', () => {
    // A prod app spent weeks reinstalling the same CLI version on every launch
    // and every 6h check: npm exited 0 into a prefix nothing read, so the
    // detected version never moved and `update_available` stayed true forever.
    // Three source contracts keep that from recurring.

    // 1. A zero exit is not success — the version must reach `latest`, decided
    //    by a single predicate (`install_converged`) rather than a second
    //    hand-rolled comparison that could drift from it.
    expect(cliUpdate).toContain('verify_active_cli_version(resolved.clone(), &latest)');
    expect(cliUpdate).toContain('install_converged(Some(&local), latest)');
    // The old code fabricated `latest` as the local version when detection came
    // back empty, which is precisely what made a failed install read as a win.
    expect(cliUpdate).not.toContain('.or_else(|| Some(latest.clone()))');

    // 2. A non-convergent install is recorded and reported, not swallowed.
    expect(cliUpdate).toContain('record_non_convergent_version(&latest);');
    expect(cliUpdate).toContain('report_non_convergent_install(');
    // 3. ...and the background loop consults that record before reinstalling.
    expect(normalize(cliUpdate)).toContain(
      'if should_auto_install( &info.latest, non_convergent_cli_version().as_deref(), )',
    );
    // A convergent install must clear the block so a later version is never
    // gated by a condition the user has since fixed.
    expect(cliUpdate).toContain('clear_non_convergent_version();');

    // 4. Convergence is judged on the binary the app EXECUTES. Using
    //    `get_local_version` here would accept its `npm root -g` fallback —
    //    which, for the very pnpm/Homebrew layouts this guards, reports the copy
    //    npm just wrote while the resolved executable is untouched. That trades
    //    a loud reinstall loop for a silent "up to date" lie.
    expect(cliUpdate).toContain('resolved_hq_version(&hq)');
    // The gate must be fed the execution-bound probe, never `get_local_version`'s
    // `npm root -g` fallback — that reading moves to `latest` for exactly the
    // pnpm/Homebrew layouts this guards, while the resolved binary stays stale.
    expect(cliUpdate).not.toContain('verify_active_cli_version(detected');

    // 5. The target is pinned BEFORE npm runs, so a release published mid-install
    //    cannot get recorded as non-convergent without ever being attempted.
    const beforeInstall = cliUpdate.slice(0, cliUpdate.indexOf('run_npm_install(&npm, &path, base_args.clone())'));
    expect(beforeInstall).toContain('let latest = fetch_latest().await?;');
  });

  it('the non-convergent remedy reaches the user instead of the generic retry copy', () => {
    // The backend detail is the only place that names which `hq` the app
    // resolves and says to update it with the tool that installed it. The
    // generic install-failure copy would bury that — and its "copy install
    // command" action is the exact npm command already proven unable to replace
    // the selected CLI, so offering it just repeats the failure.
    expect(settings).toContain("const HQ_CLI_NON_CONVERGENT_PREFIX = 'hq-cli-update/non-convergent: '");
    expect(settings).toContain('if (hqCliNonConvergent) return hqCliNonConvergentMessage;');
    expect(settings).toContain('{#if (!hqCliVersion || hqCliUpdateError) && !hqCliNonConvergent}');
    // The marker the UI keys off must match the constant the Rust side emits.
    expect(cliUpdate).toContain('NON_CONVERGENT_ERROR_PREFIX');
  });

  it('CLI updater telemetry carries only path-free install diagnostics', () => {
    // `before_send` scrubs by KEY name only, so these ordinary string extras
    // would otherwise ship `/Users/<name>/…` to Sentry verbatim.
    expect(cliUpdateCore).toContain('scope.set_extra("hq_bin", redact_home(hq_bin).into());');
    expect(cliUpdateCore).toContain('redact_home(prefix.unwrap_or("npm default prefix"))');
    // npm stderr can contain paths, usernames, and lifecycle output. Keep it in
    // the local log and send only the allow-listed classifications to Sentry.
    expect(cliUpdateCore).not.toContain('scope.set_extra("npm_stderr"');
    expect(cliUpdateCore).toContain('scope.set_tag("npm_failure_site"');
    expect(cliUpdateCore).toContain('scope.set_tag("npm_error_code"');
    // npm stderr is arbitrary free text. Sentry's default scrubber can erase
    // it wholesale, so captures carry only the fixed, path-free summary.
    expect(cliUpdateCore).toContain('fn npm_diagnostics_summary(');
    expect(cliUpdateCore).toContain('scope.set_extra("npm_diagnostics", npm_diagnostics.into());');
    expect(cliUpdateCore).not.toContain('scope.set_extra("npm_stderr"');
  });
});
