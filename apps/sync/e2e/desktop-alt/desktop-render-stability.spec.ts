import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * Regression — the desktop window must never hard-reload itself or tear down its
 * chrome to refresh the workspace list.
 *
 * Context: a "Fix desktop local data surfaces" patch (commit 22e4832) added
 * `window.location.reload()` inside loadWorkspaces() — which fires on the initial
 * cache→live swap, on every window focus, and on every sync:all-complete — plus
 * `{#key renderWorkspaceCount}` remounts of the title bar, sidebar, and status
 * bar. The reload mid-paint is what blanked/froze the desktop. The chrome is
 * already reactive (ChatSidebar / FilesModeSidebar consume the `companies`
 * prop; V4TitleBar / DesktopStatusBar are pure $props consumers), so reassigning
 * renderCompanies refreshes everything without a reload or a remount.
 */
describe('desktop render stability', () => {
  const app = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const harness = readRepoFile('dev-harness/Harness.svelte');

  it('never reloads the document to refresh the workspace list', () => {
    expect(app).not.toContain('window.location.reload');
    expect(app).not.toContain('WORKSPACE_RELOAD_KEY');
    expect(app).not.toContain('workspaceSignature');
  });

  it('does not tear down the chrome on a workspace-count change', () => {
    expect(app).not.toContain('{#key renderWorkspaceCount}');
  });

  it('keeps the dev-only render audit out of production builds', () => {
    const at = app.indexOf('function queueDesktopRenderAudit');
    expect(at).toBeGreaterThan(-1);
    const fn = app.slice(at, at + 500);
    expect(fn).toContain('import.meta.env.DEV');
  });

  it('pins the preview mount chain to the viewport so leaf panes own scrolling', () => {
    expect(harness).toContain(":global(html[data-window='desktop-alt'] #app)");
    expect(harness).toMatch(
      /:global\(html\[data-window='desktop-alt'\] #app\)\s*\{[\s\S]*?height:\s*100vh;[\s\S]*?min-height:\s*0;/,
    );
    expect(harness).toMatch(
      /:global\(html\[data-window='desktop-alt'\] body\)\s*\{[\s\S]*?overflow:\s*hidden;/,
    );
  });

  it('provides deterministic conflict, sync-error, and core-drift safety states', () => {
    const mocks = readRepoFile('dev-harness/mocks/core.ts');

    expect(harness).toContain("scenario === 'conflict'");
    expect(harness).toContain("scenario === 'sync-error'");
    expect(harness).toContain("emit('sync:conflict'");
    expect(harness).toContain("emit('sync:error'");
    expect(mocks).toContain('function currentHarnessCoreState()');
    // US-019: drift is selected via wantsCoreDrift / scenario catalog
    // (drift | no-drift | chat shell default), not a single !== 'drift' guard.
    expect(mocks).toContain('function wantsCoreDrift(');
    expect(mocks).toContain("scenario === 'drift'");
    expect(mocks).toContain("scenario === 'no-drift'");
    expect(mocks).toContain('check_core_state: () => currentHarnessCoreState()');
  });

  it('keeps the moderation harness populated and interactive', () => {
    const mocks = readRepoFile('dev-harness/mocks/core.ts');

    expect(mocks).toContain('list_moderation_queue: () =>');
    expect(mocks).toContain('decide_moderation_listing:');
    expect(mocks).toContain('list_creator_applications: () =>');
    expect(mocks).toContain('decide_creator_application:');
    expect(mocks).toContain('yank_marketplace_listing:');
  });

  it('mocks every always-on full-shell hydration command without fallback nulls', () => {
    const mocks = readRepoFile('dev-harness/mocks/core.ts');

    for (const command of [
      'get_company_board',
      'meetings_list_active_detections',
      'meetings_list_active_recordings',
      'desktop_alt_dev_audit_render',
    ]) {
      expect(mocks).toContain(`${command}:`);
    }
  });
});
