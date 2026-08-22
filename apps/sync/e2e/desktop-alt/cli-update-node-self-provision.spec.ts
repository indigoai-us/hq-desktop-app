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
    // Cooldown-skipped or failed provisioning falls straight through (no retry),
    // so the caller reports the original user-path failure unchanged.
    expect(cli).toContain('ToolchainRepair::Repaired => {}');
    expect(retryHelper).toContain('ToolchainRepair::Skipped =>');
    expect(retryHelper).toContain('ToolchainRepair::Failed(reason) =>');
    expect(occurrences(retryHelper, 'return None;')).toBeGreaterThanOrEqual(3);
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
    expect(retryHelper).toContain('if converged.is_ok()');
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
    expect(cli).toContain('let prefix = hq_cli_install_prefix(&npm, &hq);');
    expect(cli).toContain('fn hq_cli_install_prefix(');
    expect(cli).toContain('fn prefer_managed_prefix(');
    // A managed npm (living inside a managed toolchain root) routes to the SHARED
    // managed prefix helper — never a user-derived prefix under a managed npm.
    expect(cli).toContain('Path::new(npm).starts_with(&root)');
    expect(cli).toContain('paths::managed_npm_prefix_in(&root)');
  });

  it('emits no Sentry event on a converged retry, and reports a failed retry with managed provenance', () => {
    // A converged retry returns the success info directly — the shared cleared /
    // convergence path already ran, so NO install-failure capture happens.
    expect(cli).toContain('Some(Ok(info)) => return Ok(info)');
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

  it('repairs an HQ-owned managed-toolchain shadow instead of wedging auto-update (HQ-DESKTOP-46)', () => {
    // On Windows the updater installs into <toolchain>\npm-prefix but the app
    // resolves a stale <toolchain>\node\hq.cmd; the old contract mislabelled HQ's
    // OWN layout foreign-managed and wrote the durable marker that disables
    // auto-update for that release. finalize_convergence now classifies the
    // HQ-owned shadow (with the managed roots) and hands off to a repair that
    // removes HQ's own stale copy, then RE-RESOLVES the executed binary.
    expect(cli).toContain('let managed_roots = paths::managed_toolchain_roots();');
    expect(cli).toContain('Some(NonConvergenceKind::ManagedShadowed)');
    expect(cli).toContain('finalize_managed_shadow(');
    expect(cli).toContain('attempt_managed_shadow_repair(');

    const repair = cli.slice(
      cli.indexOf('async fn finalize_managed_shadow('),
      cli.indexOf('// The bounded, provenance-gated removal itself'),
    );
    // Convergence is judged on the binary the app EXECUTES after the repair,
    // never on delivery evidence alone.
    expect(repair).toContain('let repaired_hq = paths::resolve_bin("hq");');
    expect(repair).toContain('resolved_hq_version(&hq)');
    expect(repair).toContain('decide_post_install(&PostInstallContext {');
    // A converged re-resolution clears the marker via the shared decision; a
    // still-stale one carries the repair outcome so the capture stays bounded.
    expect(repair).toContain('managed_shadow_repair: repair_outcome,');
    expect(repair).toContain('apply_post_install_with_app(app, &outcome)');
    // Filesystem-only: the repair adds no second subprocess to the install path.
    expect(repair).not.toContain('Command::new');
    // Exactly one repair attempt in the helper — no loop.
    expect(occurrences(repair, 'attempt_managed_shadow_repair(')).toBe(1);

    // A shadow that could not be repaired stays observable but writes NO durable
    // marker (bounded by the non-blocking episode key), so a transient lock does
    // not wedge auto-update.
    expect(repair).toContain('non_convergent_episode_markers()');
    // The checker re-attempts the install on the shadow shape, so a durable
    // marker written by an OLDER build cannot lock out the new repair.
    expect(cli).toContain('|| resolved_hq_is_managed_shadow()');
  });
});
