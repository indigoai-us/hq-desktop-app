/**
 * Hosted-web MeshClient: MQTT wakes → direct hq-pro REST.
 *
 * Does not read ~/.hq. Credential vend stays on the server
 * (POST /v1/realtime/credentials). The in-memory browser token is attached
 * by hq-pro-client. Failures are absent-safe — REST still works if the socket
 * never comes up.
 *
 * Presence (US-014): MeshClient owns the in-memory PresenceStore; changes are
 * fanned onto the chat bus as `presence:changed` and mirrored into the Svelte
 * runes snapshot for UI reads.
 */

import {
  MeshClient,
  PresenceStore,
  createWebCredentialProvider,
  type PresenceSnapshot,
} from "@hq/core";
import type { PlatformAdapter } from "@hq/platform";
import {
  bindPresenceStore,
  createChatWakeBus,
  routeMeshReconcile,
  routeMeshWake,
  wirePresenceStoreToChatBus,
} from "@hq/ui";
import { hqProFetch } from "./hq-pro-client.js";

export { routeMeshReconcile, routeMeshWake };

type WebWakeBus = ReturnType<typeof createChatWakeBus>;

export function createHqReconcileFetcher(
  fetchImpl: typeof fetch = hqProFetch,
): (
  route: { path: string },
  cursor?: string,
) => Promise<{ state: unknown; cursor?: string }> {
  return async (route, cursor) => {
    const url = new URL(route.path, "http://local.invalid");
    if (cursor) url.searchParams.set("cursor", cursor);
    const path = `${url.pathname}${url.search}`;
    const res = await fetchImpl(path);
    if (!res.ok) {
      throw new Error(`reconcile ${route.path} failed (${res.status})`);
    }
    const state = await res.json().catch(() => null);
    const rec =
      state && typeof state === "object"
        ? (state as { cursor?: unknown })
        : null;
    return {
      state,
      cursor: typeof rec?.cursor === "string" ? rec.cursor : undefined,
    };
  };
}

export function startWebMesh(opts: {
  wakes: WebWakeBus;
  onNotifications?: () => void;
  fetchImpl?: typeof fetch;
  presenceStore?: PresenceStore;
}): {
  stop: () => void;
  presenceStore: PresenceStore;
  presenceSnapshot: () => PresenceSnapshot;
} {
  const fetchImpl = opts.fetchImpl ?? hqProFetch;
  const presenceStore = opts.presenceStore ?? new PresenceStore();
  const client = new MeshClient({
    credentialProvider: createWebCredentialProvider({
      url: "/v1/realtime/credentials",
      fetchImpl: fetchImpl as never,
    }),
    fetcher: createHqReconcileFetcher(fetchImpl),
    presenceStore,
  });
  const unwirePresence = wirePresenceStoreToChatBus(presenceStore, opts.wakes);
  const unbindRunes = bindPresenceStore(presenceStore);
  client.on("wake", (topic, payloadText) => {
    console.info("[hq-web-mesh]", {
      event: "wake",
      topic,
      bytes: payloadText?.length ?? 0,
    });
    routeMeshWake(payloadText, opts.wakes);
  });
  client.on("presence", (change) => {
    console.info("[hq-web-mesh]", {
      event: "presence",
      companyUid: change.companyUid,
      actorUid: change.actorUid,
      status: change.status,
    });
  });
  client.on("catchup", (reason) => {
    console.info("[hq-web-mesh]", { event: "catchup", reason });
    opts.wakes.emit("mesh:catchup", { reason });
    opts.onNotifications?.();
  });
  client.on("connectionState", (state) => {
    console.info("[hq-web-mesh]", { event: "connection", state });
    opts.wakes.emit("mesh:connection", { state });
  });
  client.on("error", (err) => {
    console.warn("[hq-web-mesh]", { event: "error", err: String(err) });
  });
  client.on("reconciled", (result) => {
    const kind = routeMeshReconcile(result, opts.wakes);
    if (kind === "notifications") opts.onNotifications?.();
  });
  void client.start().catch((err) => {
    console.warn("web-mesh: MQTT not connected; REST still live", err);
  });
  return {
    stop: () => {
      unwirePresence();
      unbindRunes();
      client.stop();
    },
    presenceStore,
    presenceSnapshot: () => presenceStore.snapshot(),
  };
}

/** The browser token bridge exists only in the hosted web application. */
export function startWebMeshForAdapter(
  adapter: Pick<PlatformAdapter, "kind">,
  opts: Parameters<typeof startWebMesh>[0],
  start: typeof startWebMesh = startWebMesh,
): ReturnType<typeof startWebMesh> | null {
  return adapter.kind === "web" ? start(opts) : null;
}
