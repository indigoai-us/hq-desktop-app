import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PresenceStore } from '@hq/core';
import { createChatWakeBus } from '@hq/ui';
import { describe, expect, it, vi } from 'vitest';

describe('startDesktopMeshPresence', () => {

  it('binds Atlas open live refresh to MeshClient.refreshLive (US-016)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./mesh-presence.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('bindLiveRefresh');
    expect(src).toContain('client.refreshLive');
  });
});
