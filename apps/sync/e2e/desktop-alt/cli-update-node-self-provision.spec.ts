import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * HQ-DESKTOP-4V / HQ-DESKTOP-4W — the hq-CLI auto-updater on a Node-20 arm64 Mac.
 *
 * The reported failures were real end-user auto-updates: `npm i -g
 * @indigoai-us/hq-cli@latest` ran under the user's OWN Node 20, whose ABI (115)
 * has no prebuilt binary for better-sqlite3 / node-llama-cpp, so npm fell
 * through to a from-source build that failed with no Xcode CLT — and the updater
 * just logged, classified, reported to Sentry at Error, and told the user to
 * install tools by hand. HQ already ships a checksum-verified managed Node 22
 * (ABI 127) whose prebuilds DO exist, and already reuses it for exactly this
 * class of gap in the Sync and Connect lanes.
 *
 * This spec locks the observable wiring of the CLI-updater self-heal, mirroring
 * connect-node-self-provision.spec.ts (HQ-DESKTOP-49):
 *
 *   1. HQ reuses the EXISTING managed-Node installer via `repair_managed_node`,
 *      never a second installer and never the low-level Node installer directly.
 *   2. Only a REPAIRABLE third-party native-build lifecycle failure under the
 *      user's OWN Node arms the retry — a pure, unit-tested gate that also
 *      consults the diagnosed cause and the probed Node ABI (a full disk, a dead
 *      network, or a run already on the managed ABI earns no provision).
 *   3. The retry is bounded to ONE provision and ONE re-run: no loop.
 *   4. The retry installs into HQ's OWN managed npm prefix (never the user's),
 *      derived from the shared `paths::managed_npm_prefix_in` helper the first-run
 *      installer also uses, so ABI-127 artifacts land in a prefix whose shim runs
 *      under managed Node 22 — build ABI and execute ABI match by construction.
 *   5. Convergence is ABI/runtime-aware, not version-only: the installed binary
 *      must resolve INSIDE the managed prefix AND actually execute; anything short
 *      routes through the shared non-convergent path, never a "healed" success.
 *   6. A converged retry emits NO Sentry event; a failed retry reports once with
 *      managed provenance (`managed_toolchain_retry=true`) and provenance-aware
 *      user-facing wording that never re-blames the user's runtime.
 *   7. The retry reuses the already-pinned version and never re-resolves the
 *      `@latest` dist-tag (which would reopen the post-publish registry race).
 *
 * Source-contract harness, same style as connect-node-self-provision.spec.ts: it
 * runs inside the existing scripted "Desktop-alt E2E" CI job with no built binary.
 */

describe('hq-CLI updater self-provisions HQ-managed Node before blaming the user (HQ-DESKTOP-4V/4W)', () => {
  const cli = readRepoFile('src-tauri/src/commands/hq_cli_update.rs');
  const syncRs = readRepoFile('src-tauri/src/commands/sync.rs');

  const occurrences = (haystack: string, needle: string) =>
    haystack.split(needle).length - 1;

  // The retry helper body, sliced so "bounded to one attempt" assertions cannot
  // be satisfied by unrelated code elsewhere in the file (the background checker
  // further down legitimately loops). The convergence / failure-detail helpers are
  // defined ABOVE managed_toolchain_retry, so they are outside this slice.
  const retryHelper = cli.slice(
    cli.indexOf('async fn managed_toolchain_retry('),
    cli.indexOf('fn record_non_convergent_version('),
  );

  it('reuses the existing managed-Node installer instead of adding a second one', () => {
    // `repair_managed_node` already wraps the installer and already carries the
    // repair cooldown. The updater consumes it; it does not reimplement the
    // download, and it does not reach the low-level installer or URL helpers.
    expect(syncRs).toContain(
      'pub(crate) async fn repair_managed_node<R: tauri::Runtime>(app: &AppHandle<R>)',
    );
    expect(cli).toContain('crate::commands::sync::repair_managed_node(app)');
    expect(cli).not.toContain('install_deps::install_node');
    expect(cli).not.toContain('managed_node_url_for');
    // The managed npm/PATH is derived only from the closed path helpers, and the
    // install PREFIX comes from the SHARED helper the first-run installer uses.
    expect(cli).toContain('paths::managed_toolchain_roots()');
    expect(cli).toContain('paths::managed_node_executable_in(&root)');
    expect(cli).toContain('paths::managed_npm_prefix_in(&root)');
  });

  it('only self-repairs a repairable third-party failure under the user`s own Node', () => {
    // A pure, unit-tested gate — no AppHandle, no real install — that now also
    // consults the diagnosed cause and the probed Node ABI, so the trigger
    // condition cannot drift silently into a wasted provision.
    expect(cli).toContain('fn install_failure_earns_managed_retry(');
    expect(cli).toContain('kind == InstallFailureKind::UnexpectedLifecycle');
    expect(cli).toContain('source == NpmToolchainSource::UserPath');
    expect(cli).toContain('!matches!(cause, "disk-space" | "network")');
    expect(cli).toContain('failing_node_abi != Some(MANAGED_NODE_ABI)');
    // The failure path probes the environment ONCE up front and consults exactly
    // that gate — with cause + ABI evidence — before any provisioning.
    expect(cli).toContain('let lifecycle_cause = npm_lifecycle_cause(&raw_detail);');
    expect(cli).toContain('let failing_node_abi = install_env');
    expect(cli).toContain('install_failure_earns_managed_retry(');
    expect(cli).toContain('install_env.toolchain_source');
  });

  it('bounds the self-heal to one provision and one re-run — no loop', () => {
    // Exactly one provision call in the whole updater module...
    expect(occurrences(cli, 'repair_managed_node(')).toBe(1);
    // ...and the retry body never loops.
    expect(retryHelper).not.toMatch(/\b(loop|while)\b/);
    // The provision result is reduced to a disposition (Repaired / Deferred /
    // Failed). Per the HQ-DESKTOP-5E fix, a cooldown deferral or a failed FRESH
    // provision NO LONGER abandons the retry: the pure start decision proceeds
    // whenever a managed npm resolves, and declines — once, with no retry — only
    // when none does, so the caller then reports the original user-path failure.
    expect(retryHelper).toContain(
      'ToolchainRepair::Repaired => ManagedRepairDisposition::Repaired',
    );
    expect(retryHelper).toContain('ToolchainRepair::Skipped =>');
    expect(retryHelper).toContain('ToolchainRepair::Failed(reason) =>');
    expect(retryHelper).toContain(
      'managed_retry_start_decision(disposition, managed_toolchain_npm_and_path())',
    );
    expect(retryHelper).toContain('ManagedRetryStart::Decline(outcome) =>');
    expect(retryHelper).toContain('return ManagedRetryAttempt::Declined(outcome)');
  });

  it('installs into HQ`s managed prefix, never the user prefix, with ABI-aware convergence', () => {
    // The retry rebuilds its argv against the MANAGED prefix and the pinned
    // version, and hands the SAME managed prefix to the retry ladder (so the
    // EEXIST/ENOTEMPTY cleanup scope is confined to the managed tree).
    expect(retryHelper).toContain(
      'install_argv(Some(managed_prefix.as_str()), Some(latest))',
    );
    expect(retryHelper).toContain('Some(managed_prefix.as_str())');
    // The old user-prefix reuse is gone: the retry no longer replays base_args.
    expect(retryHelper).not.toContain('base_args.to_vec()');
    // Convergence is ABI/runtime-aware, not version-only: the resolved binary must
    // live inside the managed prefix (b) AND actually execute (c).
    expect(retryHelper).toContain('managed_retry_converged(');
    expect(cli).toContain('async fn managed_retry_converged(');
    expect(cli).toContain('.starts_with(managed_prefix)');
    expect(cli).toContain('hq_version_string(Path::new(&hq))');
    expect(cli).toContain('managed_retry_after_version(');
    // Anything short routes through the SHARED decide_post_install path, never a
    // healed success.
    expect(cli).toContain('installed_hq_cli_version_in_prefix(&prefix, &hq)');
    expect(cli).toContain('apply_post_install_with_app(app, &outcome)');
  });

  it('defers the persistent PATH change until the retry has converged', () => {
    // The raw shell-profile / Windows-PATH mutation lives in a dedicated helper...
    expect(cli).toContain('fn configure_managed_shell_path(');
    const pathHelper = cli.slice(
      cli.indexOf('fn configure_managed_shell_path('),
      cli.indexOf('async fn managed_toolchain_retry('),
    );
    expect(pathHelper).toContain('ensure_shell_path_configured');
    expect(pathHelper).toContain('append_user_path');
    // ...and the retry invokes it ONLY on a converged install, guarded by the
    // convergence result — so a FAILED retry never persists a PATH change that could
    // shadow the user's still-working CLI under a mismatched Node.
    expect(retryHelper).toContain('configure_managed_shell_path(app, &managed_prefix)');
    // The convergence result gates the branches: the PATH change lives in the
    // Ok(info) arm only, so a failed retry never persists it.
    expect(retryHelper).toContain('match converged {');
    expect(retryHelper).toContain('Ok(info) =>');
    // The PATH call appears AFTER the convergence decision (deferred, not up front)...
    expect(retryHelper.indexOf('configure_managed_shell_path(')).toBeGreaterThan(
      retryHelper.indexOf('managed_retry_converged('),
    );
    // ...and the raw mutation never runs inside the retry body before the install.
    expect(retryHelper).not.toContain('ensure_shell_path_configured');
    expect(retryHelper).not.toContain('append_user_path');
  });

  it('keeps the ordinary install prefix on the resolved npm`s runtime', () => {
    // The first-attempt install derives its prefix from the RUNTIME of the resolved
    // npm, not `hq` alone. After a prior episode provisioned managed Node but left no
    // managed `hq`, npm is managed (Node 22) while `hq` still resolves the user's
    // Node-20 shim — a user-derived prefix would then receive ABI-127 artifacts that
    // runtime cannot load, the very corruption the managed-retry fix prevents.
    // The ordinary (already-installed) update path still derives its prefix from
    // the resolved npm's runtime via hq_cli_install_prefix; only a FIRST install
    // (nothing resolved at all) is instead aimed at HQ's own managed npm prefix so
    // the post-install probe can converge.
    expect(cli).toContain('hq_cli_install_prefix(&npm, &hq)');
    expect(cli).toContain('first_install_prefix(&managed_roots)');
    expect(cli).toContain('fn hq_cli_install_prefix(');
    expect(cli).toContain('fn prefer_managed_prefix(');
    // A managed npm (living inside a managed toolchain root) routes to the SHARED
    // managed prefix helper — never a user-derived prefix under a managed npm.
    expect(cli).toContain('Path::new(npm).starts_with(&root)');
    expect(cli).toContain('paths::managed_npm_prefix_in(&root)');
    // The ordinary path now ALSO aims at the copy the app will EXECUTE: a drivable
    // user-owned prefix that ships its own npm is upgraded in place, running THAT
    // prefix's own npm (never HQ's managed npm), which converges the live
    // nvm-under-managed-npm shape without breaking the ABI guarantee above.
    expect(cli).toContain('select_ordinary_install_aim(&hq, &managed_roots');
    expect(cli).toContain('fn select_ordinary_install_aim(');
    expect(cli).toContain('paths::is_user_owned_prefix(');
    expect(cli).toContain('user_prefix_aim_decision(');
  });

  it('emits no Sentry event on a converged retry, and reports a failed retry with managed provenance', () => {
    // A converged retry returns the success info directly — the shared cleared /
    // convergence path already ran, so NO install-failure capture happens.
    expect(cli).toContain('ManagedRetryAttempt::Converged(info) => return Ok(info)');
    // The original user-path report carries managed_toolchain_retry=false, but a
    // real managed retry now carries true. (Assert on the tokens rather than an
    // exact call layout so rustfmt reflow can't defeat it.)
    expect(cli).toContain(
      'probe_install_environment(&npm, &path, /* managed_toolchain_retry */ false)',
    );
    expect(cli).toContain('/* managed_toolchain_retry */ true');
    expect(retryHelper).toContain('&managed_npm');
    expect(retryHelper).toContain('&managed_path');
    // A failed managed retry uses provenance-aware wording, NEVER the user-path
    // builder (which advises installing Node 22).
    expect(retryHelper).toContain('managed_retry_failure_detail(');
    expect(cli).toContain('fn managed_retry_failure_detail(');
  });

  it('reuses the pinned version on the retry — never re-resolving @latest', () => {
    // The retry re-runs against the SAME pinned `latest`; it must not call
    // fetch_latest() again mid-episode.
    expect(retryHelper).toContain('Some(latest)');
    expect(retryHelper).not.toContain('fetch_latest');
  });

  it('also self-heals an unsupported user Node, sharing one floor across lanes (HQ-DESKTOP-56)', () => {
    // A PATH Node below the CLI's floor is a user-path runtime HQ's managed Node
    // 22 can actually run, so it arms the SAME one-shot repair as the lifecycle
    // shape — not a second installer.
    expect(cli).toContain('kind == InstallFailureKind::UnsupportedNode');
    // It rides the two shared runtime conditions (user-path + a failing ABI that
    // differs from the managed one), so a managed run never retries into itself.
    expect(cli).toContain('source == NpmToolchainSource::UserPath');
    expect(cli).toContain('failing_node_abi != Some(MANAGED_NODE_ABI)');
    // Still exactly one provision call in the whole module — no second installer.
    expect(occurrences(cli, 'repair_managed_node(')).toBe(1);
    // The failure path classifies WITH the probed environment (so the new kind is
    // reachable) and shows the environment-aware copy, never the raw parse error.
    expect(cli).toContain('classify_install_failure_with_environment(');
    expect(cli).toContain('install_failure_detail_with_environment(');
    // The Sync-lane preflight and the CLI-updater classifier share ONE floor,
    // sourced from hq-desktop-core, so they can never drift apart.
    expect(syncRs).toContain('hq_desktop_core::hq_cli_update::MIN_NODE_MAJOR');
  });
});

/**
 * HQ-DESKTOP-5B / HQ-DESKTOP-5C — the same auto-updater path, two failure legs
 * that this cluster's telemetry showed re-paging on every 6-hourly check:
 *
 *   5B (ENOTEMPTY:rename:global-lib-node-modules): an interrupted global install
 *   left `hq-cli`/`.hq-cli-*` debris under `<...>/node_modules/@indigoai-us`, so
 *   every later install's rename-aside failed ENOTEMPTY. The app already owned
 *   the remedy, but it was gated behind a resolved prefix — None in 61/61 events
 *   — so the else arm skipped it forever. The rung now recovers the scope from
 *   the absolute path npm itself named when no prefix resolves, with the deletion
 *   still confined to the `hq-cli` + `.hq-cli-*` children.
 *
 *   5C (EIDLETIMEOUT:unknown:none): a registry socket idle timeout — a transient
 *   network flake — was paged at Error only because its code was missing from the
 *   transient allow-list beside its five siblings.
 *
 * Source-contract harness, same style as the self-provision spec above.
 */
describe('hq-CLI updater recovers a prefix-less ENOTEMPTY wedge and absorbs a registry idle timeout (HQ-DESKTOP-5B/5C)', () => {
  const cli = readRepoFile('src-tauri/src/commands/hq_cli_update.rs');
  const core = readRepoFile('../../crates/hq-desktop-core/src/hq_cli_update.rs');

  it('resolves the ENOTEMPTY cleanup scope from the npm-reported path when no prefix resolved', () => {
    // Prefix-derived scope first; npm-path-derived scope only when none resolved.
    expect(cli).toContain('partial_install_scope_dir(cleanup_prefix)');
    expect(cli).toContain('partial_install_scope_from_npm_path(&detail)');
    expect(cli).toContain('"cleanup-plain-npm-path"');
    // The npm-path derivation is a pure, fail-closed core helper that requires an
    // exact `node_modules/@indigoai-us` component pair.
    expect(core).toContain('pub fn partial_install_scope_from_npm_path(');
    expect(core).toContain('components[index - 1] == "node_modules"');
  });

  it('keeps the deletion set confined to `hq-cli` and `.hq-cli-*` via one shared cleaner', () => {
    // Both scope sources delete through the ONE scope-taking cleaner, whose set is
    // exactly the `hq-cli` package dir and any `.hq-cli-*` staging dir — never the
    // scope directory itself, never a sibling package.
    expect(cli).toContain('fn clean_partial_hq_cli_install_scope(scope: &Path)');
    expect(cli).toContain('clean_partial_hq_cli_install_scope(&scope)');
    expect(cli).toContain('scope.join("hq-cli")');
    expect(cli).toContain('.starts_with(".hq-cli-")');
  });

  it('absorbs an EIDLETIMEOUT registry idle timeout like its transient siblings (HQ-DESKTOP-5C)', () => {
    expect(core).toContain('fn is_expected_transient_registry_failure(');
    expect(core).toContain('"EIDLETIMEOUT"');
  });
});

/**
 * HQ-DESKTOP-3P — the hq-CLI VERSION PROBE self-provisions/reuses HQ's managed
 * Node before reporting a resolved-but-unreadable CLI forever.
 *
 * The reopened field events (macOS, release 0.10.147) carried the quadruple
 * {binary_anchor: package_not_found, hq_version: interpreter_not_found,
 * npm_root: not_attempted, resolved_program_kind: exe}: a resolved `hq` shim
 * whose `#!/usr/bin/env node` interpreter is undiscoverable, so every probe
 * fails and `should_report_unreadable_version` fires on every 6h check. HQ owns
 * a checksum-verified managed Node the probe simply never fell back to.
 *
 * Same source-contract style — no built binary; runs in the scripted
 * "Desktop-alt E2E" CI job.
 */
describe('hq-CLI version probe recovers an unreadable CLI through the managed Node (HQ-DESKTOP-3P)', () => {
  const cli = readRepoFile('src-tauri/src/commands/hq_cli_update.rs');
  const core = readRepoFile('../../crates/hq-desktop-core/src/hq_cli_update.rs');
  const pathsCore = readRepoFile('../../crates/hq-desktop-core/src/paths.rs');

  const occurrences = (haystack: string, needle: string) =>
    haystack.split(needle).length - 1;

  // The re-probe helper body, sliced so "bounded to one provision + one re-probe"
  // cannot be satisfied by unrelated code elsewhere in the file.
  const recoverHelper = cli.slice(
    cli.indexOf('async fn recover_unreadable_version_once('),
    cli.indexOf('/// The ONE call into the managed-Node provisioning seam'),
  );

  it('gives the core version probe a managed-Node interpreter fallback', () => {
    // A present managed Node is retried by prepending its bin dir to the child
    // PATH, and — for a node-shebanged shim — invoked directly.
    expect(core).toContain('fn hq_version_with_recovery(');
    expect(core).toContain('paths::path_with_interpreter_hint(');
    expect(core).toContain('fn managed_node_executable(');
    expect(core).toContain('fn shebang_names_node(');
    expect(core).toContain('InterpreterRecovery::RecoveredWithManagedNode');
    // The widened child PATH searches beyond nvm, and the hint helper + the new
    // resolution-source enum live in paths.rs.
    expect(pathsCore).toContain('fn node_version_manager_dirs(');
    expect(pathsCore).toContain('.join(".fnm")');
    expect(pathsCore).toContain('pub fn path_with_interpreter_hint(');
    expect(pathsCore).toContain('pub enum ResolutionSource');
  });

  it('reuses repair_managed_node once and re-probes once — never a second installer, never a loop', () => {
    // Exactly one provision (the shared seam) and one re-probe inside the helper.
    expect(occurrences(recoverHelper, 'request_managed_node_repair(app).await')).toBe(1);
    expect(occurrences(recoverHelper, 'get_local_version_diagnostics()')).toBe(1);
    // No second installer, no retry loop.
    expect(recoverHelper).not.toContain('repair_managed_node(');
    expect(recoverHelper).not.toContain('loop {');
    expect(recoverHelper).not.toContain('while ');
    // Only an HQ-owned gap (unprovisioned/incomplete) is provisioned here.
    expect(recoverHelper).toContain(
      'ManagedRuntime::NotProvisioned | ManagedRuntime::Incomplete',
    );
    // And ONLY for an undiscoverable interpreter — a genuinely broken CLI
    // (nonzero exit / empty output) is never provisioned for.
    expect(recoverHelper).toContain(
      'interpreter_recovery != InterpreterRecovery::ManagedNodeAbsent',
    );
  });

  it('reports only after recovery has failed', () => {
    // The provision + re-probe runs BEFORE the unreadable-version report in the
    // check flow, so a recovered version emits no event.
    const recoverAt = cli.indexOf('recover_unreadable_version_once(app, local_version).await');
    const reportAt = cli.indexOf('report_unreadable_version(&latest, &local_version.probes)');
    expect(recoverAt).toBeGreaterThan(0);
    expect(reportAt).toBeGreaterThan(0);
    expect(recoverAt).toBeLessThan(reportAt);
  });
});

/**
 * HQ-DESKTOP-5K — the same auto-updater path, a new failure leg: on a Windows
 * machine whose npm global prefix directory chain does not exist,
 * `npm i -g @indigoai-us/hq-cli@latest` dies with `code ENOENT` / `syscall mkdir`
 * at a global-install path before it can lay the package down, so the user's CLI
 * silently never updates and the failure self-suppresses under the `unexpected`
 * repeat-guard. HQ now (1) classifies the shape under its OWN bounded group at
 * Warning, (2) CREATES the missing install-target directory and retries once
 * (creation-only, the mirror image of the ENOTEMPTY cleanup), and (3) escalates to
 * the SAME one-shot managed-toolchain retry — which installs into HQ's own managed
 * prefix — before ever blaming the user's toolchain.
 *
 * Source-contract harness, same style as the specs above.
 */
describe('hq-CLI updater creates a missing npm global install target and escalates to the managed prefix (HQ-DESKTOP-5K)', () => {
  const cli = readRepoFile('src-tauri/src/commands/hq_cli_update.rs');
  const core = readRepoFile('../../crates/hq-desktop-core/src/hq_cli_update.rs');

  const occurrences = (haystack: string, needle: string) =>
    haystack.split(needle).length - 1;

  // The mkdir remedy block inside run_npm_install_with_retries, sliced so the
  // "creates and never deletes / bounded to one retry" assertions cannot be
  // satisfied by unrelated code (the ENOTEMPTY cleaner above legitimately deletes).
  const mkdirRemedy = cli.slice(
    cli.indexOf('// ENOENT missing-global-install-target recovery (HQ-DESKTOP-5K)'),
    cli.indexOf('// Windows EPERM locked-binary recovery (HQ-DESKTOP-3N)'),
  );

  it('classifies the shape on npm`s own code + syscall, under its own bounded group', () => {
    // A narrow predicate keyed on npm's OWN structured signals — never a bare
    // `detail.contains("ENOENT")` — so it cannot swallow a lifecycle build failure.
    expect(core).toContain('pub fn is_missing_global_install_target(');
    expect(core).toContain('npm_error_code(detail) == "ENOENT"');
    expect(core).toContain('npm_syscall(detail) == "mkdir"');
    expect(core).toContain('!has_npm_lifecycle_failure_marker(detail)');
    // Its own fingerprint component — it leaves the `unexpected` catch-all group.
    expect(core).toContain(
      'Self::MissingGlobalInstallTarget => "missing-global-install-target"',
    );
  });

  it('creates the missing install-target directory off the async runtime and retries — creation only, no delete, no loop', () => {
    // The remedy is armed by the same predicate and derives its scope through the
    // shared fail-closed helpers (resolved prefix first, else npm's own path).
    expect(mkdirRemedy).toContain('is_missing_global_install_target(&detail, prefix)');
    expect(mkdirRemedy).toContain(
      'missing_install_target_scope(prefix, &detail, cfg!(target_os = "windows"))',
    );
    // The probe + create runs OFF the Tokio worker (an offline UNC / dead drive can
    // block the metadata calls), on the blocking pool like the surrounding npm work.
    expect(mkdirRemedy).toContain('spawn_blocking');
    expect(mkdirRemedy).toContain('create_missing_install_scope(&scope_for_create)');
    // CREATION ONLY: the remedy never deletes (its blast radius is strictly smaller
    // than the ENOTEMPTY cleanup), and it never loops.
    expect(mkdirRemedy).not.toContain('remove_dir_all');
    expect(mkdirRemedy).not.toMatch(/\b(loop|while)\b/);
    // Bounded: a plain retry after creating the scope, plus — only if that newly
    // exposes a stale-shim EEXIST — one --force collision retry, mirroring the
    // ENOTEMPTY rung. Both attempts are gated by the hard MAX_NPM_INSTALL_ATTEMPTS cap.
    expect(occurrences(mkdirRemedy, 'run_recorded_npm_install_attempt(')).toBe(2);
    expect(mkdirRemedy).toContain('is_bin_exists_failure(&npm_output_detail(&output), prefix)');
    expect(mkdirRemedy).toContain('"mkdir-forced-bin-collision"');
    expect(occurrences(mkdirRemedy, 'ledger.len() < MAX_NPM_INSTALL_ATTEMPTS')).toBe(2);

    // The scope resolver is pure (prefix-derived, else the fail-closed npm-path
    // helper) and the creator uses create_dir_all and never a deletion.
    expect(cli).toContain('fn missing_install_target_scope(');
    expect(cli).toContain('partial_install_scope_dir_for(target_prefix, windows_layout)');
    expect(cli).toContain('partial_install_scope_from_npm_path(detail)');
    expect(cli).toContain('"mkdir-plain-npm-path"');
    const createScope = cli.slice(
      cli.indexOf('fn create_missing_install_scope('),
      cli.indexOf('/// Spawn `npm <args>` on the blocking pool'),
    );
    expect(createScope).toContain('std::fs::create_dir_all(scope)');
    expect(createScope).not.toContain('remove_dir_all');
  });

  it('escalates to the SAME one-shot managed-toolchain retry — no second installer', () => {
    // The new kind arms the existing managed retry, gated only on user-path (the
    // ABI clause deliberately does not apply — the managed retry installs into HQ's
    // OWN prefix, so it repairs the machine even at the identical managed ABI).
    expect(cli).toContain('kind == InstallFailureKind::MissingGlobalInstallTarget');
    expect(cli).toContain('is_user_path && missing_global_install_target');
    // Still exactly one provision call in the whole updater module — the escalation
    // REUSES managed_toolchain_retry; it does not add a second installer.
    expect(occurrences(cli, 'repair_managed_node(')).toBe(1);
    // And that retry still routes into HQ's own managed npm prefix.
    expect(cli).toContain('paths::managed_npm_prefix_in(&root)');
  });
});
