import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * HQ-DESKTOP-49 — Connect on a machine with no Node runtime.
 *
 * The reported failure was a real end-user Connect click on a Mac with no Node
 * anywhere: the resolver fell back to the `npx` self-heal invocation, `spawn`
 * failed with ENOENT, and the app reported a first-run setup gap to Sentry as
 * a `level=error` event while the user just saw Connect fail.
 *
 * HQ ships its own checksum-verified managed Node installer, so this is a
 * provisioning gap HQ can repair — not a terminal instruction to go install
 * Node by hand. This spec locks the observable sequence:
 *
 *   1. HQ attempts its OWN Node provisioning first, reusing the installer
 *      already on main rather than adding a second one.
 *   2. Only if that cannot complete does the row surface
 *      "Install Node.js — click 'Fix in Claude Code'" with a working repair
 *      button.
 *   3. The repair is bounded to one attempt and one retry per Connect click.
 *   4. Sentry suppression stays symmetric across the IPC boundary — if Rust
 *      declines to capture a proven user-owned gap, the Svelte catch block
 *      must decline too, or the same noise returns from the frontend.
 *
 * Source-contract harness, same style as open-in-claude-code.spec.ts: it runs
 * inside the existing scripted "Desktop-alt E2E" CI job with no built binary.
 */

describe('Connect self-provisions HQ-managed Node before blaming the user (HQ-DESKTOP-49)', () => {
  const workspacesRs = readRepoFile('src-tauri/src/commands/workspaces.rs');
  const syncRs = readRepoFile('src-tauri/src/commands/sync.rs');
  const list = readRepoFile('src/components/WorkspaceList.svelte');
  const prompts = readRepoFile('src/lib/copy-prompts.ts');
  const diagnosis = readRepoFile(
    '../../crates/hq-desktop-core/src/runtime_diagnosis.rs',
  );

  it('reuses the existing managed-Node installer instead of adding a second one', () => {
    // `repair_managed_node` already wraps install_deps::install_node and
    // already carries the repair cooldown. Connect consumes it; it does not
    // reimplement the download, and it does not reach into install_deps
    // directly (which would bypass that cooldown).
    // Runtime-generic since HQ-SYNC-BA: the auto-sync watcher reaches this
    // through `start_daemon_with_origin<R>`, while Connect still passes its
    // concrete AppHandle. The shared installer + cooldown are the point.
    expect(syncRs).toContain(
      'pub(crate) async fn repair_managed_node<R: tauri::Runtime>(app: &AppHandle<R>)',
    );
    expect(workspacesRs).toContain('repair_managed_node');
    expect(workspacesRs).not.toContain('install_deps::install_node');
    expect(workspacesRs).not.toContain('managed_node_url_for');
  });

  it('installs Node before surfacing the gap, and retries the provision once', () => {
    expect(workspacesRs).toContain('async fn provision_with_node_self_repair');
    // The retry is inside the policy function, so the command itself has no
    // second hand-rolled call site that could drift out of the bound.
    expect(workspacesRs).toContain('provision_with_node_self_repair(');
    expect(workspacesRs).toContain('fn repair_earns_retry(repair: &ToolchainRepair) -> bool');
    expect(workspacesRs).toContain('matches!(repair, ToolchainRepair::Repaired)');
  });

  it('takes the AppHandle from the command signature, leaving the invoke payload unchanged', () => {
    // Tauri injects AppHandle; the frontend still sends only { slug }. If this
    // ever needed a JS-side change, the Connect button would silently break.
    expect(workspacesRs).toContain('pub async fn connect_workspace_to_cloud(');
    expect(workspacesRs).toContain('app: tauri::AppHandle');
    expect(list).toContain("await invoke('connect_workspace_to_cloud', { slug });");
  });

  it('only self-repairs a PROVEN missing runtime — never someone else`s broken npx', () => {
    expect(workspacesRs).toContain('fn is_self_repairable_node_gap');
    expect(workspacesRs).toContain(
      'matches!(err, CliProvisionError::LocalEnv { kind, .. } if *kind == "node-missing")',
    );
    // `node-missing` is only ever produced for NotProvisioned + both probes
    // NotFound; every uncertain or HQ-owned runtime state stays reportable.
    expect(diagnosis).toContain('ManagedRuntime::Incomplete { .. } => RuntimeDiagnosis::Unexplained');
    expect(diagnosis).toContain(
      'ManagedRuntime::PresentMissingNpx { .. } => RuntimeDiagnosis::Unexplained',
    );
    expect(diagnosis).toContain('ManagedRuntime::Unknown { .. } => RuntimeDiagnosis::Unexplained');
  });

  it('still renders the repair affordance when HQ cannot install Node itself', () => {
    expect(list).toContain("case 'node-missing':");
    expect(list).toContain("return 'Install Node.js'");
    expect(list).toContain('click "Fix in Claude Code"');
    expect(prompts).toContain(
      "'node-missing': 'Install Node.js and reopen HQ Sync, then retry Connect.'",
    );
  });

  it('keeps Sentry suppression symmetric across the IPC boundary', () => {
    // The Rust side declines to capture a proven user-owned gap. If the Svelte
    // catch block still captured, the noise would simply reappear from the
    // frontend and the fix would be cosmetic.
    expect(list).toContain(
      "localEnv?.kind === 'node-missing' || localEnv?.kind === 'npx-unavailable'",
    );
    expect(list).toMatch(
      /if \(!expectedRuntimeGap\) \{[\s\S]{0,200}?Sentry\.captureException/,
    );
  });
});
