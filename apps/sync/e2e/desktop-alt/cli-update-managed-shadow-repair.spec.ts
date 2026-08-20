import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * HQ-DESKTOP-46 — the Windows managed-toolchain shadow (Sentry
 * `indigo-d0/hq-desktop/7644673293`, the `non_convergence_kind:foreign-managed`
 * slice).
 *
 * On Windows HQ's own managed toolchain can hold TWO HQ-owned copies of
 * `@indigoai-us/hq-cli`. The updater delivers `latest` into
 * `<root>\npm-prefix`, but the app executes a stale `<root>\node\hq.cmd`, so the
 * convergence gate misclassifies HQ's own layout as `foreign-managed` and writes
 * the durable marker that freezes auto-update for that release.
 *
 * The fix classifies that exact shape as `ManagedShadowed`, repairs it
 * (provenance-gated removal of the stale copy + re-resolve), and — because the
 * observed machines are ALREADY marker-blocked — also runs an install-free repair
 * on the blocked branch of the background loop.
 *
 * This spec locks the observable wiring in the same source-contract style as
 * cli-update-node-self-provision.spec.ts: it runs inside the scripted
 * "Desktop-alt E2E" CI job with no built binary. The pure logic (classification,
 * provenance-gated removal, the blocked-machine probe) is proved from the inside
 * by the Rust unit suites in crates/hq-desktop-core and crates/hq-telemetry; this
 * spec pins that BOTH crates are wired together and that the code-review fixes
 * (P1: per-shim provenance, P1: all-or-nothing package removal, P1: repair the
 * already-blocked population, P2: honest terminal copy) cannot silently regress.
 */
describe('hq-CLI updater classifies and repairs the HQ-owned managed-toolchain shadow (HQ-DESKTOP-46)', () => {
  const sync = readRepoFile('src-tauri/src/commands/hq_cli_update.rs');
  const core = readRepoFile('../../crates/hq-desktop-core/src/hq_cli_update.rs');

  const occurrences = (haystack: string, needle: string) =>
    haystack.split(needle).length - 1;

  // The removal routine, sliced so the "all-or-nothing" ordering assertions cannot
  // be satisfied by unrelated code elsewhere in the crate.
  const removal = core.slice(
    core.indexOf('pub fn remove_managed_shadow('),
    core.indexOf('fn remove_file_if_present('),
  );
  // The user-facing copy for a managed shadow.
  const detail = core.slice(
    core.indexOf('pub fn managed_shadow_detail('),
    core.indexOf('pub fn report_non_convergent_install('),
  );
  // The background loop's blocked branch, where an already-blocked machine now
  // gets an install-free repair.
  const backgroundLoop = sync.slice(
    sync.indexOf('pub fn setup_hq_cli_update_checker('),
    sync.length,
  );

  it('names the shape without disturbing any pre-existing telemetry string', () => {
    expect(core).toContain('ManagedShadowed');
    expect(core).toContain('Self::ManagedShadowed => "managed-shadowed"');
    // Every pre-existing NonConvergenceKind telemetry string stays byte-identical.
    for (const value of [
      '"npm-targeted"',
      '"pnpm-targeted"',
      '"bun-targeted"',
      '"foreign-managed"',
      '"resolution-shortfall"',
    ]) {
      expect(core).toContain(value);
    }
  });

  it('classifies purely, from an explicit managed-roots input and same-root containment', () => {
    // The classifier gains ONLY the managed_roots input and stays a pure path
    // comparison — no filesystem or environment read inside the decision.
    expect(core).toContain('fn non_convergence_kind(');
    expect(core).toContain('managed_roots: &[PathBuf]');
    expect(core).toContain('both_within_same_managed_root(passed, &active_prefix, managed_roots)');
    // The managed-shadow arm requires delivery evidence AND same-root containment,
    // so a cross-root or genuinely foreign layout still falls through to
    // ForeignManaged.
    expect(core).toContain('NonConvergenceKind::ManagedShadowed');
    // Path comparison is by components (case-insensitive on Windows), never raw
    // string equality.
    expect(core).toContain('fn path_components_equal(');
    expect(core).toContain('fn path_within(');
  });

  it('P1 — ties EACH shim to the hq-cli package before unlinking it', () => {
    // The manifest check alone (install_executor_for_hq_bin) passes when a foreign
    // tool has replaced hq.cmd while a stale package lingers; the shim-launch check
    // is the second, independent half.
    expect(core).toContain('fn shim_launches_hq_cli(');
    expect(core).toContain('fn shim_body_references_hq_cli(');
    // The provenance gate requires BOTH halves...
    expect(removal).toContain('|| !shim_launches_hq_cli(Path::new(shadow_hq_bin))');
    // ...and the removal loop skips any enumerated shim that does not launch hq-cli.
    expect(removal).toContain('if !shim_launches_hq_cli(&candidate) {');
  });

  it('P1 — removes the shared package ONLY when every hq-cli shim was removed cleanly', () => {
    // A shim-removal error (a Windows sharing violation while `hq` runs) must
    // suppress the package removal, so a surviving shim never resolves to a
    // deleted package.
    expect(removal).toContain('let mut shim_error: Option<String> = None;');
    expect(removal).toContain('if shim_error.is_none() {');
    // The package removal is guarded by that check: its directory enumeration
    // appears AFTER the `shim_error.is_none()` gate, not before.
    expect(removal.indexOf('if shim_error.is_none() {')).toBeGreaterThan(0);
    expect(removal.indexOf('.join("@indigoai-us")')).toBeGreaterThan(
      removal.indexOf('if shim_error.is_none() {'),
    );
    // Only the enumerated shims and the single scoped package are ever removed.
    expect(removal).toContain('for name in HQ_CLI_BIN_NAMES');
    expect(removal).toContain('.join("@indigoai-us")');
    expect(removal).toContain('.join("hq-cli")');
  });

  it('repairs the shadow through the shared convergence gate and re-resolves', () => {
    expect(sync).toContain('async fn finalize_managed_shadow(');
    expect(sync).toContain('remove_managed_shadow(&shadow, installed_prefix.as_deref(), &latest_owned, &roots)');
    // The gate re-resolves the binary the app EXECUTES after the repair — never
    // trusting delivery evidence alone — and routes the fresh reading back through
    // decide_post_install.
    expect(sync).toContain('let post_repair_hq = paths::resolve_bin("hq");');
    expect(sync).toContain('.with_shadow_repair(repair)');
    // The install target stays HQ's managed npm prefix; the repair never installs
    // into <toolchain>\node.
    expect(sync).toContain('paths::managed_npm_prefix_in(&root)');
  });

  it('P1 — repairs the ALREADY-blocked population the marker gate would skip', () => {
    // A subprocess-free, filesystem-only probe recognises the shadow shape...
    expect(core).toContain('pub fn resolved_bin_is_repairable_managed_shadow(');
    // ...and the blocked branch runs it BEFORE the install-free repair, so the
    // heavier convergence re-decide fires only when a shadow is actually present.
    expect(backgroundLoop).toContain('resolved_bin_is_repairable_managed_shadow(');
    expect(backgroundLoop).toContain('repair_managed_shadow_while_blocked(&handle, &info.latest)');
    expect(
      backgroundLoop.indexOf('resolved_bin_is_repairable_managed_shadow('),
    ).toBeLessThan(
      backgroundLoop.indexOf('repair_managed_shadow_while_blocked(&handle, &info.latest)'),
    );
    // The install-free repair reuses finalize_convergence with already_blocked=true,
    // so a converged repair clears the marker and a still-blocked one captures
    // nothing (no re-page) — it runs NO npm install.
    expect(sync).toContain('async fn repair_managed_shadow_while_blocked(');
    const blockedRepair = sync.slice(
      sync.indexOf('async fn repair_managed_shadow_while_blocked('),
      sync.indexOf('fn persist_reported_episode('),
    );
    expect(blockedRepair).toContain('/* already_blocked */ true');
    expect(blockedRepair).not.toContain('run_npm_install');
  });

  it('P2 — the terminal copy promises only the retry that actually happens', () => {
    // The false npm remedy ("managed outside npm's global prefix … update it with
    // the tool that installed it") must never appear in the managed-shadow copy —
    // HQ installed both copies.
    expect(detail).not.toContain("managed outside npm's global prefix");
    expect(detail).not.toContain('Update it with the tool that installed it');
    // A repair-failed / not-attempted machine is told the real remedy: the retry
    // runs automatically on the next check (the blocked-branch repair) and the
    // manual Update button bypasses the marker.
    expect(detail).toContain('click Update to retry now');
    expect(detail).toContain('managed toolchain');
  });

  it('tags residual events with a closed managed-shadow repair outcome and no new path tag', () => {
    expect(core).toContain('managed_shadow_repair');
    for (const value of [
      '"pending"',
      '"converged"',
      '"repair-failed"',
      '"provenance-refused"',
      '"not-attempted"',
    ]) {
      expect(core).toContain(value);
    }
    // Exactly one managed_shadow_repair tag is set on the report scope.
    expect(occurrences(core, 'scope.set_tag("managed_shadow_repair"')).toBe(1);
  });
});
