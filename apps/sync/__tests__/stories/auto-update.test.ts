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
const workShell = read('src/desktop-alt/HqWorkWorkShell.svelte');
const cliUpdate = read('src-tauri/src/commands/hq_cli_update.rs');
const cliUpdateCore = read('../../crates/hq-desktop-core/src/hq_cli_update.rs');
const installDeps = read('src-tauri/src/commands/install_deps.rs');
const paths = read('../../crates/hq-desktop-core/src/paths.rs');
const ciWorkflow = read('../../.github/workflows/ci.yml');
const settingsRs = read('src-tauri/src/commands/settings.rs');
const processRegistry = read('src-tauri/src/commands/process.rs');
const packages = read('src-tauri/src/commands/packages.rs');
const marketplace = read('src-tauri/src/commands/marketplace.rs');
const hqCoreUpdate = read('src-tauri/src/commands/hq_core_update.rs');
const hqCoreStaging = read('src-tauri/src/commands/hq_core_staging.rs');

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
    expect(appUpdater).toContain('DeferralDecision::WaitForIdle');
    expect(appUpdater).toContain('AUTO_INSTALL_DEFER_CAP');
    expect(appUpdater).toContain('spawn_auto_install_waiter');
    expect(appUpdater).toContain('UPDATE_SYNC_RETRY_INTERVAL');
    expect(appUpdater).toContain('automatic install failed — offering manual recovery');
    expect(appUpdater).toContain('record_and_announce_update');
    expect(appUpdater).toContain('UpdateAnnouncement::PersistentOnly');
    expect(appUpdater).toContain('UpdateAnnouncement::TransientBanner');
    expect(appUpdater).toContain('should_raise_transient_update_surface');
    expect(workShell).toContain('version-gate:update-recommended');
    expect(workShell).toContain('update:waiting-for-idle');
    expect(workShell).toContain('applyRecommendBanner');
    expect(workShell).toContain('reportIdleWait');
    const desktopApp = read('../../packages/ui/src/shell/DesktopApp.svelte');
    expect(desktopApp).toContain('RecommendedUpdateBanner');
    expect(desktopApp).toContain('installRecommendedUpdate');
  });

  it('Windows background installs use the safe helper lifecycle', () => {
    // Windows may install silently only through the out-of-process helper:
    // verified bytes are staged, app children are quiesced, and NSIS starts
    // after the parent has exited.
    const windowsUpdater = read('src-tauri/src/windows_update.rs');
    expect(appUpdater).toContain('fn silent_install_supported()');
    expect(normalize(appUpdater)).toContain(
      'pub(crate) fn silent_install_supported() -> bool { true }',
    );
    expect(appUpdater).toContain('silent_install_supported(),');
    expect(normalize(appUpdater)).toContain(
      'if automatic_updates && silent_install_supported {',
    );
    expect(appUpdater).toContain('InstallTrigger::Forced');
    expect(appUpdater).toContain('InstallTrigger::Manual');
    expect(appUpdater).toContain('pause_new_sync_cycles()');
    expect(appUpdater).toContain(
      'crate::windows_update::install_verified_update(app, update).await',
    );
    expect(normalize(windowsUpdater)).toContain('let bytes = update .download(');
    expect(windowsUpdater).toContain('quiesce_for_update');
    expect(windowsUpdater).toContain('let parent = open_parent(parent_pid)?;');
    expect(windowsUpdater).toContain('wait_for_parent(parent)?;');
    expect(windowsUpdater).toContain('restore_prior_installation');
    expect(processRegistry).toContain('UPDATE_SENSITIVE_OPERATIONS');
    expect(processRegistry).toContain('!attempt.termination_effected');
    expect(packages).toContain('begin_update_sensitive_operation()?');
    expect(marketplace.match(/begin_update_sensitive_operation/g) ?? []).toHaveLength(2);
    expect(hqCoreUpdate).toContain('begin_update_sensitive_operation()');
    expect(hqCoreStaging).toContain('begin_update_sensitive_operation()');
    expect(appUpdater).toContain('UPDATE_DEFERRED_DURING_MUTATION');
    expect(appUpdater).toContain('install_failure_is_transient_deferral');

    // The hard version gate must route through that same coordinator rather
    // than reintroducing a direct Tauri install path.
    const versionGate = read('src-tauri/src/commands/version_gate.rs');
    expect(versionGate).toContain(
      'crate::updater::install_stable_update(app).await',
    );
    expect(versionGate).not.toContain('download_and_install');
  });

  it('the mounted App no longer owns Core automatic updates', () => {
    // Native Rust exercises the updater behavior directly; this architecture
    // contract prevents the old WebView-gated owner from returning.
    expect(app).not.toContain('loadAutoUpdatePref');
    expect(app).not.toContain('autoCoreUpdatedVersion');
    expect(app).not.toContain('if (!s || !s.isEligible || !s.versionBehind) return;');
  });

  it('the CLI background auto-installer gates on the master switch', () => {
    // The Rust CLI checker now installs when the master `autoUpdate` is on
    // (default), superseding the old `cliAutoUpdate`-only gate. The switch is
    // read once per check cycle and fed to a single pure gate.
    expect(cliUpdate).toContain('let auto_update = auto_update_enabled();');
    expect(cliUpdate).toContain('if auto_install_allowed(auto_update, floor_repair) {');
    // The only pass that may install past the opt-out is the launch-time
    // version-floor repair (installed CLI below HQ_CLI_MIN_VERSION), which
    // mirrors hq-core's ensure-hq-cli hook — that hook has no opt-out either.
    // The scheduled loop never takes it.
    expect(normalize(cliUpdateCore)).toContain(
      'pub fn auto_install_allowed(auto_update_enabled: bool, floor_repair: bool) -> bool { auto_update_enabled || floor_repair }',
    );
    expect(cliUpdate).toContain('run_check_cycle(&handle, /* floor_repair */ true).await;');
    const scheduledLoop = cliUpdate.slice(cliUpdate.indexOf('tokio::time::sleep(INITIAL_DELAY).await;'));
    expect(scheduledLoop).toContain('run_check_cycle(&handle, /* floor_repair */ false).await;');
    expect(scheduledLoop).not.toContain('/* floor_repair */ true');
    // The pref defaults ON in both get_settings branches.
    expect(settingsRs).toContain('auto_update: Some(true)');
    expect(settingsRs).toContain('auto_update: Some(prefs.auto_update.unwrap_or(true))');
  });

  it('the CLI installer coalesces overlapping backend requests before episode ownership', () => {
    const commandStart = cliUpdate.indexOf('pub async fn install_hq_cli_update(');
    const onceStart = cliUpdate.indexOf('async fn install_hq_cli_update_once(');
    const command = cliUpdate.slice(commandStart, onceStart);
    const oneShot = cliUpdate.slice(onceStart);

    expect(cliUpdateCore).toContain('pub struct AsyncSingleFlight');
    expect(normalize(command)).toContain(
      '.run(move || install_hq_cli_update_once(app)) .await',
    );
    expect(command).not.toContain('non_convergent_cli_version()');
    expect(oneShot).toContain('let non_convergent_version = non_convergent_cli_version();');
    expect(oneShot).toContain('run_npm_install_with_retries(&npm');
  });

  it('the CLI auto-installer cannot loop on an install that never converges', () => {
    // A prod app spent weeks reinstalling the same CLI version on every launch
    // and every 6h check: npm exited 0 into a prefix nothing read, so the
    // detected version never moved and `update_available` stayed true forever.
    // Three source contracts keep that from recurring.

    // 1. A zero exit is not success — the version must reach `latest`, decided
    //    by a single predicate (`install_converged`) rather than a second
    //    hand-rolled comparison that could drift from it.
    expect(cliUpdateCore).toContain('pub fn decide_post_install(');
    expect(cliUpdate).toContain('let outcome = decide_post_install(');
    expect(cliUpdate).toContain('apply_post_install(outcome, &effects)');
    // The old code fabricated `latest` as the local version when detection came
    // back empty, which is precisely what made a failed install read as a win.
    expect(cliUpdate).not.toContain('.or_else(|| Some(latest.clone()))');

    // 2. A non-convergent install is recorded before it may be reported. The
    //    executor owns this ordering, so a failed marker write fails closed.
    expect(cliUpdate).toContain('struct PostInstallEffects');
    expect(cliUpdateCore).toContain('capture_requires_durable_record');
    expect(cliUpdate).toContain('report_non_convergent_marker_unpersisted()');
    expect(cliUpdateCore).toContain('NonConvergenceKind::ForeignManaged');
    // 3. ...and the background loop consults that record before reinstalling.
    expect(normalize(cliUpdate)).toContain(
      'if should_auto_install(&info.latest, non_convergent_cli_version().as_deref()) {',
    );
    // A convergent install must clear the block so a later version is never
    // gated by a condition the user has since fixed.
    expect(cliUpdate).toContain('let clear = || clear_non_convergent_version();');

    // 4. Convergence is judged on the binary the app EXECUTES. Using
    //    `get_local_version` here would accept its `npm root -g` fallback —
    //    which, for the very pnpm/Homebrew layouts this guards, reports the copy
    //    npm just wrote while the resolved executable is untouched. That trades
    //    a loud reinstall loop for a silent "up to date" lie.
    const installCall = 'run_npm_install_with_retries(&npm';
    const afterInstall = cliUpdate.slice(cliUpdate.indexOf(installCall));
    expect(afterInstall).toContain('let post_install_hq = paths::resolve_bin("hq");');
    expect(afterInstall).toContain('resolved_hq_version(&hq)');
    expect(afterInstall).toContain('before_version.as_deref()');
    // The gate must be fed the execution-bound probe, never `get_local_version`'s
    // `npm root -g` fallback — that reading moves to `latest` for exactly the
    // pnpm/Homebrew layouts this guards, while the resolved binary stays stale.
    expect(cliUpdate).not.toContain('verify_active_cli_version(detected');

    // 5. The target is pinned BEFORE npm runs, so a release published mid-install
    //    cannot get recorded as non-convergent without ever being attempted.
    const retryInstall = cliUpdate.indexOf(installCall);
    expect(retryInstall).toBeGreaterThan(-1);
    const beforeInstall = cliUpdate.slice(0, retryInstall);
    expect(beforeInstall).toContain('let latest = fetch_latest().await?;');
    expect(beforeInstall).toContain('let non_convergent_version = non_convergent_cli_version();');
    expect(normalize(beforeInstall)).toContain(
      'let already_blocked = non_convergent_episode_blocked(non_convergent_version.as_deref(), &latest);',
    );
    // A marker for version A must not suppress the first durable episode for
    // newly-published version B. The shared predicate is the exact-version
    // source of truth for both the background gate and the install command.
    expect(cliUpdateCore).toContain('pub fn non_convergent_episode_blocked(');
    expect(cliUpdate).toContain('non_convergent_episode_blocked(');
  });

  it('an undrivable settings-PATH foreign shadow is repaired in-run, not wedged (HQ-DESKTOP-46)', () => {
    // The live macOS recurrence: the app executes a stale Homebrew `hq` resolved
    // via the winning `.claude` settings file's PATH, while HQ delivered `latest`
    // into its own managed prefix. HQ owns the one input it never fixed — the
    // winning settings file's env.PATH — so it rewrites that file managed-first
    // and re-resolves instead of writing the durable marker that wedges forever.

    // 1. The reader and the writer agree on WHICH file supplies env.PATH via one
    //    source of truth, so the composed managed-first value lands in the file
    //    the resolver actually reads.
    expect(paths).toContain('pub fn winning_settings_path_file(');
    expect(paths).toContain('pub enum SettingsPathFile {');
    expect(installDeps).toContain('pub(crate) fn write_managed_toolchain_settings_path(');
    expect(installDeps).toContain('winning_settings_path_file(hq_root)');
    expect(installDeps).toContain('"settings.local.json"');
    expect(installDeps).toContain('"settings.json"');
    // A symlinked settings file cannot redirect the write outside the HQ folder.
    expect(installDeps).toContain('refusing to write settings PATH outside the HQ folder');

    // 2. The updater's undrivable-foreign arm routes THIS shape into the in-run
    //    repair — an npm ForeignManaged run that is undrivable, delivered a
    //    present shim, and resolved via the settings PATH.
    expect(normalize(cliUpdate)).toContain(
      'if outcome.non_convergence_kind == Some(NonConvergenceKind::ForeignManaged) ' +
        '&& executed_copy_aim == ExecutedCopyAim::Undrivable ' +
        '&& delivered_prefix_shim == DeliveredPrefixShim::Present ' +
        '&& hq_bin_lane == paths::ResolutionSource::SettingsPath',
    );
    expect(cliUpdate).toContain('return settings_path_repair_and_refinalize(');
    expect(cliUpdate).toContain('async fn settings_path_repair_and_refinalize(');
    // The repair calls the SAME staged + atomic writer the installer uses.
    expect(cliUpdate).toContain('write_managed_toolchain_settings_path(');
    expect(cliUpdate).toContain('settings_path_repair_gate(');

    // 3. The durable-marker write is gated on the repair outcome: only a
    //    `Rewritten` repair relaxes the ForeignManaged block, so the re-decide
    //    carries the outcome and every refusal still blocks byte-for-byte.
    expect(cliUpdateCore).toContain('pub fn settings_path_repair_gate(');
    expect(cliUpdateCore).toContain('pub fn settings_path_repair_outcome(');
    expect(cliUpdateCore).toContain('pub enum SettingsPathRepair {');
    expect(cliUpdateCore).toContain('if settings_path_repair == SettingsPathRepair::Rewritten {');
    expect(cliUpdate).toContain('.with_settings_path(settings_path)');
  });

  it('the pnpm executor shares the npm executor’s convergence contract', () => {
    // HQ-DESKTOP-46 era 2: on hq-sync 0.10.69 the pnpm branch exited 0 without
    // moving ~/Library/pnpm/bin/hq, and it reached the reporter through its own
    // legacy call — no durable-marker gate, no episode bounding, and hardcoding
    // `prefix = None` into an npm-shaped payload so the event rendered as an
    // npm default-prefix run. Both executors now go through one seam.
    const pnpmStart = cliUpdate.indexOf('async fn install_hq_cli_update_via_pnpm(');
    expect(pnpmStart).toBeGreaterThan(-1);
    const pnpmBranch = cliUpdate.slice(
      pnpmStart,
      cliUpdate.indexOf('fn apply_post_install_with_app('),
    );
    // Routed through the shared decision + effects seam...
    expect(pnpmBranch).toContain('decide_post_install(&PostInstallContext {');
    expect(pnpmBranch).toContain('executor: InstallExecutor::Pnpm,');
    expect(pnpmBranch).toContain('apply_post_install_with_app(app, &outcome)');
    // ...not the legacy unconditional record-then-report pair it used before.
    expect(pnpmBranch).not.toContain('record_non_convergent_version(latest)');
    expect(pnpmBranch).not.toContain('report_non_convergent_install(');
    // Episode bounding is sampled once before either non-npm executor spawns,
    // then handed unchanged to the selected package-manager branch.
    const normalizedCliUpdate = normalize(cliUpdate);
    expect(normalizedCliUpdate).toContain(
      'let already_blocked = non_convergent_episode_blocked(non_convergent_version.as_deref(), &latest);',
    );
    expect(normalizedCliUpdate).toContain(
      'InstallExecutor::Pnpm => { install_hq_cli_update_via_pnpm(&app, &hq, &latest, already_blocked).await }',
    );
    expect(normalizedCliUpdate).toContain(
      'InstallExecutor::Bun => { install_hq_cli_update_via_bun(&app, &hq, &latest, already_blocked).await }',
    );
    // Convergence is judged by re-resolving the binary the app executes, the
    // same rule the npm branch follows — not by trusting pnpm's zero exit.
    expect(pnpmBranch).toContain('let post_install_hq = paths::resolve_bin("hq");');

    // The candidate cause: `child_path()` never contains `<pnpm-home>/bin`, so
    // the spawned pnpm could resolve a different global dir than the app did.
    expect(pnpmBranch).toContain('let pnpm_env = pnpm_global_env(hq);');
    expect(pnpmBranch).toContain('cmd.env("PNPM_HOME", home);');
    expect(pnpmBranch).toContain('pnpm_child_path(');
    expect(cliUpdateCore).toContain('pub fn pnpm_global_env(');
    // Derivation stays anchored to the resolved shim — an underivable layout
    // must spawn pnpm exactly as before rather than inventing a home.
    expect(cliUpdateCore).toContain('PnpmHomeSource::Undetermined');
  });

  it('the installer asks for the same version the app compared against', () => {
    // HQ-DESKTOP-46 reopen: the app resolved `latest` from the registry's
    // /latest endpoint but asked npm for the mutable `@latest` dist-tag, which
    // npm re-resolves through its own lagging packument cache — so it could
    // install N-1, exit 0, and wedge auto-update on a version nothing attempted.
    // Both executors now pin the EXACT resolved version.
    expect(cliUpdateCore).toContain(
      'pub fn install_argv(prefix: Option<&str>, target_version: Option<&str>)',
    );
    expect(normalize(cliUpdateCore)).toContain(
      'pub fn pnpm_install_argv( target_version: Option<&str>, global_bin_dir: Option<&str>, ) -> Vec<String>',
    );
    expect(cliUpdateCore).toContain('pub fn hq_cli_package_spec(version: Option<&str>)');

    // npm branch: resolve `latest` FIRST, then build the pinned argv from it, so
    // the version the app compares against is the version it installs.
    const npmBranchStart = cliUpdate.indexOf('let prefix = if first_install {');
    const npmBranchEnd = cliUpdate.indexOf('run_npm_install_with_retries(&npm');
    expect(npmBranchStart).toBeGreaterThan(-1);
    expect(npmBranchEnd).toBeGreaterThan(npmBranchStart);
    const npmBranch = cliUpdate.slice(npmBranchStart, npmBranchEnd);
    expect(npmBranch).toContain('let latest = fetch_latest().await?;');
    expect(npmBranch).toContain(
      'let base_args = install_argv(prefix.as_deref(), Some(latest.as_str()));',
    );
    expect(npmBranch.indexOf('fetch_latest()')).toBeLessThan(
      npmBranch.indexOf('install_argv(prefix.as_deref()'),
    );
    // The ordinary update also AIMS at the copy the app will execute before it
    // pins the version — a drivable user-owned prefix is upgraded in place with
    // its own npm (the r3 fix for the nvm-under-managed-npm non-convergence).
    expect(npmBranch).toContain('select_ordinary_install_aim(&hq, &managed_roots');

    // pnpm branch pins the same way, from the target already resolved for it,
    // AND forces pnpm's global bin dir at the directory holding the resolved
    // shim so pnpm cannot write the new shim to a dir the app never executes.
    expect(normalize(cliUpdate)).toContain(
      'let args = pnpm_install_argv( Some(latest), pnpm_env.as_ref().map(|env| env.global_bin_dir.as_str()), );',
    );
  });

  it('a version the registry has not propagated yet does not wedge auto-update', () => {
    // Delivery evidence breaks the npm-targeted tautology: a non-convergence may
    // block auto-update only when the target was actually delivered into the
    // prefix. A shortfall (delivered N-1, or ETARGET) never wedges.
    expect(cliUpdateCore).toContain('ResolutionShortfall');
    expect(cliUpdateCore).toContain('pub fn installed_hq_cli_version_in_prefix(');
    expect(cliUpdateCore).toContain('fn may_block_auto_update(');
    // The app reads the delivered version and threads it into the decision.
    expect(cliUpdate).toContain('installed_hq_cli_version_in_prefix(&prefix, &hq)');
    expect(cliUpdate).toContain('delivered_version.as_deref(),');

    // A legacy (pre-pin) marker earns exactly one recovery re-attempt so an
    // already-wedged machine recovers; a marker written under the pinned
    // contract keeps blocking, so a genuinely stuck layout does not reopen the
    // endless-reinstall loop.
    expect(cliUpdateCore).toContain('pub fn legacy_marker_needs_recovery(');
    expect(cliUpdateCore).toContain('pub const PINNED_MARKER_CONTRACT');
    expect(cliUpdate).toContain('if legacy_marker_needs_recovery(');
    // The blocking marker is stamped with the pinned contract tag so it is never
    // mistaken for a recoverable legacy one.
    expect(cliUpdate).toContain('NON_CONVERGENT_CONTRACT_KEY');
  });

  it('the pnpm delivery decision uses pnpm’s own answer and an honest direction probe', () => {
    // HQ-DESKTOP-46 r3 reopen: the r2 fix aimed pnpm correctly, but every path
    // that VERIFIED the result hard-coded pnpm <=10's global layout, so on pnpm
    // >=11 (store moved to `global/v11/<hash>`) the install landed while the app
    // read delivered=none — a false shortfall that re-fired on every publish. Two
    // things change: delivery evidence is now pnpm's OWN answer (which reads the
    // v11 store), and the direction probe is made honest and demoted to a
    // diagnostic, so blocking no longer rides a tautology.

    // The direction-derived `pnpm-misdirected` class is gone: blocking is gated on
    // delivery evidence plus the executed reading alone.
    expect(cliUpdateCore).not.toContain('PnpmMisdirected');
    expect(cliUpdateCore).not.toContain('"pnpm-misdirected"');
    // A resolution shortfall never blocks; the installer-unaimed shape (an
    // npx-cache copy, or an unaimed pnpm/Bun run) was never aimed at the executed
    // copy, so it must not block either.
    expect(normalize(cliUpdateCore)).toContain(
      '!matches!(self, Self::ResolutionShortfall | Self::InstallerUnaimed)',
    );

    const pnpmBranch = cliUpdate.slice(
      cliUpdate.indexOf('async fn install_hq_cli_update_via_pnpm('),
      cliUpdate.indexOf('fn apply_post_install_with_app('),
    );
    // Delivery evidence is pnpm's authoritative answer, not the guessed store path.
    expect(pnpmBranch).not.toContain('delivered_version: None,');
    expect(pnpmBranch).toContain('pnpm_global_delivered_version(&pnpm, &path, &env.home)');
    expect(pnpmBranch).toContain('delivered_version: delivered_version.as_deref(),');
    // The authoritative reader and its layout-agnostic fallbacks live in core, and
    // the app spawns pnpm's own `ls -g --json` / `root -g` for the answer. The
    // corrected store enumeration remains only as the last-resort fallback.
    expect(cliUpdateCore).toContain('pub fn pnpm_global_ls_hq_cli_version(');
    expect(cliUpdateCore).toContain('pub fn hq_cli_version_under_pnpm_root(');
    expect(cliUpdateCore).toContain('pub fn installed_hq_cli_version_in_pnpm_store(');
    expect(normalize(cliUpdate)).toContain('["ls", "-g", "--depth", "0", "--json"]');
    expect(normalize(cliUpdate)).toContain('["root", "-g"]');
    // Every new pnpm verification subprocess is bounded — a hung pnpm is killed
    // instead of wedging the install and the CLI-update single-flight forever.
    expect(cliUpdate).toContain('const PNPM_PROBE_TIMEOUT: Duration');
    expect(cliUpdate).toContain('tokio::time::timeout(PNPM_PROBE_TIMEOUT, cmd.output())');
    expect(cliUpdate).toContain('.kill_on_drop(true)');

    // The `pnpm bin -g` probe runs only when the install did not converge...
    expect(pnpmBranch).toContain(
      'let converged = install_converged(resolved.as_deref(), latest);',
    );
    expect(pnpmBranch).toContain(
      'pnpm_effective_global_bin_dir(&pnpm, &path, Some(env.home.as_str()))',
    );
    expect(pnpmBranch).toContain('global_bin_dir_matches_shim_dir,');
    // ...and it is spawned WITHOUT the forced --config.global-bin-dir, so it
    // reports pnpm's own resolution instead of echoing the value we handed it.
    // (The install, by contrast, still forces it — r2 aiming is correct and kept.)
    expect(cliUpdate).not.toContain('--config.global-bin-dir');
    expect(cliUpdateCore).toContain('--config.global-bin-dir');
    expect(normalize(cliUpdate)).toContain(
      'let args = pnpm_install_argv( Some(latest), pnpm_env.as_ref().map(|env| env.global_bin_dir.as_str()), );',
    );

    // The delivery + direction + store-family evidence rides into telemetry as
    // closed values, so the next occurrence is self-diagnosing instead of
    // ambiguous — and the grouping fingerprint does not split.
    expect(normalize(cliUpdateCore)).toContain(
      'scope.set_tag( "pnpm_global_bin_dir_matches_shim_dir",',
    );
    expect(normalize(cliUpdateCore)).toContain('scope.set_tag( "pnpm_store_family",');
    expect(normalize(cliUpdateCore)).toContain('scope.set_tag( "pnpm_authoritative_query_ok",');
  });

  it('a persistent pnpm shortfall is captured once per version, not on every check', () => {
    // The 16:13:33 (0.10.94) / 16:14:27 (0.10.95) double-fire across an app
    // self-update: a non-blocking shortfall is now episode-bounded by a persisted
    // key set, distinct from the durable blocking marker (which it never writes),
    // so a persistent environment shape reports once per new `latest`.
    expect(cliUpdateCore).toContain('pub fn non_convergent_episode_key(');
    expect(cliUpdateCore).toContain('pub fn non_convergent_episode_reported(');
    expect(cliUpdateCore).toContain('pub fn non_convergent_episode_record(');
    // The decision returns the key to persist only on the first capture.
    expect(cliUpdateCore).toContain('pub record_nonblocking_episode: Option<String>,');
    // The app threads the persisted set in and persists the returned key after the
    // capture — its OWN menubar key, never the durable blocking marker.
    const pnpmBranch = cliUpdate.slice(
      cliUpdate.indexOf('async fn install_hq_cli_update_via_pnpm('),
      cliUpdate.indexOf('fn apply_post_install_with_app('),
    );
    expect(pnpmBranch).toContain('nonblocking_episode_keys: &nonblocking_episode_keys,');
    expect(pnpmBranch).toContain('non_convergent_episode_record(&existing, key, latest)');
    expect(cliUpdate).toContain(
      'const NON_CONVERGENT_EPISODE_KEYS: &str = "cliNonConvergentEpisodeKeys";',
    );
    expect(cliUpdate).toContain('fn non_convergent_episode_markers()');
    // The npm finalization path threads the SAME persisted set in and persists the
    // returned key too, so the installer-unaimed shape (an unresolved `hq` after an
    // npm install) is bounded once per episode instead of re-paging every check.
    const npmFinalize = cliUpdate.slice(
      cliUpdate.indexOf('async fn finalize_convergence('),
      cliUpdate.indexOf('fn managed_shadow_repair_outcome('),
    );
    expect(npmFinalize).toContain(
      '.with_nonblocking_episode_keys(&nonblocking_episode_keys)',
    );
    expect(npmFinalize).toContain('non_convergent_episode_record(&existing, key, latest)');
  });

  it('a non-convergent capture names which package manager ran', () => {
    // The three live 2026-08-06 events could not be attributed: same
    // fingerprint, no executor tag, and an `npm_prefix` extra that was actively
    // wrong for a pnpm run.
    const core = normalize(cliUpdateCore);
    expect(core).toContain('scope.set_tag("install_executor", executor.telemetry_value());');
    expect(core).toContain('scope.set_tag( "pnpm_home_source",');
    expect(core).toContain('scope.set_tag( "pnpm_home_env_present",');
    expect(core).toContain('scope.set_tag( "pnpm_path_has_shim_dir",');
    expect(core).toContain('scope.set_extra("pnpm_diagnostics", diagnostics.summary().into());');
    // The grouping must NOT split: a new tag that forked the fingerprint would
    // make the issue look resolved while the same defect kept occurring.
    expect(cliUpdateCore).toContain(
      'scope.set_fingerprint(Some(&["hq-cli-update", "install-non-convergent"]));',
    );
  });

  it('Rust CI cannot repair a stale lockfile before checking it', () => {
    // Assert the invariant -- every cargo test/check/build in CI passes
    // --locked, so a stale Cargo.lock fails loudly instead of being silently
    // repaired -- rather than pinning one literal command. The previous form
    // asserted `cargo test --workspace --locked`, which broke the moment the
    // shared crates moved to the Linux job even though every invocation still
    // carried --locked. Pinning the invariant survives that reshuffle and
    // catches a dropped flag anywhere, including in jobs added later.
    const invocations = [
      ...ciWorkflow.matchAll(/run: (cargo (?:test|check|build)[^\n]*)/g),
    ].map((match) => match[1]);

    expect(invocations.length).toBeGreaterThan(0);
    for (const invocation of invocations) {
      expect(invocation).toContain('--locked');
    }

    // The app crate's suite still runs from its own manifest directory, so the
    // workspace-excluded Tauri crate is genuinely exercised.
    expect(ciWorkflow).toMatch(/working-directory: apps\/sync\/src-tauri\s+run: cargo test --locked/);
  });

  it('the CLI installer keeps its bounded retry ladder and final-attempt context', () => {
    // The live install path must go through the four-attempt bounded ladder,
    // rather than bypassing its causal `--force` bookkeeping. That context is
    // what lets the core classifier distinguish a collision that survived npm's
    // remedy from an initial EEXIST that is still unexpected and loud.
    expect(cliUpdate).toContain('const MAX_NPM_INSTALL_ATTEMPTS: usize = 4;');
    expect(cliUpdate).toContain('run_npm_install_with_retries(');
    expect(cliUpdate).toContain('"cleanup-forced-bin-collision"');
    expect(cliUpdate).toContain('let final_attempt_forced = ledger.last().is_some_and');
    // Classification is now environment-aware (so an unsupported user Node is
    // recognised), but still receives the final-attempt context that lets the
    // classifier tell a post-force collision from an initial EEXIST.
    expect(cliUpdate).toContain('classify_install_failure_with_environment(');
    expect(normalize(cliUpdate)).toContain(
      'install_run.final_attempt_forced, &install_env,',
    );
    // Failures now report through the repeat-guarded episode entrypoint, which
    // still receives the final-attempt context — so the classifier can tell a
    // post-force collision from an initial EEXIST — alongside the toolchain
    // provenance the previous events lacked.
    expect(cliUpdate).toContain('report_install_failure_episode(');
    expect(cliUpdate).toContain('install_run.final_attempt_forced,');
    expect(normalize(cliUpdateCore)).toContain(
      'scope.set_tag( "npm_final_attempt_forced",',
    );
  });

  it('recovers a prefix-less ENOTEMPTY wedge from the npm-reported scope and absorbs EIDLETIMEOUT (HQ-DESKTOP-5B/5C)', () => {
    const core = normalize(cliUpdateCore);
    // 5B: the ENOTEMPTY rung resolves its cleanup scope from the resolved prefix
    // first and, when none resolved (npm_prefix_known=false in 61/61 events),
    // from the absolute @indigoai-us path npm itself named — so the prefix-less
    // wedge is finally remediated instead of skipped by the old else arm.
    expect(cliUpdate).toContain('partial_install_scope_dir(cleanup_prefix)');
    expect(cliUpdate).toContain('partial_install_scope_from_npm_path(&detail)');
    expect(cliUpdate).toContain('"cleanup-plain-npm-path"');
    // The scope derivation is a pure, fail-closed helper: it only accepts an
    // absolute path whose `@indigoai-us` component sits directly under an exact
    // `node_modules` component.
    expect(cliUpdateCore).toContain('pub fn partial_install_scope_from_npm_path(');
    expect(core).toContain('components[index - 1] == "node_modules"');
    // The deletion set stays exactly `hq-cli` + `.hq-cli-*`, shared by BOTH scope
    // sources through the one scope-taking cleaner.
    expect(cliUpdate).toContain('fn clean_partial_hq_cli_install_scope(scope: &Path)');
    expect(cliUpdate).toContain('clean_partial_hq_cli_install_scope(&scope)');
    expect(cliUpdate).toContain('scope.join("hq-cli")');
    expect(cliUpdate).toContain('.starts_with(".hq-cli-")');
    // 5C: EIDLETIMEOUT joins the transient-registry allow-list so a registry idle
    // timeout is absorbed like its siblings instead of paging at Error.
    expect(cliUpdateCore).toContain('"EIDLETIMEOUT"');
    // A genuinely unremovable wedge now mints a per-version repeat-guard key, so
    // it pages once per published CLI version instead of every 6-hourly check.
    expect(core).toContain('unexpected|{code}|{syscall}|{path_shape}');
  });

  it('classifies an unsupported user Node and self-heals it before reporting (HQ-DESKTOP-56)', () => {
    const core = normalize(cliUpdateCore);
    // Core publishes the floor as the single source of truth and a new kind for
    // the shape, decided from the probed environment — never from raw stderr.
    expect(cliUpdateCore).toContain('pub const MIN_NODE_MAJOR: u32 = 20;');
    expect(cliUpdateCore).toContain('UnsupportedNode');
    expect(cliUpdateCore).toContain('pub fn classify_install_failure_with_environment(');
    // The rewrite is a strict refinement of the `Unexpected` fallback, gated on a
    // parsed major strictly below the floor.
    expect(core).toContain('major < MIN_NODE_MAJOR');
    // Its own bounded signature keeps it out of the none:unknown:none bucket...
    expect(cliUpdateCore).toContain('format!("unsupported-node:{major}")');
    // ...it reports at Warning (a local-runtime condition, not an updater defect)...
    expect(core).toContain(
      'InstallFailureKind::ExpectedBinCollision | InstallFailureKind::UnsupportedNode',
    );
    // ...names the required Node in the user copy instead of the raw parse error...
    expect(cliUpdateCore).toContain('hq needs Node.js {MIN_NODE_MAJOR} or newer');
    // ...and mints a repeat-guard key so a permanent per-machine runtime pages
    // once per target version, not on every scheduled check.
    expect(cliUpdateCore).toContain(
      'pub fn install_failure_episode_key_with_environment(',
    );
    expect(core).toContain('unsupported-node|{major}');

    // The app classifies WITH the probed environment, arms the SAME one-shot
    // managed-Node retry for the new kind, and shows the environment-aware copy.
    expect(cliUpdate).toContain('classify_install_failure_with_environment(');
    expect(cliUpdate).toContain('kind == InstallFailureKind::UnsupportedNode');
    expect(cliUpdate).toContain('install_failure_detail_with_environment(');
  });

  it('attributes, self-heals, and episode-bounds a markerless install failure whose npm never ran (HQ-DESKTOP-56 reopen)', () => {
    const core = normalize(cliUpdateCore);
    const appCli = normalize(cliUpdate);
    // Core reuses the reviewed, content-safe stderr-shape vocabulary (HQ-DESKTOP-5H)
    // rather than inventing a second telemetry primitive.
    expect(cliUpdateCore).toContain(
      'use crate::watcher_fault::{UnmatchedStderrShape, UnmatchedStderrShapeRollup};',
    );
    // A NON-EMPTY markerless Unexpected failure leaves the empty none:unknown:none
    // bucket for a bounded `unattributed:<origin>:<dominant shape>` group...
    expect(cliUpdateCore).toContain('"unattributed:{}:{}"');
    // ...while an EMPTY stderr stays byte-identical (shapeless, unbounded).
    expect(cliUpdateCore).toContain(
      'const SHAPELESS_INSTALL_SIGNATURE: &str = "none:unknown:none";',
    );
    // The failure is attributed by WHERE its bytes came from — a closed origin enum.
    expect(cliUpdateCore).toContain('pub const STDERR_ORIGIN_NON_NPM: &str = "non-npm";');
    expect(cliUpdateCore).toContain('pub fn unattributed_install_stderr_origin(');
    // Two diagnostics-only tags (never in the fingerprint) make the next occurrence
    // self-diagnosing.
    expect(cliUpdateCore).toContain('scope.set_tag("npm_stderr_origin", profile.origin);');
    expect(cliUpdateCore).toContain(
      'scope.set_tag("npm_stderr_shapes", profile.shapes_tag.as_str());',
    );
    // It pages once per published CLI version on that discriminating signature.
    expect(cliUpdateCore).toContain('"{latest}|unattributed|{}|{}"');

    // The app widens its OWN managed-toolchain self-heal to the non-npm subclass —
    // npm's logger emitted nothing, so the user's npm/shim never really ran and HQ's
    // managed npm bypasses it — computing the origin once and threading it into the
    // pure gate, which arms ONLY for the non-npm origin.
    expect(cliUpdate).toContain('unattributed_install_stderr_origin(');
    expect(cliUpdate).toContain('unattributed_origin: Option<&str>');
    expect(appCli).toContain(
      'kind == InstallFailureKind::Unexpected && unattributed_origin == Some(STDERR_ORIGIN_NON_NPM)',
    );
    expect(appCli).toContain(
      'repairable_runtime && (repairable_lifecycle || unsupported_node || unattributed_non_npm)',
    );
  });

  it('a collision on either declared hq-cli shim reaches the same --force remedy', () => {
    // HQ-DESKTOP-4Y: an EEXIST on the package's second declared shim
    // (`hq-auth-refresh`) classified as `EEXIST:unknown:other` and never armed
    // npm's --force, so the update failed permanently. Recognition must be
    // driven by the package's declared bin map, not a hard-coded `hq`.
    const core = normalize(cliUpdateCore);
    expect(cliUpdateCore).toContain('const HQ_CLI_BIN_NAMES');
    expect(cliUpdateCore).toContain('"hq-auth-refresh"');
    // The shape recognition iterates the declared names instead of matching `hq`.
    expect(core).toContain('HQ_CLI_BIN_NAMES.iter()');
    // The colliding shim is named on the event as a closed enumeration, kept out
    // of the fingerprint so grouping stays stable.
    expect(cliUpdateCore).toContain('fn npm_bin_target(');
    expect(core).toContain('scope.set_tag("npm_bin_target"');
    // The app side still just delegates to the core collision test, so widening
    // the shape automatically arms the existing single `--force` rung.
    expect(cliUpdate).toContain('is_npm_bin_collision(detail, prefix)');
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
    // Both executors emit that marker, but the pnpm remedy differs: telling a
    // user to "update it with the tool that installed it" is a dead end when
    // the app just ran that tool and pnpm still did not converge.
    expect(cliUpdateCore).toContain('InstallExecutor::Pnpm => format!(');
    expect(cliUpdateCore).toContain('pnpm bin -g');
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
    expect(cliUpdateCore).toContain('scope.set_tag("npm_errno"');
    expect(cliUpdateCore).toContain('scope.set_tag("hq_bin_source"');
    // Both the npm-only source tag and the executor-neutral one carry closed
    // categories from `bin_resolution_source`, never the resolved path.
    expect(normalize(cliUpdateCore)).toContain('scope.set_tag( "npm_bin_source",');
    expect(normalize(cliUpdateCore)).toContain('scope.set_tag( "installer_bin_source",');
    // The settings-PATH triple (HQ-DESKTOP-46) is emitted from closed, path-free
    // token vocabularies (telemetry_value), never a raw filesystem path.
    expect(normalize(cliUpdateCore)).toContain('scope.set_tag( "settings_path_file",');
    expect(normalize(cliUpdateCore)).toContain('scope.set_tag( "managed_bin_in_settings_path",');
    expect(normalize(cliUpdateCore)).toContain('scope.set_tag( "settings_path_repair",');
    expect(cliUpdateCore).toContain('report.settings_path.file.telemetry_value()');
    expect(cliUpdateCore).toContain('report.settings_path.managed_bin.telemetry_value()');
    expect(cliUpdateCore).toContain('report.settings_path.repair.telemetry_value()');
  });
});

describe('installs the CLI when the machine has none', () => {
  // Before this, `check_once` compared versions with `None => false`, so a
  // machine with no `hq` at all reported "no update available" and the
  // background installer below it never ran — even though the app is the
  // natural place to put the CLI on a machine that lacks it.

  it('treats "no CLI installed at all" as needing an install', () => {
    expect(cliUpdateCore).toContain('pub fn cli_install_needed(');
    // The decision is the extracted function, not an inline comparison whose
    // None arm is invisible to tests.
    expect(normalize(cliUpdate)).toContain(
      'let update_available = cli_install_needed(local.as_deref(), &latest, local_version.hq_installed);',
    );
    expect(cliUpdate).not.toContain('None => false,');
  });

  it('leaves a present-but-unreadable binary alone', () => {
    // Ambiguous: our own broken install, or an unrelated program named `hq`.
    // A version string cannot tell them apart, and the installer refuses
    // either way — so claiming "needed" would only retry fruitlessly forever.
    expect(normalize(cliUpdateCore)).toContain('None => !hq_installed,');
  });

  it('routes a first install to npm rather than refusing outright', () => {
    expect(cliUpdateCore).toContain('pub fn install_executor_for_first_install(');
    expect(normalize(cliUpdate)).toContain(
      'install_executor_for_first_install(hq_resolved.kind).ok_or_else(||',
    );
    expect(cliUpdate).toContain('paths::resolve_bin_with_kind("hq")');
  });

  it('refuses every resolved-but-unidentifiable binary, including pnpm and Bun paths', () => {
    // A path inside a pnpm/Bun global root proves only that THAT MANAGER owns
    // the binary — any unrelated package exposing an `hq` bin installs to
    // exactly there. Path shape is not ownership, so it must not unlock an
    // install over someone else's command.
    expect(cliUpdate).toContain('Refusing to overwrite an unrelated command.');
    expect(normalize(cliUpdateCore)).toContain(
      '(resolved == ResolvedProgramKind::NotResolved).then_some(InstallExecutor::Npm)',
    );
    const fallbackStart = cliUpdateCore.indexOf('pub fn install_executor_for_first_install(');
    const fallbackEnd = cliUpdateCore.indexOf('\n}', fallbackStart);
    const body = cliUpdateCore.slice(fallbackStart, fallbackEnd);
    expect(body).not.toContain('is_pnpm_global_shim');
    expect(body).not.toContain('is_bun_global_shim');
  });

  it('provisions HQ managed Node when a first install has no npm to run', () => {
    // The population with no CLI is the one least likely to have a toolchain.
    // A missing npm fails at the very first spawn, and that error propagates
    // out before the managed-toolchain retry (which only arms on a failing
    // install OUTPUT, never a spawn error) is ever reached.
    expect(cliUpdate).toContain('async fn provision_managed_npm_for_first_install(');
    expect(cliUpdate).toContain('crate::commands::sync::repair_managed_node(app).await');
    expect(normalize(cliUpdate)).toContain(
      'if first_install && !npm_within_managed_root(&npm, &managed_roots) {',
    );
    // Provisioning failure must not become a new hard failure: fall back to the
    // unresolved npm and surface the ordinary spawn error, as before.
    expect(normalize(cliUpdate)).toContain('.unwrap_or((npm, path))');
  });
});
