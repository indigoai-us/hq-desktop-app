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
 *      never a second installer and never the low-level Node installer directly
 *      (which would bypass the shared repair cooldown).
 *   2. Only a third-party native-build lifecycle failure under the user's OWN
 *      Node arms the retry — a pure, unit-tested gate.
 *   3. The retry is bounded to ONE provision and ONE re-run: no loop.
 *   4. A converged retry emits NO Sentry event; a failed retry reports once with
 *      managed provenance (`managed_toolchain_retry=true`).
 *   5. The retry reuses the already-pinned version + prefix and never re-resolves
 *      the `@latest` dist-tag (which would reopen the post-publish registry race).
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
  // further down legitimately loops).
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
    // The managed npm/PATH is derived only from the closed path helpers.
    expect(cli).toContain('paths::managed_toolchain_roots()');
    expect(cli).toContain('paths::managed_node_executable_in(&root)');
  });

  it('only self-repairs a third-party native-build failure under the user`s own Node', () => {
    // A pure, unit-tested gate — no AppHandle, no real install — so the trigger
    // condition cannot drift silently.
    expect(cli).toContain('fn install_failure_earns_managed_retry(');
    expect(cli).toContain(
      'kind == InstallFailureKind::UnexpectedLifecycle && source == NpmToolchainSource::UserPath',
    );
    // The failure path consults exactly that gate before any provisioning.
    expect(cli).toContain(
      'install_failure_earns_managed_retry(failure_kind, npm_toolchain_source(&npm))',
    );
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

  it('emits no Sentry event on a converged retry, and stops hardcoding managed_toolchain_retry=false', () => {
    // A converged retry returns the success info directly — the normal cleared /
    // convergence path already ran inside the shared finalize step, so NO
    // install-failure capture happens.
    expect(cli).toContain('Some(Ok(info)) => return Ok(info)');
    // The dead instrumentation is gone: the original user-path report still
    // carries false, but a real managed retry now carries true. (Assert on the
    // tokens rather than an exact call layout so rustfmt reflow can't defeat it.)
    expect(cli).toContain(
      'probe_install_environment(&npm, &path, /* managed_toolchain_retry */ false)',
    );
    expect(cli).toContain('/* managed_toolchain_retry */ true');
    expect(retryHelper).toContain('&managed_npm');
    expect(retryHelper).toContain('&managed_path');
  });

  it('reuses the pinned version and prefix on the retry — never re-resolving @latest', () => {
    // The retry re-runs the SAME pinned argv (base_args) under the managed
    // toolchain; it must not call fetch_latest() again mid-episode.
    expect(retryHelper).toContain('base_args.to_vec()');
    expect(retryHelper).not.toContain('fetch_latest');
    // Convergence is judged by the SHARED finalize step (re-resolving the `hq`
    // the app executes), so a managed retry that lands in an unreachable prefix
    // is reported as non-convergent, never as success.
    expect(cli).toContain('finalize_convergence(');
    expect(cli).toContain('let post_install_hq = paths::resolve_bin("hq");');
    expect(cli).toContain('installed_hq_cli_version_in_prefix(&prefix, &hq)');
  });
});
