import { describe, expect, it, vi } from 'vitest';

import { createChatWakeBus, requestLiveRefresh } from '@hq/ui';
import { startDesktopMeshPresence } from './mesh-presence';

describe('startDesktopMeshPresence', () => {
  it('refreshes the owning MeshClient for Atlas requests and unbinds on stop', () => {
    const wakes = createChatWakeBus();
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));
    const handle = startDesktopMeshPresence({ wakes, fetchImpl });
    const refreshLive = vi.spyOn(handle.client, 'refreshLive');

    requestLiveRefresh('cmp_indigo');
    expect(refreshLive).toHaveBeenCalledWith('cmp_indigo');

    handle.stop();
    requestLiveRefresh('cmp_after_stop');
    expect(refreshLive).toHaveBeenCalledTimes(1);
  });

  it('logs a non-JSON reconcile body and stores no live read', async () => {
    const error = new Error('bad json');
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wakes = createChatWakeBus();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw error;
      },
    }));
    const handle = startDesktopMeshPresence({
      wakes,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    handle.client.refreshLive('cmp_indigo');
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith(
        'mesh presence reconcile body was not JSON',
        error,
      );
    });
    // A null JSON body is not a live-read snapshot, so nothing is stored.
    // That is the same fallback as returning null without a log.
    expect(handle.client.getLiveReadStore().get('cmp_indigo')).toBeUndefined();
    handle.stop();
    logged.mockRestore();
  });
});
