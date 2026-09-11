import { describe, expect, it, vi } from 'vitest';
import { createSyncPlatformAdapter } from './sync-adapter';

// Regression (fresh-install first sign-in): `list_syncable_workspaces` never
// rejects when the cloud branch fails — it resolves `{ workspaces: [],
// cloudReachable: false, error }` so the menubar can show "Cloud unreachable".
// The embedded shell read that as a *successful, empty* roster and stopped
// retrying, so a brand-new owner saw "Create a company" until a relaunch.
// An unreachable cloud is a failed roster fetch, not an empty one.

const ACME = { slug: 'acme', cloudUid: 'cmp_acme', kind: 'company' };

describe('createSyncPlatformAdapter identity.listWorkspaces', () => {
  it('unwraps the workspaces array when the cloud roster was reachable', async () => {
    const invoke = vi.fn(async () => ({
      workspaces: [ACME],
      cloudReachable: true,
      error: null,
      hqFolderPath: '/tmp/HQ',
      manifestError: null,
    }));
    const adapter = createSyncPlatformAdapter({ invoke });

    const res = await adapter.identity.listWorkspaces();

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual([ACME]);
  });

  it('reports a failure (not an empty roster) when the cloud was unreachable', async () => {
    const invoke = vi.fn(async () => ({
      workspaces: [],
      cloudReachable: false,
      error: 'vault unreachable',
      hqFolderPath: '/tmp/HQ',
      manifestError: null,
    }));
    const adapter = createSyncPlatformAdapter({ invoke });

    const res = await adapter.identity.listWorkspaces();

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('error');
      expect(res.message).toBe('vault unreachable');
    }
  });

  it('still fails when the cloud was unreachable and no message was given', async () => {
    const invoke = vi.fn(async () => ({ workspaces: [], cloudReachable: false }));
    const adapter = createSyncPlatformAdapter({ invoke });

    const res = await adapter.identity.listWorkspaces();

    expect(res.ok).toBe(false);
  });

  it('keeps accepting a bare array or a result without the reachability flag', async () => {
    const bare = createSyncPlatformAdapter({ invoke: vi.fn(async () => [ACME]) });
    const legacy = createSyncPlatformAdapter({
      invoke: vi.fn(async () => ({ workspaces: [ACME] })),
    });

    const fromBare = await bare.identity.listWorkspaces();
    const fromLegacy = await legacy.identity.listWorkspaces();

    expect(fromBare.ok && fromBare.value).toEqual([ACME]);
    expect(fromLegacy.ok && fromLegacy.value).toEqual([ACME]);
  });
});
