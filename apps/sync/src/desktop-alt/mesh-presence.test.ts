import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PresenceStore } from '@hq/core';
import { createChatWakeBus } from '@hq/ui';
import { describe, expect, it, vi } from 'vitest';

import { startDesktopMeshPresence } from './mesh-presence.js';

describe('startDesktopMeshPresence', () => {
  it('wires presence:changed onto the chat bus from the store', () => {
    const wakes = createChatWakeBus();
    const seen: Array<{ actorUid: string; status: string }> = [];
    wakes.on('presence:changed', (payload) => {
      seen.push({ actorUid: payload.actorUid, status: payload.status });
    });
    const presenceStore = new PresenceStore();
    const handle = startDesktopMeshPresence({
      wakes,
      fetchImpl: vi.fn(async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
      presenceStore,
    });
    presenceStore.applyMqtt('hq/cmp_x/presence/prs_a', {
      v: 1,
      status: 'online',
      actorUid: 'prs_a',
      actorType: 'human',
      at: '2026-09-03T12:00:00.000Z',
    });
    expect(seen).toEqual([{ actorUid: 'prs_a', status: 'online' }]);
    expect(handle.presenceSnapshot().get('cmp_x')?.get('prs_a')?.status).toBe(
      'online',
    );
    handle.stop();
  });

  it('is mounted from HqWorkWorkShell for the embedded shell', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./HqWorkWorkShell.svelte', import.meta.url)),
      'utf8',
    );
    expect(src).toContain("from './mesh-presence'");
    expect(src).toContain('startDesktopMeshPresence');
  });
});
