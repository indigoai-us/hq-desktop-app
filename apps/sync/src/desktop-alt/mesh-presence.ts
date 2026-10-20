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
  fetchWorkFeedPages,
  isWorkFeedPath,
  workFeedPagePath,
  type PresenceSnapshot,
} from '@hq/core';
import {
  bindLiveReadStore,
  bindLiveRefresh,
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
 * REST fetcher for MeshClient wakes over the native hq-pro fetch seam.
 * GET /v1/work-mesh/work is read across every page (hq-pro #5004).
 */
export function createDesktopReconcileFetcher(
  fetchImpl: FetchLike,
): (route: { path: string }, cursor?: string) => Promise<{ state: unknown; cursor?: string }> {
  return async (route, cursor) => {
    const fetchJson = async (path: string): Promise<unknown> => {
      const res = await fetchImpl(path);
      if (!res.ok) {
        throw new Error(`reconcile ${route.path} failed (${res.status})`);
      }
      return res.json().catch((error: unknown) => {
        // Name only. A JSON parse message can quote the response body.
        console.warn(
          'mesh presence reconcile body was not JSON',
          error instanceof Error ? error.name : typeof error,
        );
        return null;
      });
    };
    const cursorOf = (state: unknown): string | undefined => {
      const rec =
        state && typeof state === 'object'
          ? (state as { cursor?: unknown })
          : null;
      return typeof rec?.cursor === 'string' ? rec.cursor : undefined;
    };
    if (isWorkFeedPath(route.path)) {
      // GET /v1/work-mesh/work pages large feeds (hq-pro #5004). A
      // later-page failure throws and a capped walk keeps the old cursor, so
      // the sync cursor never moves past rows that were not read.
      const { state, truncated } = await fetchWorkFeedPages((pageCursor) =>
        fetchJson(workFeedPagePath(route.path, cursor, pageCursor)),
      );
      return { state, cursor: truncated ? undefined : cursorOf(state) };
    }
    const url = new URL(route.path, 'http://local.invalid');
    if (cursor) url.searchParams.set('cursor', cursor);
    const state = await fetchJson(`${url.pathname}${url.search}`);
    return { state, cursor: cursorOf(state) };
  };
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
    fetcher: createDesktopReconcileFetcher(fetchImpl),
    presenceStore,
    liveReadStore,
  });

  const unwire = wirePresenceStoreToChatBus(presenceStore, opts.wakes);
  const unbind = bindPresenceStore(presenceStore);
  const unbindLive = bindLiveReadStore(liveReadStore);
  const unbindRefresh = bindLiveRefresh((companyUid) => {
    client.refreshLive(companyUid);
  });

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
      unbindRefresh();
      client.stop();
    },
    presenceStore,
    presenceSnapshot: () => presenceStore.snapshot(),
    liveReadStore,
    client,
  };
}
