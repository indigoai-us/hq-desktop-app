import { describe, expect, it, vi } from 'vitest';
import {
  createSyncPlatformAdapter,
  type PlatformAdapter,
  type SyncInvokeFn,
} from '@hq/platform';

/**
 * The adapter factory is typed against PlatformAdapter, so the full API shape
 * is checked by the repository's TypeScript CI gate. These tests exercise the
 * runtime behavior that the old source parser only used as a proxy for.
 */
function makeAdapter(
  invoke: SyncInvokeFn = async () => null,
): PlatformAdapter {
  return createSyncPlatformAdapter({
    invoke,
    fetch: () => {
      throw new Error('adapter must not use window.fetch');
    },
  });
}

describe('Sync PlatformAdapter behavior', () => {
  it('reports host-owned OS notifications as unavailable', async () => {
    const adapter = makeAdapter();
    expect(adapter.appShell.showOsNotification).toBeTypeOf('function');

    await expect(
      adapter.appShell.showOsNotification({ title: 'a', body: 'b' }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'unavailable',
      code: 'host-owned',
    });
  });

  it('gets the company board through the existing Sync invoke command', async () => {
    const invoke = vi.fn(async () => ({ stories: [{ id: 'story-1' }] }));
    const adapter = makeAdapter(invoke);

    await expect(adapter.company.getBoard('indigo')).resolves.toEqual({
      ok: true,
      value: { stories: [{ id: 'story-1' }] },
    });
    expect(invoke).toHaveBeenCalledWith('get_company_board', { slug: 'indigo' });
  });

  it('maps an invoke rejection to an adapter error', async () => {
    const adapter = makeAdapter(async () => {
      throw new Error('host unavailable');
    });

    const result = await adapter.company.getBoard('indigo');
    expect(result).toMatchObject({ ok: false, reason: 'error', code: 'invoke' });
    if (!result.ok) expect(result.message).toContain('host unavailable');
  });
});
