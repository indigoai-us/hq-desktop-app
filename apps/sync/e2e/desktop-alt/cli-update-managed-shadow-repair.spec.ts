import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * HQ-DESKTOP-46 (Windows managed-toolchain shadow) — the hq-CLI auto-updater on
 * a Windows machine whose HQ toolchain holds TWO HQ-owned copies of
 * `@indigoai-us/hq-cli`.
 *
 * The reported failures were real end-user auto-updates: the updater correctly
 * installed the new version into `%LOCALAPPDATA%\IndigoHQ\toolchain\npm-prefix`,
 * but `paths::resolve_bin("hq")` returned a stale shadow at
 * `%LOCALAPPDATA%\IndigoHQ\toolchain\node\hq.cmd`. The convergence gate saw an
 * unchanged version, misclassified HQ's OWN layout as `foreign-managed`, wrote
 * the durable marker that disables auto-update for that release, and showed the
 * user copy telling them to "update it with the tool that installed it" — false
 * and unactionable, because HQ installed both copies.
 *
 * This spec locks the observable wiring of the shadow self-heal, mirroring the
 * self-provision spec (cli-update-node-self-provision.spec.ts): a source-contract
 * harness that runs inside the scripted "Desktop-alt E2E" CI job with no built
 * binary. Its equivalent of "seed a stale shim + package in the managed node dir
 * and a current one in the managed npm prefix, run the update, and assert the app
 * resolves the npm-prefix copy, reports the new version, and clears the banner"
 * is proven at the unit/artifact layer (crates/hq-desktop-core repair + temp
 * toolchain tests, and crates/hq-telemetry capture/marker e2e); here it asserts
 * that the app-side updater actually WIRES that repair into the live install path.
 */

describe('hq-CLI updater removes an HQ-managed shadow instead of wedging (HQ-DESKTOP-46)', () => {
  const cli = readRepoFile('src-tauri/src/commands/hq_cli_update.rs');
  const core = readRepoFile('../../crates/hq-desktop-core/src/hq_cli_update.rs');

  const occurrences = (haystack: string, needle: string) =>
    haystack.split(needle).length - 1;

  // The repair helper body, sliced so the assertions cannot be satisfied by
  // unrelated code elsewhere in the file.
  const finalizeStart = cli.indexOf('async fn finalize_convergence(');
  const repairStart = cli.indexOf('async fn repair_managed_shadow_and_finalize(');
  const finalizeSlice = cli.slice(finalizeStart, repairStart);
  const repairSlice = cli.slice(repairStart, cli.indexOf('async fn ', repairStart + 1));

  it('names the shape as its own kind, not foreign-managed', () => {
    // A distinct classification is what lets the machine be repaired instead of
    // wedged with the misleading foreign-managed remedy.
    expect(core).toContain('ManagedShadowed');
    expect(core).toContain('"managed-shadowed"');
    // Every pre-existing kind keeps its exact telemetry string.
    for (const kind of [
      '"npm-targeted"',
      '"pnpm-targeted"',
      '"bun-targeted"',
      '"foreign-managed"',
      '"resolution-shortfall"',
    ]) {
      expect(core).toContain(kind);
    }
    // The classifier takes injected managed roots so it stays a pure function.
    expect(core).toContain('managed_roots: &[PathBuf],');
    expect(core).toContain('fn managed_shadow_same_root(');
  });

  it('only the finalize path can detect a shadow, and on detection it repairs then re-decides', () => {
    expect(finalizeStart).toBeGreaterThan(-1);
    expect(repairStart).toBeGreaterThan(finalizeStart);
    // Only finalize supplies real roots (so no other decide path can misfire),
    // resolved through the CHECKED discovery API.
    expect(finalizeSlice).toContain('paths::managed_toolchain_roots_checked()');
    expect(finalizeSlice).toContain('.with_managed_roots(&managed_roots)');
    // On a shadow it returns into the repair path rather than applying the
    // pre-repair outcome (which deliberately persists nothing).
    expect(finalizeSlice).toContain('Some(NonConvergenceKind::ManagedShadowed)');
    expect(finalizeSlice).toContain('return repair_managed_shadow_and_finalize(');
  });

  it('removes ONLY the HQ shims and scoped package, provenance-gated, never node/npm', () => {
    // The removal primitive is enumerated and gated in core.
    expect(core).toContain('pub fn attempt_managed_shadow_removal(');
    expect(core).toContain('const HQ_CLI_BIN_NAMES');
    // Provenance + prefix-in-place gates before any unlink.
    expect(core).toContain('version_if_hq_cli(');
    expect(core).toContain('installed_hq_cli_version_in_prefix(');
    expect(core).toContain('ManagedShadowRemoval::ProvenanceRefused');
    expect(core).toContain('ManagedShadowRemoval::NotAttempted');
    // The app invokes exactly that primitive off the resolved shadow prefix.
    expect(repairSlice).toContain('attempt_managed_shadow_removal(');
    expect(repairSlice).toContain('npm_prefix_from_hq_bin(shadow_hq_bin)');
  });

  it('re-resolves the executed binary and routes back through the shared success path', () => {
    // The whole point of the convergence gate: judge the binary the app EXECUTES,
    // never delivery evidence alone.
    expect(repairSlice).toContain('paths::resolve_bin("hq")');
    expect(repairSlice).toContain('resolved_hq_version(');
    expect(repairSlice).toContain('.with_managed_shadow_repair(');
    // A converged re-decision clears the marker and emits the cleared banner
    // through the SAME apply path as an ordinary success (no separate path to
    // drift), so the update banner clears and auto-install is un-blocked.
    expect(repairSlice).toContain('apply_post_install_with_app(app, &outcome)');
    expect(cli).toContain("app.emit(\"hq-cli-update:cleared\"");
  });

  it('never installs into the managed Node dir — the repair only REMOVES the shadow', () => {
    // Installs still target the managed npm prefix; the fix does not reorder the
    // resolver or move the install target into <toolchain>\node.
    expect(cli).toContain('paths::managed_npm_prefix_in(&root)');
    // Exactly one place classifies + repairs the shadow: the finalize path.
    expect(occurrences(cli, 'repair_managed_shadow_and_finalize(')).toBe(2); // 1 call + 1 definition
  });

  it('blocking is conditional on the repair outcome, and the user copy is corrected', () => {
    // A repairable first episode records no durable marker (self-heals); a failed
    // repair persists one and is captured with a self-diagnosing tag.
    expect(core).toContain('managed_shadow_repair: Option<ManagedShadowRepair>');
    expect(core).toContain('let managed_shadow_pending =');
    expect(core).toContain('scope.set_tag("managed_shadow_repair"');
    // The remedy copy for a shadow must NOT reuse the false foreign-managed advice.
    expect(core).toContain('pub fn managed_shadowed_detail(');
    const detailStart = core.indexOf('pub fn managed_shadowed_detail(');
    const detailBody = core.slice(detailStart, core.indexOf('\n}', detailStart));
    expect(detailBody).not.toContain("managed outside npm's global prefix");
    expect(detailBody).not.toContain('Update it with the tool that installed it');
  });

  it('is hardened: checked roots, re-arm for wedged machines, no dangling shim, honest failure copy', () => {
    // Deletion is authorised only through the CHECKED root discovery, so a
    // malformed LOCALAPPDATA/HOME cannot fabricate a relative root; the primitive
    // additionally refuses non-absolute paths.
    expect(finalizeSlice).toContain('paths::managed_toolchain_roots_checked()');
    expect(core).toContain('is_absolute()');

    // A machine ALREADY wedged (marker == latest with the pinned contract) never
    // re-enters the install path, so the checker re-arms it once per launch via a
    // filesystem-only shadow probe.
    expect(cli).toContain('fn resolved_hq_is_repairable_managed_shadow(');
    expect(cli).toContain('resolved_hq_is_repairable_managed_shadow(&blocked');
    expect(core).toContain('pub fn managed_shadow_same_root(');

    // A partial shim removal must keep the package so no surviving shim dangles.
    expect(core).toContain('if shim_failed {');
    const removalStart = core.indexOf('pub fn attempt_managed_shadow_removal(');
    const removalBody = core.slice(removalStart, core.indexOf('\nfn hq_cli_shim_probe_name(', removalStart));
    expect(removalBody.indexOf('shim_failed')).toBeLessThan(removalBody.indexOf('remove_dir_tolerant(&scoped_windows'));

    // A repair that FAILED shows an honest remedy, never "no action is needed".
    expect(core).toContain('pub fn managed_shadowed_unrepaired_detail(');
    const failDetailStart = core.indexOf('pub fn managed_shadowed_unrepaired_detail(');
    const failDetailBody = core.slice(failDetailStart, core.indexOf('\n}', failDetailStart));
    expect(failDetailBody).not.toContain('no action is needed');
    expect(failDetailBody).toContain('could not remove');
  });
});
