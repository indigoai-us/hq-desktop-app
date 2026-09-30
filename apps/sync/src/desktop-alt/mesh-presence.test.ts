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
});
