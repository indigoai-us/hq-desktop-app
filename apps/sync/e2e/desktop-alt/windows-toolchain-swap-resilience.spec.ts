import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * HQ-DESKTOP-5N / HQ-DESKTOP-5P — the managed-toolchain directory swap on
 * Windows died on the first ERROR_ACCESS_DENIED (os error 5).
 *
 * Two production machines on hq-sync-win@0.10.150 reported:
 *
 *   HQ tried to install its Node runtime and could not: backup existing
 *   C:\...\IndigoHQ\toolchain\node -> C:\...\.node.bak.<uuid> failed:
 *   Access is denied. (os error 5)                                    (5N)
 *
 *   HQ tried to install its Node runtime and could not: remove backup
 *   C:\...\.node.bak.<uuid> failed: Access is denied. (os error 5)    (5P)
 *
 * `atomic_replace_dir` did exactly three std::fs calls, each once, each `?` on
 * the first error. A transient open handle (AV/EDR or Search-indexer scan of a
 * just-extracted tree, a CWD inside it, Controlled Folder Access, a still-mapped
 * node.exe) was terminal: no retry, no cleanup of the validated staged tree, and
 * — worse for 5P — a backup that could not be deleted AFTER the new tree was
 * already live turned a COMPLETED install into a paging ProvisionAttempt::Failed
 * that burned the shared 15-minute repair slot.
 *
 * The download leg was already hardened with a bounded retry (HQ-DESKTOP-5A);
 * this locks the same treatment onto the activation leg. Source-contract
 * harness, same style as auto-sync-node-self-provision.spec.ts: it runs inside
 * the scripted "Desktop-alt E2E" CI job with no built binary. The Rust-level
 * proof of the same contract lives in the unit tests these assertions name
 * (rust-macos lane) and the real-handle artifact E2E (windows-check lane).
 */

describe('The managed-toolchain swap rides out a transient handle instead of dying on it (HQ-DESKTOP-5N/5P)', () => {
  const installDepsRs = readRepoFile('src-tauri/src/commands/install_deps.rs');
  const syncRs = readRepoFile('src-tauri/src/commands/sync.rs');

  it('gives every swap rename a bounded retry, modelled on the download leg', () => {
    expect(installDepsRs).toContain('const SWAP_ATTEMPTS');
    expect(installDepsRs).toContain('const SWAP_BACKOFF');
    expect(installDepsRs).toContain('fn swap_backoff(');
    // The retry driver + its retryability predicate, fed REAL io::Error values.
    expect(installDepsRs).toContain('fn retry_swap_op');
    expect(installDepsRs).toContain('fn is_retryable_swap_error(');
    expect(installDepsRs).toContain('enum SwapPhase');
  });

  it('retries only the codes an open handle actually produces', () => {
    // ERROR_ACCESS_DENIED / SHARING_VIOLATION / LOCK_VIOLATION / DIR_NOT_EMPTY,
    // plus unix EACCES via PermissionDenied; NotFound is terminal.
    const pred = installDepsRs.slice(
      installDepsRs.indexOf('fn is_retryable_swap_error('),
      installDepsRs.indexOf('struct SwapError'),
    );
    expect(pred).toBeTruthy();
    expect(pred).toContain('ErrorKind::NotFound');
    expect(pred).toContain('ErrorKind::PermissionDenied');
    expect(pred).toContain('Some(5) | Some(32) | Some(33) | Some(145)');
  });

  it('preserves the leading Sentry shape and appends a structured attribution suffix', () => {
    // The head stays byte-stable so the fingerprint does not shatter; the suffix
    // is what makes the next occurrence self-diagnosing (phase / os code /
    // attempts / elapsed / observed target state) — the ambiguity the single
    // message could not carry.
    expect(installDepsRs).toContain('backup existing {} -> {} failed:');
    expect(installDepsRs).toContain('phase={}');
    expect(installDepsRs).toContain('os_error={}');
    expect(installDepsRs).toContain('target_state={}');
    expect(installDepsRs).toContain('fn describe_target_state(');
  });

  it('never lets cleanup fail a completed install (HQ-DESKTOP-5P)', () => {
    // The old code returned Err("remove backup ... failed") even though the new
    // tree was already live. That message — and its `?` — are gone; a cleanup
    // failure is now retried, logged, and swallowed.
    expect(installDepsRs).not.toContain('remove backup {} failed');
    expect(installDepsRs).toContain('left for sweep');
  });

  it('never strands the validated staged tree and sweeps old debris', () => {
    // The bare `atomic_replace_dir(&staged_node_dir, &node_dir)?;` that stranded
    // a ~35 MB extracted tree on failure is replaced by activate_staged_dir,
    // which cleans up on terminal failure like every other error arm.
    expect(installDepsRs).not.toContain('atomic_replace_dir(&staged_node_dir, &node_dir)?');
    expect(installDepsRs).toContain('fn activate_staged_dir(');
    expect(installDepsRs).toContain('activate_staged_dir(&staged_node_dir, &node_dir)');
    // A best-effort, age-bounded sweep so repeated repairs cannot accumulate.
    expect(installDepsRs).toContain('fn sweep_stale_toolchain_siblings(');
    expect(installDepsRs).toContain('fn is_stale_toolchain_sibling(');
    expect(installDepsRs).toContain('sweep_stale_toolchain_siblings(&target');
  });

  it('accepts an already-provisioned managed Node rather than fighting the swap', () => {
    // The repair slot is a process-local static and cannot serialize two HQ
    // processes, so a target that appeared between preflight and swap is real.
    // Gated on the SAME version check the staged tree passed.
    expect(installDepsRs).toContain('fn managed_node_already_usable');
    expect(installDepsRs).toContain('managed_node_already_usable(&node_exe');
    expect(installDepsRs).toContain('ensure_node_version(exe, version).is_ok()');
  });

  it('keeps the whole retry budget strictly inside the shared repair slot', () => {
    // No unbounded wait: the extended budget invariant now also proves the swap
    // backoff plus the download budget stays under the 15-minute cooldown.
    expect(syncRs).toContain('pub(crate) const TOOLCHAIN_REPAIR_COOLDOWN');
    expect(installDepsRs).toContain('worst_case + swap_budget');
  });

  it('names the Rust proofs so they cannot be deleted without turning this spec red', () => {
    // rust-macos lane (`cargo test --locked`) — platform-neutral helpers.
    for (const name of [
      'fn is_retryable_swap_error_classifies_real_io_errors',
      'fn the_swap_budget_stays_inside_the_repair_slot',
      'fn a_transient_rename_denial_is_retried_until_the_swap_succeeds',
      'fn a_persistent_rename_denial_fails_terminally_within_the_budget',
      'fn a_failed_swap_never_strands_the_staged_install',
      'fn a_backup_that_cannot_be_removed_does_not_fail_a_completed_install',
      'fn a_non_directory_target_is_replaced_rather_than_backed_up_forever',
      'fn an_already_provisioned_managed_node_short_circuits_the_swap',
      'fn the_restore_path_is_retried_too',
    ]) {
      expect(installDepsRs).toContain(name);
    }
    // The existing download budget test, now extended with the swap budget.
    expect(installDepsRs).toContain('fn the_total_download_budget_stays_inside_the_repair_slot');
    // windows-check lane — the real open-handle artifact E2E.
    expect(installDepsRs).toContain('mod toolchain_swap_e2e_tests');
    expect(installDepsRs).toContain(
      'fn a_real_open_handle_denies_the_swap_then_a_release_lets_it_complete',
    );
    expect(installDepsRs).toContain(
      'fn a_handle_held_for_the_whole_budget_fails_terminally_and_cleans_up',
    );
  });
});
