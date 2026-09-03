/**
 * Desktop-alt presence lane wiring (work-mesh-live US-014).
 *
 * The embedded shell uses MeshClient over the native hq-pro fetch seam so
 * presence MQTT and live-read rebuild share the same PresenceStore as web.
 * Changes fan onto the chat bus as `presence:changed` and into the Svelte
 * runes snapshot for UI reads.
 */

import {
  LiveReadStore,
  MeshClient,
  PresenceStore,
  createWebCredentialProvider,
  type PresenceSnapshot,
} from '@hq/core';
import {
  bindLiveReadStore,
  bindPresenceStore,
  createChatWakeBus,
  wirePresenceStoreToChatBus,
} from '@hq/ui';

type FetchLike = typeof fetch;
type DesktopWakeBus = ReturnType<typeof createChatWakeBus>;

export interface StartDesktopMeshPresenceOptions {
  wakes: DesktopWakeBus;
  /** Native hq-pro fetch (Tauri command). */
  fetchImpl: FetchLike;
  presenceStore?: PresenceStore;
  liveReadStore?: LiveReadStore;
  /**
   * Credential vend path. Defaults to POST /v1/realtime/credentials via the
   * injected native fetch (contract 2 unchanged; presence filter is derived
   * from companyTopics UIDs, not presenceTopic).
   */
  credentialsUrl?: string;
}

export interface DesktopMeshPresenceHandle {
  stop: () => void;
  presenceStore: PresenceStore;
  presenceSnapshot: () => PresenceSnapshot;
  liveReadStore: LiveReadStore;
  client: MeshClient;
}

/**
 * Start MeshClient for the embedded desktop shell and wire presence onto the
 * shared chat bus + runes snapshot.
 */
export function startDesktopMeshPresence(
  opts: StartDesktopMeshPresenceOptions,
): DesktopMeshPresenceHandle {
  const presenceStore = opts.presenceStore ?? new PresenceStore();
  const liveReadStore = opts.liveReadStore ?? new LiveReadStore();
  const fetchImpl = opts.fetchImpl;
  const client = new MeshClient({
    credentialProvider: createWebCredentialProvider({
      url: opts.credentialsUrl ?? '/v1/realtime/credentials',
      fetchImpl: fetchImpl as never,
    }),
    fetcher: async (route, cursor) => {
      const url = new URL(route.path, 'http://local.invalid');
      if (cursor) url.searchParams.set('cursor', cursor);
      const path = `${url.pathname}${url.search}`;
      const res = await fetchImpl(path);
      if (!res.ok) {
        throw new Error(`reconcile ${route.path} failed (${res.status})`);
      }
      const state = await res.json().catch(() => null);
      const rec =
        state && typeof state === 'object'
          ? (state as { cursor?: unknown })
          : null;
      return {
        state,
        cursor: typeof rec?.cursor === 'string' ? rec.cursor : undefined,
      };
    },
    presenceStore,
    liveReadStore,
  });

  const unwire = wirePresenceStoreToChatBus(presenceStore, opts.wakes);
  const unbind = bindPresenceStore(presenceStore);
  const unbindLive = bindLiveReadStore(liveReadStore);

  client.on('presence', (change) => {
    // Bus already notified via wirePresenceStoreToChatBus; keep a log seam.
    void change;
  });
  client.on('live', (companyUid) => {
    opts.wakes.emit('live:wake', { companyUid });
  });

  void client.start().catch(() => {
    // Absent-safe: REST + native DM MQTT still work if this socket fails.
  });

  return {
    stop: () => {
      unwire();
      unbind();
      unbindLive();
      client.stop();
    },
    presenceStore,
    presenceSnapshot: () => presenceStore.snapshot(),
    liveReadStore,
    client,
  };
}
