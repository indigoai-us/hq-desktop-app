/**
 * Wake-to-REST-reconcile.
 *
 * Every MQTT message is a WAKE SIGNAL ONLY. Its payload is never applied as
 * state. A wake maps its topic to a durable REST resource (hq-pro
 * /v1/work-mesh/*, /v1/notify/*) and triggers a cursor-reconciled re-fetch;
 * the REST response is the only source of truth.
 *
 * ## One exception: presence (work-mesh-live US-014)
 *
 * Messages on `hq/{companyUid}/presence/{actorUid}` (any topic whose third
 * segment is `presence`) are applied directly to the in-memory PresenceStore
 * and MUST NEVER enter WakeReconciler / trigger a REST reconcile. Presence
 * is connection truth from retained MQTT; REST (`GET /v1/work-mesh/live`) is
 * only used to rebuild the store on reconnect. Every other topic keeps the
 * wake-only contract below.
 *
 * Live wakes on `hq/{companyUid}/thread-directory` with `{ kind: "live" }`
 * also skip WakeReconciler: they trigger a coalesced live-read refresh into
 * the presence store (one in-flight fetch per company) instead.
 *
 * hq-pro `type:"thread"` (reply-thread doorbell) is ids-only routing: it
 * selects GET /v1/notify/threads instead of the person DM inbox. The body is
 * never taken from MQTT. This is not a work-mesh `hq/{company}/thread/{id}`
 * topic and must not be named `thread:` on the chat bus.
 *
 * Guarantees per resource:
 * - Coalescing: wakes arriving while a fetch is in flight collapse into ONE
 *   trailing re-fetch (never dropped, never stampeding).
 * - Ordering: reconciled results for a resource are emitted in fetch order;
 *   a stale in-flight fetch can never clobber a newer one because fetches for
 *   a resource are strictly serialized.
 */

/** A durable resource a wake maps to. */
export interface WakeRoute {
  /** Stable resource key used for coalescing/serialization. */
  resource: string;
  /** REST path to re-fetch (relative to the hq-pro API base). */
  path: string;
  /**
   * Ids-only reply-thread doorbell that selected this route. Never contains
   * message bodies; callers emit `reply:new` from these ids.
   */
  replyWake?: ReplyThreadWakeIds;
}

/** Ids-only hq-pro `type:"thread"` doorbell (US-021 / US-004). */
export interface ReplyThreadWakeIds {
  rootEventId: string;
  eventId: string;
  scope: "dm" | "channel";
  channelId?: string;
  withPersonUid?: string;
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Decode an MQTT payload into JSON. Strings, bytes, and objects are accepted. */
export function decodeWakePayload(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (raw instanceof Uint8Array) {
    try {
      return JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return null;
    }
  }
  if (ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw;
  return null;
}

/**
 * Parse an hq-pro reply-thread wake (`type:"thread"`). Work-mesh
 * `type:"thread_event"` and topic `hq/{company}/thread/{id}` do not match.
 * Returns ids only — never a body.
 */
export function parseReplyThreadWake(raw: unknown): ReplyThreadWakeIds | null {
  const obj = asRecord(decodeWakePayload(raw) ?? raw);
  if (!obj) return null;
  if (obj.type !== "thread") return null;
  const scope = obj.scope;
  if (scope !== "dm" && scope !== "channel") return null;
  const rootEventId = trimmedString(obj.rootEventId);
  const eventId = trimmedString(obj.eventId);
  if (!rootEventId || !eventId) return null;
  const channelId = trimmedString(obj.channelId);
  const withPersonUid =
    trimmedString(obj.withPersonUid) ||
    trimmedString(obj.counterpartyUid) ||
    (scope === "dm" ? trimmedString(obj.fromPersonUid) : "");
  return {
    rootEventId,
    eventId,
    scope,
    ...(scope === "channel" && channelId ? { channelId } : {}),
    ...(scope === "dm" && withPersonUid ? { withPersonUid } : {}),
  };
}

/** Targeted GET /v1/notify/threads for a `type:"thread"` wake — not a conversation GET. */
export function routeForReplyThreadWake(raw: unknown): WakeRoute | null {
  const wake = parseReplyThreadWake(raw);
  if (!wake) return null;
  const params = new URLSearchParams({
    rootEventId: wake.rootEventId,
    scope: wake.scope,
  });
  if (wake.scope === "channel" && wake.channelId) {
    params.set("channelId", wake.channelId);
  }
  if (wake.scope === "dm" && wake.withPersonUid) {
    params.set("withPersonUid", wake.withPersonUid);
  }
  return {
    resource: `reply:${wake.scope}:${wake.rootEventId}`,
    path: `/v1/notify/threads?${params.toString()}`,
    replyWake: wake,
  };
}

/**
 * Map an MQTT topic to its durable REST resource. Returns null for unknown
 * topics (still a wake — callers may log/ignore).
 *
 * Topic shapes:
 * - hq/{personUid}/dm             → /v1/notify/inbox
 *   (GET /v1/notify/dm is the send path and 404s)
 * - hq/{personUid}/work           → /v1/work-mesh/work
 *   (GET /v1/work-mesh/threads requires companyUid and 400s)
 * - hq/{personUid}/notifications  → /v1/notify/notifications
 * - hq/{companyUid}/thread/{id..} → /v1/work-mesh/companies/{companyUid}/threads/{id..}
 *
 * Presence (`hq/{companyUid}/presence/{actorUid}`) and live wakes on
 * `thread-directory` intentionally return null — MeshClient routes those
 * outside WakeReconciler (see module doc above).
 */
export function routeForTopic(topic: string): WakeRoute | null {
  const parts = topic.split("/");
  if (parts.length < 3 || parts[0] !== "hq") return null;
  const uid = parts[1];
  if (!uid) return null;
  const kind = parts[2];
  // Presence is the wake-only exception — never a REST route.
  if (kind === "presence") return null;
  if (parts.length === 3) {
    switch (kind) {
      case "dm":
        return { resource: `dm:${uid}`, path: "/v1/notify/inbox" };
      case "work":
        return { resource: `work:${uid}`, path: "/v1/work-mesh/work" };
      case "notifications":
        return {
          resource: `notifications:${uid}`,
          path: "/v1/notify/notifications",
        };
      // Directory wake topic — live kind handled by MeshClient, not here.
      case "thread-directory":
        return null;
      default:
        return null;
    }
  }
  if (kind === "thread") {
    const threadId = parts.slice(3).join("/");
    if (!threadId) return null;
    return {
      resource: `thread:${uid}:${threadId}`,
      path: `/v1/work-mesh/companies/${uid}/threads/${threadId}`,
    };
  }
  return null;
}

/** `hq/{companyUid}/thread-directory` exact topic. */
export function parseThreadDirectoryTopic(
  topic: string,
): { companyUid: string } | null {
  const parts = topic.split("/");
  if (parts.length !== 3 || parts[0] !== "hq" || parts[2] !== "thread-directory") {
    return null;
  }
  const companyUid = parts[1];
  return companyUid ? { companyUid } : null;
}

/**
 * Ids-only live wake published after session-event ingest
 * (`{ v:1, kind:"live", companyUid, sessionIds }`).
 */
export function parseLiveWake(
  raw: unknown,
): { companyUid: string; sessionIds: string[] } | null {
  const obj = asRecord(decodeWakePayload(raw) ?? raw);
  if (!obj) return null;
  if (obj.kind !== "live") return null;
  const companyUid = trimmedString(obj.companyUid);
  if (!companyUid) return null;
  const sessionIds = Array.isArray(obj.sessionIds)
    ? obj.sessionIds.filter((id): id is string => typeof id === "string" && id.trim() !== "")
    : [];
  return { companyUid, sessionIds };
}

/** Live-read path for one company (presence store rebuild / refresh). */
export function liveReadPath(companyUid: string): string {
  return `/v1/work-mesh/live?companyUid=${encodeURIComponent(companyUid)}`;
}

/** Result of a cursor-reconciled fetch. */
export interface ReconcileResult {
  resource: string;
  path: string;
  /** Durable state as returned by REST (opaque to the reconciler). */
  state: unknown;
  /** Cursor returned by REST, replayed on the next fetch of this resource. */
  cursor?: string;
  /** Ids-only reply doorbell that selected this resource. Not REST state. */
  replyWake?: ReplyThreadWakeIds;
}

/** Fetch seam: re-fetch a resource from REST, optionally from a cursor. */
export type ReconcileFetcher = (
  route: WakeRoute,
  cursor: string | undefined,
) => Promise<{ state: unknown; cursor?: string }>;

interface ResourceEntry {
  running: boolean;
  /** A wake arrived while a fetch was in flight — run one trailing fetch. */
  pending: boolean;
  cursor?: string;
  route: WakeRoute;
}

/**
 * Coalescing, per-resource-serialized wake reconciler.
 */
export class WakeReconciler {
  private readonly entries = new Map<string, ResourceEntry>();

  constructor(
    private readonly fetcher: ReconcileFetcher,
    private readonly onReconciled: (result: ReconcileResult) => void,
    private readonly onError: (
      resource: string,
      err: unknown,
    ) => void = () => {},
  ) {}

  /**
   * Handle a wake for `topic`. Payload is advisory routing only (hq-pro
   * `type:"thread"` vs `type:"channel"` / `type:"dm"` share `hq/{uid}/dm`)
   * and is never applied as state. Returns false for unroutable topics.
   */
  wake(topic: string, payload?: unknown): boolean {
    const reply = routeForReplyThreadWake(payload);
    if (reply) {
      this.wakeRoute(reply);
      return true;
    }
    const route = routeForTopic(topic);
    if (!route) return false;
    this.wakeRoute(route);
    return true;
  }

  /** Re-fetch every listed resource (used on reconnect for catch-up). */
  reconcileAll(routes: WakeRoute[]): void {
    for (const route of routes) this.wakeRoute(route);
  }

  /** Every route this reconciler has ever reconciled (reconnect catch-up). */
  knownRoutes(): WakeRoute[] {
    return [...this.entries.values()].map((e) => e.route);
  }

  private wakeRoute(route: WakeRoute): void {
    let entry = this.entries.get(route.resource);
    if (!entry) {
      entry = { running: false, pending: false, route };
      this.entries.set(route.resource, entry);
    } else {
      entry.route = route;
    }
    if (entry.running) {
      entry.pending = true; // coalesce: one trailing fetch covers all wakes
      return;
    }
    entry.running = true;
    void this.run(entry);
  }

  private async run(entry: ResourceEntry): Promise<void> {
    // Strictly serialized per resource: loop while wakes keep arriving.
    for (;;) {
      const route = entry.route;
      entry.pending = false;
      try {
        const { state, cursor } = await this.fetcher(route, entry.cursor);
        entry.cursor = cursor ?? entry.cursor;
        this.onReconciled({
          resource: route.resource,
          path: route.path,
          state,
          cursor: entry.cursor,
          ...(route.replyWake ? { replyWake: route.replyWake } : {}),
        });
      } catch (err) {
        this.onError(route.resource, err);
      }
      if (!entry.pending) break;
    }
    entry.running = false;
  }
}
