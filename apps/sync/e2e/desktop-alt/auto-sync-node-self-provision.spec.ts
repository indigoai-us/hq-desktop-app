import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * HQ-SYNC-BA — the auto-sync watcher on a Mac with no Node runtime at all.
 *
 * Two real Macs (macOS 26.5.x, hq-sync@0.8.33) reported:
 *
 *   HQ Sync can't start the sync engine — Node.js wasn't found on this Mac.
 *   Install Node 20 or newer (https://nodejs.org), then reopen HQ Sync.
 *
 * tagged `path=(auto-sync)`. These are legacy installs that predate HQ's
 * managed toolchain and never ran the deps wizard, so `toolchain::classify()`
 * answers `NotProvisioned` — and `missing_node()` deliberately returns `None`
 * for that state, so the node preflight failed OPEN, fell through to the
 * runner-resolution preflight, and told the user to go install Node by hand.
 * HQ ships a checksum-verified Node installer; nothing reached it from this
 * lane, so those installs could never start sync again.
 *
 * HQ-DESKTOP-49 (#331) fixed the equivalent gap on the Connect path only —
 * see connect-node-self-provision.spec.ts. This spec locks the same contract
 * for the auto-sync watcher:
 *
 *   1. "No Node anywhere and HQ never installed one" is classified as a
 *      repairable provisioning gap, not as usable.
 *   2. Only a POSITIVE diagnosis provisions; every uncertain probe result
 *      keeps the old fail-open behaviour.
 *   3. The daemon never holds its singleton guard across a network install.
 *   4. A SUCCESSFUL self-heal is silent — it must not page #hq-alerts and must
 *      not advance the rate-limiting failure counter.
 *   5. The terminal "install Node 20 yourself" instruction is never what this
 *      state surfaces.
 *
 * Source-contract harness, same style as connect-node-self-provision.spec.ts:
 * it runs inside the existing scripted "Desktop-alt E2E" CI job with no built
 * binary. The Rust-level proof of the same contract lives in the unit tests
 * these assertions name.
 */

describe('Auto-sync self-provisions HQ-managed Node instead of blaming the user (HQ-SYNC-BA)', () => {
  const syncRs = readRepoFile('src-tauri/src/commands/sync.rs');
  const daemonRs = readRepoFile('src-tauri/src/commands/daemon.rs');
  const installDepsRs = readRepoFile('src-tauri/src/commands/install_deps.rs');

  it('classifies "no Node anywhere, none ever provisioned" as repairable, not usable', () => {
    // The base behaviour this replaces returned NodePreflight::Usable here and
    // was pinned by `an_unprobeable_node_with_no_managed_runtime_is_usable`.
    expect(syncRs).toContain('NodeUnprovisioned');
    expect(syncRs).toContain('fn no_node_anywhere_is_a_repairable_provisioning_gap');
    expect(syncRs).not.toContain('fn an_unprobeable_node_with_no_managed_runtime_is_usable');
  });

  it('provisions only on a positive diagnosis and stays fail-open otherwise', () => {
    // Exit 127 / ENOENT is the only proof a runtime is absent rather than
    // merely unavailable to this probe (sandboxed spawn, EPERM, fork failure).
    expect(syncRs).toContain('RunnerResolution::Indeterminate');
    expect(syncRs).toContain('node_resolution == RunnerResolution::Missing');
    expect(syncRs).toContain('npx_resolution == RunnerResolution::Missing');
    expect(syncRs).toContain('matches!(toolchain, ManagedToolchain::NotProvisioned)');
    expect(syncRs).toContain('fn indeterminate_probe_results_stay_fail_open');
    expect(syncRs).toContain('fn probe_errors_are_indeterminate_not_missing');
    // A modern system Node short-circuits before any provisioning decision, so
    // a healthy machine can never be sent to the installer.
    expect(syncRs).toContain('fn a_modern_node_is_usable_whatever_the_toolchain_looks_like');
  });

  it('reuses the one installer and its cooldown rather than adding a second', () => {
    expect(syncRs).toContain('fn provision_unprovisioned_node');
    expect(syncRs).toContain('repair_managed_node(app).await');
    expect(daemonRs).not.toContain('install_deps::install_node');
    // The shared 15-minute slot is what bounds a machine that can never
    // install (offline, MDM-locked, no disk) against the 30s supervisor cadence.
    expect(syncRs).toContain('claim_repair_slot(TOOLCHAIN_REPAIR_COOLDOWN)');
    expect(syncRs).toContain('fn the_shared_cooldown_bounds_a_machine_that_cannot_install');
  });

  it('never holds the daemon singleton across a network install', () => {
    const arm = daemonRs.slice(
      daemonRs.indexOf(
        'PreflightFailure::NodeUnprovisioned | PreflightFailure::NodeTooOld',
      ),
      daemonRs.indexOf('report_preflight_bail(bail.failure, &bail.message);'),
    );
    expect(arm).toBeTruthy();
    // Guard released and lifecycle parked in Backoff/Preflight BEFORE the
    // spawn, so the supervisor's next cadence can retry. Matched without its
    // arguments: HQ-DESKTOP-3J made the release generation-scoped, and what
    // this locks is the ordering, not the parameter list.
    const released = arm.indexOf('release_daemon_guard(');
    expect(released).toBeGreaterThan(-1);
    expect(released).toBeLessThan(arm.indexOf('tauri::async_runtime::spawn'));
    expect(arm).toContain(
      'set_lifecycle_state(WatchDaemonState::Backoff, DaemonFailureCategory::Preflight)',
    );
  });

  it('is SILENT when the self-heal works, and only pages when it does not', () => {
    // The defect this locks out: reporting both outcomes would send
    // sentry::Level::Error on the fix WORKING, and would advance the
    // consecutive-failure counter should_capture_crash rate-limits on — so a
    // fleet HQ healed would suppress alerts for machines it could not heal.
    //
    // The seam now takes the three-way ProvisionAttempt, not the Result<(),
    // String> that could not tell a cooldown deferral from a repair failure —
    // that conflation was HQ-DESKTOP-4Z. Naming the new type is strictly
    // stronger than the old signature it replaces.
    expect(daemonRs).toContain('fn provisioning_bail_to_report(outcome: ProvisionAttempt)');
    expect(daemonRs).toContain('fn a_successful_self_provision_is_not_a_preflight_failure');
    expect(daemonRs).toContain('fn a_failed_self_provision_still_reports_its_reason');
    // Failure is still alertable, and still rate-limited.
    expect(daemonRs).toContain(
      'PreflightFailure::ManagedNodeMissing | PreflightFailure::NodeUnprovisioned',
    );
    // The user's own environment must not resume flooding #hq-alerts.
    expect(daemonRs).toContain(
      'PreflightFailure::RunnerUnresolvable | PreflightFailure::NodeTooOld',
    );
    expect(daemonRs).toContain('fn each_preflight_failure_has_an_explicit_capture_policy');
  });

  it('treats the shared-slot cooldown as a deferral, not a failure (HQ-DESKTOP-4Z)', () => {
    // The reported alert: the auto-sync daemon captured the 15-minute Node
    // repair-slot cooldown — a deliberate single-flight deferral (another lane
    // is already installing) — to Sentry at Level::Error as "auto-sync watcher
    // cannot start (NodeUnprovisioned)". The fix keeps the deferral distinct
    // from a genuine repair failure end to end.

    // sync.rs produces a three-way outcome; a Skipped repair maps to Deferred,
    // never Failed, and start_sync still collapses both to its popover bail.
    expect(syncRs).toContain('enum ProvisionAttempt');
    expect(syncRs).toContain('Deferred(String)');
    expect(syncRs).toContain('fn provision_attempt(');
    expect(syncRs).toContain('ToolchainRepair::Skipped => ProvisionAttempt::Deferred');
    expect(syncRs).toContain('fn into_start_sync_result');
    expect(syncRs).toContain(
      'fn the_three_repair_arms_map_to_three_distinct_provision_attempts',
    );

    // daemon.rs consumes the new type. Only Failed is Some(...) — the arm that
    // reaches report_preflight_bail, which is the ONLY caller of
    // note_runner_preflight_failure and capture_sync_error on this seam.
    expect(daemonRs).toContain('fn report_provisioning_outcome(outcome: ProvisionAttempt)');
    const bailFn = daemonRs.slice(
      daemonRs.indexOf('fn provisioning_bail_to_report(outcome: ProvisionAttempt)'),
      daemonRs.indexOf('fn report_provisioning_outcome(outcome: ProvisionAttempt)'),
    );
    expect(bailFn).toBeTruthy();
    expect(bailFn).toContain(
      'ProvisionAttempt::Provisioned | ProvisionAttempt::Deferred(_) => None',
    );
    expect(bailFn).toContain('ProvisionAttempt::Failed(reason) => Some(reason)');

    // So a Deferred (like a Provisioned) reaches neither the rate-limiting
    // streak nor a capture: report_provisioning_outcome touches neither
    // note_runner_preflight_failure nor capture_sync_error directly — both live
    // behind the Failed-only report_preflight_bail call.
    const reportFn = daemonRs.slice(
      daemonRs.indexOf('fn report_provisioning_outcome(outcome: ProvisionAttempt)'),
      daemonRs.indexOf('fn report_preflight_bail('),
    );
    expect(reportFn).toBeTruthy();
    expect(reportFn).not.toContain('note_runner_preflight_failure');
    expect(reportFn).not.toContain('capture_sync_error');

    // The Rust regression proof of the deferral contract lives in this test.
    expect(daemonRs).toContain(
      'fn a_cooldown_deferral_is_not_a_preflight_failure_and_does_not_advance_the_streak',
    );
  });

  it('self-provisions when the only Node is too old, not just when Node is missing', () => {
    // Screenshot regression: Node 14 counted as "installed", so the installer
    // skipped HQ's Node 22 and Sync bailed with "needs Node 20 or newer".
    // TooOld is now the same repair as Unprovisioned.
    expect(syncRs).toContain('too old — provisioning HQ managed Node');
    expect(syncRs).toContain('fn too_old_preflight_asks_hq_to_install_not_the_user');
    expect(syncRs).toContain('fn node_too_old_provisioning_message');
    expect(installDepsRs).toContain('fn an_old_system_node_does_not_satisfy_the_node_dep');
    expect(daemonRs).toContain(
      'PreflightFailure::NodeUnprovisioned | PreflightFailure::NodeTooOld',
    );
  });

  it('never tells the user to install Node for a state HQ can repair', () => {
    // The reported 0.8.33 string still exists — it is the correct message for
    // a genuinely unresolvable runner — but it must not be what the
    // provisioning state surfaces.
    expect(syncRs).toContain('Install Node 20 or newer (https://nodejs.org)');
    const unprovisionedMessage = syncRs.slice(
      syncRs.indexOf('fn node_unprovisioned_message()'),
      syncRs.indexOf('fn runner_unresolvable_reason'),
    );
    expect(unprovisionedMessage).toContain('installing its managed Node.js runtime');
    expect(unprovisionedMessage).not.toContain('nodejs.org');
    expect(syncRs).toContain('fn every_provisioning_outcome_is_distinct_and_never_blames_the_user');
    expect(syncRs).toContain(
      'fn failed_first_time_provisioning_is_honest_and_not_manual_install_guidance',
    );
  });

  it('keeps the managed Node download pinned and origin-locked in shipped builds', () => {
    // HQ_NODE_DIST_URL is a debug-only test seam; a release build must not take
    // its download origin from the process environment.
    expect(installDepsRs).toContain('fn managed_node_dist_base()');
    expect(installDepsRs).toContain('#[cfg(debug_assertions)]');
    expect(installDepsRs).toContain(
      'fn the_distribution_override_is_debug_only_and_never_moves_the_checksum',
    );
    // And no arch may be downloadable without a pinned SHA-256 to verify it.
    expect(installDepsRs).toContain(
      'fn every_installable_arch_has_a_pinned_checksum_whatever_the_dist_base_is',
    );
    expect(installDepsRs).toContain('[node] checksum verification failed');
  });

  it('retries a transient managed-Node download instead of dying on the first blip (HQ-DESKTOP-5A)', () => {
    // The shipped helper made exactly ONE attempt with a default reqwest
    // blocking client (30s total timeout), so one transient blip on the
    // 34.87 MB Node zip became a 15-minute NodeUnprovisioned outage plus an
    // #hq-alerts page. The fix gives the shared asset fetch a bounded retry
    // with explicit per-attempt timeouts and a real cause chain.

    // The single-shot getter with its undeclared 30s cap is gone.
    expect(installDepsRs).not.toContain('reqwest::blocking::get(');

    // Bounded retry + explicit connect/read timeouts as named constants.
    expect(installDepsRs).toContain('const DOWNLOAD_ATTEMPTS');
    expect(installDepsRs).toContain('const DOWNLOAD_ATTEMPT_TIMEOUT');
    expect(installDepsRs).toContain('const DOWNLOAD_CONNECT_TIMEOUT');
    expect(installDepsRs).toContain('.connect_timeout(DOWNLOAD_CONNECT_TIMEOUT)');
    expect(installDepsRs).toContain('.timeout(DOWNLOAD_ATTEMPT_TIMEOUT)');

    // The fetch closure is retryable (FnMut), not the one-shot FnOnce.
    expect(installDepsRs).toContain('F: FnMut(&str) -> Result<DownloadedAsset, String>');

    // The causeless `{e}` Display is replaced by a source()-walking chain, so a
    // future occurrence names timeout vs reset instead of the bare
    // "error decoding response body", and it is wired into the Node-zip read.
    expect(installDepsRs).toContain('fn error_chain(');
    expect(installDepsRs).toContain('Failed to read {label} response: {}", error_chain(&e)');

    // A non-2xx returns its status to the classifier WITHOUT reading the body,
    // so a terminal 404/403 whose error body stalls behind a proxy cannot be
    // recast as a retryable read error and retried for ~560s.
    expect(installDepsRs).toContain('if !(200..=299).contains(&status)');

    // Checksum verify-then-activate on the Node zip is untouched.
    expect(installDepsRs).toContain('verify_sha256_bytes("Node zip", &bytes, expected_sha)');

    // The budget invariant is expressed against the real repair-slot cooldown,
    // which is now crate-visible for the assertion.
    expect(syncRs).toContain('pub(crate) const TOOLCHAIN_REPAIR_COOLDOWN');

    // The Rust regression proofs that windows-check.yml actually runs.
    expect(installDepsRs).toContain(
      'fn a_transient_download_failure_is_retried_and_can_succeed',
    );
    expect(installDepsRs).toContain(
      'fn download_retries_are_bounded_and_report_the_attempt_count',
    );
    expect(installDepsRs).toContain('fn a_terminal_http_status_is_not_retried');
    expect(installDepsRs).toContain(
      'fn the_total_download_budget_stays_inside_the_repair_slot',
    );
    expect(installDepsRs).toContain('fn a_download_failure_reports_its_cause_chain');
  });
});
