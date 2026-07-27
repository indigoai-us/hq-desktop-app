import { describe, expect, it } from 'vitest';
import {
  getV4TitleBarModel,
  type V4HydrationIssue,
} from '../../src/desktop-alt/v4/model';
import { readRepoFile } from './harness';

describe('desktop hydration truthfulness', () => {
  it.each([
    [
      { kind: 'workspace-list', detail: 'Cloud workspace lookup failed' },
      'Workspace status unavailable',
    ],
    [
      { kind: 'manifest', detail: 'companies/manifest.yaml could not be parsed' },
      'Workspace setup needs attention',
    ],
    [
      { kind: 'sync-status', detail: 'Could not read the latest sync status' },
      'Sync status unavailable',
    ],
  ] satisfies Array<[V4HydrationIssue, string]>)(
    'never reports All synced when %s hydration failed',
    (hydrationIssue, expectedSentence) => {
      const model = getV4TitleBarModel({
        syncState: 'idle',
        watchedCount: 4,
        lastSyncLabel: 'just now',
        hydrationIssue,
      });

      expect(model).toMatchObject({
        tone: 'error',
        sentence: expectedSentence,
        meta: hydrationIssue.detail,
        action: { id: 'retry', label: 'Retry' },
        recovery: 'hydration',
      });
      expect(model.sentence).not.toBe('All synced');
    },
  );

  it('keeps a live operational state authoritative over a stale hydration diagnostic', () => {
    const model = getV4TitleBarModel({
      syncState: 'syncing',
      watchedCount: 4,
      hydrationIssue: {
        kind: 'sync-status',
        detail: 'The initial status read failed',
      },
    });

    expect(model.sentence).toBe('Syncing…');
    expect(model.action).toEqual({ id: 'cancel', label: 'Cancel' });
    expect(model.recovery).toBeUndefined();
  });

  it('retains sanitized workspace, manifest, and status diagnostics independently', () => {
    const app = readRepoFile('src/desktop-alt/DesktopApp.svelte');

    expect(app).toContain('let workspaceManifestError = $state<string | null>(null)');
    expect(app).toContain('let syncStatusError = $state<string | null>(null)');
    expect(app).toMatch(
      /workspaceError\s*=\s*sanitizeVisibleIdentifiers\(result\?\.error,\s*\{\s*companies:\s*nextWorkspaces\s*\}\)/,
    );
    expect(app).toMatch(
      /workspaceManifestError\s*=\s*sanitizeVisibleIdentifiers\(\s*result\?\.manifestError,\s*\{\s*companies:\s*nextWorkspaces,\s*\}\s*\)/,
    );
    expect(app).toMatch(
      /syncStatusError\s*=\s*sanitizeVisibleIdentifiers\(String\(err\),\s*\{\s*companies:\s*workspaces\s*\}\)/,
    );
    expect(app).toMatch(
      /catch \(err\) \{[\s\S]*?list_syncable_workspaces failed:[\s\S]*?cloudReachable = false;/,
    );
  });

  it('wires hydration Retry to rerun the real hydration commands, not start a sync', () => {
    const app = readRepoFile('src/desktop-alt/DesktopApp.svelte');
    const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');

    expect(app).toMatch(
      /async function handleRetryHydration\(\) \{[\s\S]*?await refreshRealState\(\);[\s\S]*?\}/,
    );
    expect(app).toContain('onretryhydration={handleRetryHydration}');
    expect(titleBar).toContain('onretryhydration?: () => void');
    expect(titleBar).toContain("model.recovery === 'hydration'");
    expect(titleBar).toContain('onretryhydration?.()');
  });
});
