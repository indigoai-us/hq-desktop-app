import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * HQ-DESKTOP-3P — the Windows `hq` resolver lands on a real hq-cli install, not
 * an orphaned managed-toolchain shim or a foreign program named `hq`, so the
 * version probe stops reporting "installed but unreadable" forever.
 *
 * Source-contract, same style as cli-update-node-self-provision.spec.ts: it runs
 * inside the scripted "Desktop-alt E2E" job with no built binary, and locks the
 * wiring of a fix whose behavioural proof lives in the Rust unit tests
 * (crates/hq-desktop-core/src/paths.rs) and the capture E2E
 * (crates/hq-telemetry/tests/hq_cli_update_capture_e2e.rs). The point of these
 * assertions is that a later edit cannot silently reintroduce the lane-split or
 * drop the orphan rejection without a red check here.
 */
describe('hq resolver prefers a backed install over an orphan or foreign hq (HQ-DESKTOP-3P)', () => {
  const paths = readRepoFile('../../crates/hq-desktop-core/src/paths.rs');
  const cli = readRepoFile('../../crates/hq-desktop-core/src/hq_cli_update.rs');

  it('sweeps the settings and extended lanes as ONE list, not two separate calls', () => {
    // The fix collapses the per-lane calls: settings dirs first, then extended,
    // swept together through the tiered `hq` selection.
    expect(paths).toContain('let mut dirs = settings_path_dirs();');
    expect(paths).toContain('dirs.extend(extended_search_dirs());');
    expect(paths).toContain('select_hq_program_on_disk(&dirs, &candidates, &reject, &backing)');

    // The defect was a SEPARATE settings-only sweep that returned on any hit,
    // pre-empting the extended lane's spawnable pass. It must be gone.
    expect(paths).not.toContain(
      'select_program_on_disk_rejecting(&settings_path_dirs(), &candidates, &reject)',
    );
  });

  it('rejects only HQ\'s own orphaned managed shim, gated on a DEFINITIVE absence', () => {
    expect(paths).toContain('|| is_orphaned_managed_shim(candidate)');
    // Provenance gate first (pure path math), then a definitive-absence check —
    // never a demotion on an unreadable/indeterminate manifest.
    expect(paths).toContain('fn is_orphaned_managed_shim(candidate: &Path) -> bool {');
    expect(paths).toContain('hq_bin_in_managed_root(candidate)');
    expect(paths).toContain('CandidateBacking::AbsentDefinitive');
  });

  it('carries a bounded backed-candidate preference with an injected oracle', () => {
    expect(paths).toContain('pub fn select_hq_program_in_dirs(');
    expect(paths).toContain('enum CandidateBacking {');
    for (const variant of ['Backed', 'AbsentDefinitive', 'Indeterminate']) {
      expect(paths).toContain(variant);
    }
    // The oracle lives in hq_cli_update (owns the package-layout knowledge) and
    // reuses the version probe, so backing and version-reading cannot disagree.
    expect(cli).toContain('pub fn hq_cli_backing(hq_bin: &Path) -> paths::CandidateBacking {');
    expect(cli).toContain('version_from_hq_binary_probe(hq_bin).1');
  });

  it('adds the closed, additive hq_backing telemetry sub-case without changing the event', () => {
    expect(cli).toContain('pub enum HqBacking {');
    for (const variant of ['NotProbed', 'Backed', 'UnbackedManaged', 'UnbackedForeign']) {
      expect(cli).toContain(variant);
    }
    // Additive field on the existing diagnostics, and carried into the reported
    // payload beside the original eight fields.
    expect(cli).toContain('pub hq_backing: HqBacking,');
    expect(cli).toContain('"hq_backing": probes.hq_backing,');
  });

  it('leaves the reporting gate honest — no dedupe, suppression, or cooldown added', () => {
    // The repair is resolution correctness; the gate that tells fixed from
    // silenced must keep its exact definition.
    expect(cli).toContain(
      'pub fn should_report_unreadable_version(result: &LocalVersionProbeResult) -> bool {',
    );
    expect(cli).toContain('result.local.is_none() && result.hq_installed');
  });
});

/**
 * HQ-DESKTOP-3P (regression reopen) — the macOS/Unix `hq` resolver now sweeps
 * every lane in ONE cross-lane list with the SAME tiered backed-candidate
 * preference the Windows arm shipped, and the version probe's `hq_installed` is
 * truthful for a definitively-foreign, unreadable `hq`. These source-contract
 * assertions lock that wiring so a later edit cannot silently reintroduce the
 * Unix settings-only lane split or re-inflate `hq_installed`.
 */
describe('the Unix hq resolver sweeps one cross-lane list with a backed preference (HQ-DESKTOP-3P)', () => {
  const paths = readRepoFile('../../crates/hq-desktop-core/src/paths.rs');
  const cli = readRepoFile('../../crates/hq-desktop-core/src/hq_cli_update.rs');

  function unixHqResolverBranch(): string {
    const resolverStart = paths.indexOf(
      'pub fn resolve_bin_with_kind(name: &str) -> ResolvedProgram {',
    );
    expect(resolverStart, 'resolve_bin_with_kind must remain the resolver boundary').toBeGreaterThanOrEqual(
      0,
    );

    const unixArmStart = paths.indexOf('    #[cfg(not(target_os = "windows"))]\n    {', resolverStart);
    expect(unixArmStart, 'the Unix resolver arm must remain discoverable').toBeGreaterThan(
      resolverStart,
    );

    const hqBranchStart = paths.indexOf('        if name == "hq" {', unixArmStart);
    expect(hqBranchStart, 'the Unix hq branch must remain discoverable').toBeGreaterThan(
      unixArmStart,
    );

    const hqBranchEnd = paths.indexOf(
      '        } else if let Some(path) = resolve_bin_in_dirs(home_dir().as_deref(), name) {',
      hqBranchStart,
    );
    expect(hqBranchEnd, 'the Unix hq branch must retain its non-hq boundary').toBeGreaterThan(
      hqBranchStart,
    );

    return paths.slice(hqBranchStart, hqBranchEnd);
  }

  it('sweeps the Unix hq lanes as ONE cross-lane list, not a settings-only loop', () => {
    expect(paths).toContain('select_hq_program_in_dirs(');
    expect(paths).toContain('&unix_hq_search_dirs(home_dir().as_deref()),');
    // Scope this ban to the Unix `hq` branch: `paths.rs` legitimately uses the
    // executable-file predicate for other resolvers. Each extraction boundary is
    // asserted above, so a renamed or moved resolver cannot yield an empty slice
    // that makes this guard pass. This exact settings-only loop was the pre-fix
    // defect: it returned before the cross-lane backed-candidate selector ran.
    expect(unixHqResolverBranch()).not.toContain(
      'for dir in settings_path_dirs() {\n                let candidate = dir.join(name);',
    );
  });

  it('builds the Unix search dirs as one ordered, fixture-injectable list', () => {
    expect(paths).toContain('fn unix_hq_search_dirs(home: Option<&Path>) -> Vec<PathBuf> {');
    expect(paths).toContain('fn unix_hq_search_dirs_in(');
  });

  it('injects the backing oracle and the executable-file predicate on Unix', () => {
    // The oracle is injected (not reimplemented), and the sweep uses the same
    // executable-file contract a shell honours.
    expect(paths).toContain('&is_executable_file,');
    expect(paths).toContain('crate::hq_cli_update::hq_cli_backing(path)');
  });

  it('derives hq_installed from the backing: definitively-foreign + unreadable is not installed', () => {
    // The honesty lives in the INPUT to should_report_unreadable_version, whose
    // body is untouched (asserted above). A foreign, unreadable hq flips
    // hq_installed false so the installer converges the machine.
    expect(cli).toContain(
      'hq_installed && !(local.is_none() && hq_backing == HqBacking::UnbackedForeign)',
    );
  });

  it('gives the version probe a null stdin so a foreign hq cannot block on stdin', () => {
    expect(cli).toContain('.stdin(Stdio::null())');
  });
});
