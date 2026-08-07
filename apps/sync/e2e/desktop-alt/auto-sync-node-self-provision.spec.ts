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
      daemonRs.indexOf('if bail.failure == PreflightFailure::NodeUnprovisioned'),
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
    expect(daemonRs).toContain('fn provisioning_bail_to_report(outcome: Result<(), String>)');
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
});
