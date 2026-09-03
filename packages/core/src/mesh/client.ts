/**
 * MeshClient — shared MQTT realtime core for browser and webview shells.
 *
 * mqtt.js over a SigV4-presigned wss URL to AWS IoT Core, implementing the
 * wake-to-REST-reconcile pattern: every MQTT message is a wake only; durable
 * state always comes from REST re-fetch (see reconcile.ts).
 *
 * Presence exception (US-014): `hq/{companyUid}/presence/#` payloads are
 * applied to an in-memory PresenceStore and never wake REST. On reconnect the
 * store is rebuilt from GET /v1/work-mesh/live before subscribe; live wakes on
 * `thread-directory` coalesce one live-read refresh per company.
 *
 * Hardening (mirrors hq-console's notifications-mqtt):
 * - mqtt.js `timerVariant: 'native'` pinned (worker-timers breaks in webviews).
 * - `connect()` wrapped in try/catch — Safari can throw synchronously.
 * - Reconnect: capped exponential backoff with FULL jitter (own loop; mqtt.js
 *   auto-reconnect disabled so backoff + presign-refresh stay in our hands).
 * - Reconnection pauses while `document.hidden` (guarded for non-DOM hosts);
 *   a visibilitychange back to visible reconnects immediately.
 * - On credential renewal the client re-presigns and reconnects WITHOUT
 *   losing the subscription set (topics derive from the vended bundle and are
 *   re-subscribed on every connect).
 */

import mqtt, { type IClientOptions } from "mqtt";

import {
  channelWakeFromPayload,
  mqttPayloadToText,
  parseDmDeliveredWake,
  parseReplyThreadWake,
} from "./channel-wake.js";

import {
  CredentialRenewalManager,
  realTimerHost,
  type CredentialProvider,
  type MeshCredentialBundle,
  type TimerHost,
} from "./credentials.js";
import { presignIotWssUrl, type SigV4Crypto } from "./presign.js";
import {
  PresenceStore,
  isPresenceTopic,
  presenceFilterForCompany,
  type LiveParticipantPresence,
  type PresenceChange,
} from "./presence-store.js";
import {
  WakeReconciler,
  liveReadPath,
  parseLiveWake,
  parseThreadDirectoryTopic,
  routeForTopic,
  type ReconcileFetcher,
  type ReconcileResult,
  type WakeRoute,
} from "./reconcile.js";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "paused-hidden"
  | "closed";

/** Why the host should run cursor catch-up (never a full list refetch). */
export type CatchupReason = "connect" | "focus";

export interface MeshClientEvents {
  /**
   * A wake arrived on `topic`. `payloadText` is advisory-only (routing hint,
   * e.g. `{type:"channel",channelId,eventId,createdAt}`) — never applied as
   * durable state. Channel/thread payloads skip the topic-level REST route
   * (the shared DM topic must not refetch the inbox). Presence topics do not
   * emit `wake` — they emit `presence` instead.
   */
  wake: (topic: string, payloadText?: string) => void;
  /** Durable state re-fetched from REST after a wake/reconnect. */
  reconciled: (result: ReconcileResult) => void;
  /**
   * Presence store changed (MQTT retained/live payload or live-read rebuild).
   * Never accompanies a WakeReconciler fetch.
   */
  presence: (change: PresenceChange) => void;
  /**
   * Socket is live again (or the window is visible after a gap). Hosts run
   * cursor catch-up — directory delta, inbox `since`, open-timeline `since`.
   * MeshClient does not refetch person-scoped lists or known threads.
   */
  catchup: (reason: CatchupReason) => void;
  /** Companies excluded from the vended STS scope (2048-char policy cap). */
  droppedCompanies: (companyUids: string[]) => void;
  connectionState: (state: ConnectionState) => void;
  error: (err: unknown) => void;
}

/**
 * Fetch GET /v1/work-mesh/live for one company. Injected so tests stay offline.
 * Must return the participants array (presence fields) used to rebuild the store.
 */
export type LiveReadFetcher = (
  companyUid: string,
) => Promise<{ participants: LiveParticipantPresence[] }>;

/** Structural view of the mqtt.js client the MeshClient needs. */
export interface MeshMqttClientLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (...args: any[]) => void): unknown;
  subscribe(
    topics: string | string[],
    opts: { qos: 0 | 1 | 2 },
    callback?: (
      err?: Error | null,
      granted?: Array<{ topic: string; qos: number }>,
    ) => void,
  ): unknown;
  end(force?: boolean): unknown;
}

/** Seam over mqtt.connect for tests. */
export type MqttConnectFn = (
  url: string,
  opts: IClientOptions,
) => MeshMqttClientLike;

export interface MeshClientOptions {
  credentialProvider: CredentialProvider;
  /** REST re-fetch seam (hq-pro /v1/work-mesh/*, /v1/notify/*). */
  fetcher: ReconcileFetcher;
  /**
   * Company-wide live read for presence-store rebuild / live-wake refresh.
   * Defaults to `fetcher` against {@link liveReadPath} when omitted.
   */
  liveFetcher?: LiveReadFetcher;
  /** Optional shared presence store (tests / host wiring). */
  presenceStore?: PresenceStore;
  mqttConnect?: MqttConnectFn;
  timers?: TimerHost;
  sigv4Crypto?: SigV4Crypto;
  /** Random source for full jitter; injectable for deterministic tests. */
  random?: () => number;
  /** Document-like visibility host; defaults to global `document` if present. */
  visibilityHost?: VisibilityHost | null;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface VisibilityHost {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

function defaultVisibilityHost(): VisibilityHost | null {
  const doc = (globalThis as { document?: VisibilityHost }).document;
  return doc && typeof doc.addEventListener === "function" ? doc : null;
}

/** Full-jitter capped exponential backoff delay for `attempt` (0-based). */
export function backoffDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number,
): number {
  const cap = Math.min(maxMs, baseMs * 2 ** attempt);
  return random() * cap;
}

/** Per-person + per-company subscription set for a vended bundle. */
function dedupeRoutes(routes: WakeRoute[]): WakeRoute[] {
  const seen = new Set<string>();
  const out: WakeRoute[] = [];
  for (const route of routes) {
    if (seen.has(route.resource)) continue;
    seen.add(route.resource);
    out.push(route);
  }
  return out;
}

/**
 * Company-scoped filters for one entitled companyUid (AC1: count 1 → 2).
 * Always derived from companyUid (never from contract-1 `presenceTopic`, which
 * names the old exact topic and is still dropped in credentials normalization).
 */
export function companyTopicsForUid(companyUid: string): string[] {
  return [`hq/${companyUid}/thread/#`, presenceFilterForCompany(companyUid)];
}

export function topicsForBundle(bundle: MeshCredentialBundle): string[] {
  const p = bundle.personUid;
  const topics = [
    `hq/${p}/dm`,
    `hq/${p}/work`,
    `hq/${p}/notifications`,
    // US-008/US-009 feature-detect channel: work-session wakes (and retained
    // replays) arrive here once the backend publishes them; clients observe
    // the first one and flip the session feed from polling to wake-driven.
    `hq/${p}/work-session/#`,
  ];
  for (const companyUid of bundle.companyTopics) {
    // AC1: thread/# + presence/# (1 → 2 per company).
    topics.push(...companyTopicsForUid(companyUid));
    // AC3: exact directory topic so `{kind:"live"}` wakes reach the client.
    // Not counted in the AC1 pair — it is the existing directory-wake lane.
    topics.push(`hq/${companyUid}/thread-directory`);
  }
  return topics;
}

/**
 * Coalesced GET /v1/work-mesh/live per company — one in-flight fetch, one
 * trailing retry when wakes arrive during the flight (mirrors WakeReconciler).
 */
export class LiveReadCoalescer {
  private readonly entries = new Map<
    string,
    { running: boolean; pending: boolean }
  >();

  constructor(
    private readonly fetchLive: LiveReadFetcher,
    private readonly onParticipants: (
      companyUid: string,
      participants: LiveParticipantPresence[],
    ) => void,
    private readonly onError: (companyUid: string, err: unknown) => void = () => {},
  ) {}

  refresh(companyUid: string): void {
    const uid = companyUid.trim();
    if (!uid) return;
    let entry = this.entries.get(uid);
    if (!entry) {
      entry = { running: false, pending: false };
      this.entries.set(uid, entry);
    }
    if (entry.running) {
      entry.pending = true;
      return;
    }
    entry.running = true;
    void this.run(uid, entry);
  }

  /** Refresh every company (reconnect rebuild); awaits all fetches. */
  async refreshAll(companyUids: readonly string[]): Promise<void> {
    await Promise.all(
      companyUids.map(async (uid) => {
        const companyUid = uid.trim();
        if (!companyUid) return;
        try {
          const { participants } = await this.fetchLive(companyUid);
          this.onParticipants(companyUid, participants);
        } catch (err) {
          this.onError(companyUid, err);
        }
      }),
    );
  }

  private async run(
    companyUid: string,
    entry: { running: boolean; pending: boolean },
  ): Promise<void> {
    for (;;) {
      entry.pending = false;
      try {
        const { participants } = await this.fetchLive(companyUid);
        this.onParticipants(companyUid, participants);
      } catch (err) {
        this.onError(companyUid, err);
      }
      if (!entry.pending) break;
    }
    entry.running = false;
  }
}

function participantsFromLiveState(state: unknown): LiveParticipantPresence[] {
  const rec =
    state && typeof state === "object" && !Array.isArray(state)
      ? (state as Record<string, unknown>)
      : null;
  const rows = Array.isArray(rec?.participants)
    ? rec.participants
    : Array.isArray(state)
      ? state
      : [];
  const out: LiveParticipantPresence[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const actorUid = typeof r.actorUid === "string" ? r.actorUid.trim() : "";
    if (!actorUid) continue;
    out.push({
      actorUid,
      ...(typeof r.actorType === "string" ? { actorType: r.actorType } : {}),
      ...(typeof r.presence === "string" ? { presence: r.presence } : {}),
      ...(typeof r.lastSeenAt === "string" ? { lastSeenAt: r.lastSeenAt } : {}),
    });
  }
  return out;
}

export function createLiveReadFetcherFromReconcile(
  fetcher: ReconcileFetcher,
): LiveReadFetcher {
  return async (companyUid) => {
    const { state } = await fetcher(
      {
        resource: `live:${companyUid}`,
        path: liveReadPath(companyUid),
      },
      undefined,
    );
    return { participants: participantsFromLiveState(state) };
  };
}

/**
 * AWS IoT Core quota: subscriptions per Subscribe request. A 9th topic in the
 * same packet closes the socket with no SUBACK, so MeshClient never reaches
 * `connected` and off-screen wakes (Deacon DMs) never arrive.
 */
export const IOT_SUBSCRIBE_BATCH_SIZE = 8;

/** Split a topic list into IoT-legal Subscribe packets. */
export function chunkSubscribeTopics(
  topics: readonly string[],
  size: number = IOT_SUBSCRIBE_BATCH_SIZE,
): string[][] {
  const batch = Math.max(1, Math.floor(size));
  const out: string[][] = [];
  for (let i = 0; i < topics.length; i += batch) {
    out.push(topics.slice(i, i + batch));
  }
  return out;
}

export class MeshClient {
  private client: MeshMqttClientLike | null = null;
  private bundle: MeshCredentialBundle | null = null;
  private state: ConnectionState = "idle";
  private attempt = 0;
  private reconnectHandle: unknown = null;
  private stopped = false;
  private generation = 0;
  /**
   * When false, MQTT presence payloads are ignored so reconnect rebuild from
   * GET /v1/work-mesh/live finishes before retained/live messages apply.
   */
  private presenceAcceptMqtt = false;

  private readonly listeners: {
    [K in keyof MeshClientEvents]: Set<MeshClientEvents[K]>;
  } = {
    wake: new Set(),
    reconciled: new Set(),
    presence: new Set(),
    catchup: new Set(),
    droppedCompanies: new Set(),
    connectionState: new Set(),
    error: new Set(),
  };

  private readonly reconciler: WakeReconciler;
  private readonly renewal: CredentialRenewalManager;
  private readonly presenceStore: PresenceStore;
  private readonly liveCoalescer: LiveReadCoalescer;
  private readonly liveFetcher: LiveReadFetcher;
  private readonly mqttConnect: MqttConnectFn;
  private readonly timers: TimerHost;
  private readonly sigv4Crypto: SigV4Crypto | undefined;
  private readonly random: () => number;
  private readonly visibility: VisibilityHost | null;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly onVisibilityChange = (): void => {
    if (this.visibility && !this.visibility.hidden) {
      // Back to visible: reconnect immediately if we were paused.
      if (this.state === "paused-hidden") {
        this.attempt = 0;
        void this.connectOnce();
        return;
      }
      // Socket stayed up while hidden (QoS 0 may still have dropped).
      if (this.state === "connected") {
        this.emit("catchup", "focus");
      }
    }
  };

  constructor(private readonly options: MeshClientOptions) {
    this.mqttConnect =
      options.mqttConnect ??
      ((url, opts) => mqtt.connect(url, opts) as unknown as MeshMqttClientLike);
    this.timers = options.timers ?? realTimerHost;
    this.sigv4Crypto = options.sigv4Crypto;
    this.random = options.random ?? Math.random;
    this.visibility =
      options.visibilityHost === undefined
        ? defaultVisibilityHost()
        : options.visibilityHost;
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;

    this.presenceStore = options.presenceStore ?? new PresenceStore();
    this.liveFetcher =
      options.liveFetcher ?? createLiveReadFetcherFromReconcile(options.fetcher);
    this.liveCoalescer = new LiveReadCoalescer(
      this.liveFetcher,
      (companyUid, participants) => {
        const changes = this.presenceStore.replaceCompany(
          companyUid,
          participants,
        );
        for (const change of changes) this.emit("presence", change);
      },
      (_companyUid, err) => this.emit("error", err),
    );

    this.reconciler = new WakeReconciler(
      options.fetcher,
      (result) => this.emit("reconciled", result),
      (_resource, err) => this.emit("error", err),
    );
    this.renewal = new CredentialRenewalManager(
      options.credentialProvider,
      (bundle) => this.onCredentialsRenewed(bundle),
      (err) => this.emit("error", err),
      this.timers,
    );
  }

  /** In-memory presence store (MQTT exception + live-read rebuild). */
  getPresenceStore(): PresenceStore {
    return this.presenceStore;
  }

  on<K extends keyof MeshClientEvents>(
    event: K,
    listener: MeshClientEvents[K],
  ): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  private emit<K extends keyof MeshClientEvents>(
    event: K,
    ...args: Parameters<MeshClientEvents[K]>
  ): void {
    for (const listener of this.listeners[event]) {
      (listener as (...a: Parameters<MeshClientEvents[K]>) => void)(...args);
    }
  }

  getConnectionState(): ConnectionState {
    return this.state;
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit("connectionState", state);
  }

  /** Start the client: vend credentials, connect, subscribe. */
  async start(): Promise<void> {
    if (this.stopped) throw new Error("MeshClient already stopped");
    this.visibility?.addEventListener(
      "visibilitychange",
      this.onVisibilityChange,
    );
    this.setState("connecting");
    await this.connectOnce();
  }

  /** Stop permanently: tear down socket, timers, renewal. */
  stop(): void {
    this.stopped = true;
    // Invalidate the active generation: a connect/close from an in-flight
    // handshake must not resurrect a stopped client.
    this.generation++;
    this.renewal.stop();
    this.clearReconnect();
    this.visibility?.removeEventListener(
      "visibilitychange",
      this.onVisibilityChange,
    );
    this.teardownClient();
    this.setState("closed");
  }

  private teardownClient(): void {
    const client = this.client;
    if (client) {
      // Invalidate the reference BEFORE end(): events emitted during teardown
      // must never observe the dying socket as the current client.
      this.client = null;
      try {
        client.end(true);
      } catch {
        // best-effort teardown
      }
    }
  }

  private onCredentialsRenewed(bundle: MeshCredentialBundle): void {
    // Re-presign + reconnect with the fresh credentials. The subscription set
    // derives from the bundle, so it survives the reconnect by construction.
    this.bundle = bundle;
    this.emitDropped(bundle);
    if (this.stopped) return;
    // connectOnce() clears any pending backoff timer and tears down the old
    // socket itself, so a reconnect scheduled before renewal cannot race this
    // attempt and leak a duplicate connection.
    this.attempt = 0;
    void this.connectOnce();
  }

  private emitDropped(bundle: MeshCredentialBundle): void {
    // Always emitted (even empty) so consumers can clear a degraded-realtime
    // banner once a renewal restores full scope.
    this.emit("droppedCompanies", bundle.droppedCompanies);
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped) return;
    // A pending backoff timer would race this attempt and leak a duplicate
    // socket (renewal firing during 'reconnecting'); cancel it — this attempt
    // supersedes it. The generation is advanced BEFORE tearing down the old
    // socket so a `close` emitted synchronously from end(true) sees itself as
    // stale and cannot schedule a stray reconnect that would kill the fresh
    // socket. Then tear down any existing client so a socket is never orphaned
    // by reassignment.
    this.clearReconnect();
    const generation = ++this.generation;
    this.teardownClient();
    if (this.visibility?.hidden) {
      // Do not burn battery/radio reconnecting a hidden tab.
      this.setState("paused-hidden");
      return;
    }
    try {
      if (!this.bundle) {
        this.bundle = await this.options.credentialProvider.fetchCredentials();
        this.emitDropped(this.bundle);
        this.renewal.schedule(this.bundle);
      }
      const bundle = this.bundle;
      const url = await presignIotWssUrl(
        bundle.credentials,
        bundle.iotEndpoint,
        bundle.region,
        new Date(this.timers.now()),
        ...(this.sigv4Crypto ? [this.sigv4Crypto] : []),
      );
      if (this.stopped || generation !== this.generation) return;

      // Safari can throw synchronously from connect(); try/catch is mandatory.
      let client: MeshMqttClientLike;
      try {
        client = this.mqttConnect(url, {
          // worker-timers breaks in webviews/background tabs — pin native.
          timerVariant: "native",
          clean: true,
          // Our own backoff loop owns reconnection (presign must refresh).
          reconnectPeriod: 0,
          keepalive: 30,
          protocolVersion: 4,
        });
      } catch (err) {
        this.emit("error", err);
        this.scheduleReconnect();
        return;
      }
      this.client = client;

      client.on("connect", () => {
        if (this.stopped || generation !== this.generation) return;
        this.attempt = 0;
        // Rebuild presence from REST before subscribe so retained MQTT
        // payloads apply on top of a fresh live snapshot (never the reverse).
        this.presenceAcceptMqtt = false;
        void this.rebuildPresenceThenSubscribe(client, bundle, generation);
      });
      client.on("message", (topic: string, payload?: unknown) => {
        if (this.stopped || generation !== this.generation) return;
        this.handleMessage(topic, payload);
      });
      client.on("error", (err: Error) => {
        if (this.stopped || generation !== this.generation) return;
        this.emit("error", err);
      });
      client.on("close", () => {
        if (this.stopped || generation !== this.generation) return;
        this.scheduleReconnect();
      });
    } catch (err) {
      this.emit("error", err);
      this.scheduleReconnect();
    }
  }

  private async rebuildPresenceThenSubscribe(
    client: MeshMqttClientLike,
    bundle: MeshCredentialBundle,
    generation: number,
  ): Promise<void> {
    try {
      await this.liveCoalescer.refreshAll(bundle.companyTopics);
    } catch (err) {
      this.emit("error", err);
    }
    if (this.stopped || generation !== this.generation) return;
    // Accept MQTT presence only after the live rebuild so reconnect never
    // applies stale retained payloads on top of an empty/partial store first.
    this.presenceAcceptMqtt = true;
    const topics = topicsForBundle(bundle);
    // Subscription establishment is part of becoming connected: a
    // subscribe failure (transport error or per-topic qos-128 rejection)
    // forces a full reconnect cycle rather than sitting "connected" deaf.
    // AWS IoT closes the socket if one Subscribe packet lists more than
    // IOT_SUBSCRIBE_BATCH_SIZE topics — batch, then mark connected.
    // Retained presence messages seed the store as they arrive post-subscribe.
    this.subscribeAll(client, topics, generation, (err) => {
      if (this.stopped || generation !== this.generation) return;
      if (err) {
        this.emit("error", err);
        this.scheduleReconnect();
        return;
      }
      this.setState("connected");
      // Reconnect catch-up: wakes may have been missed while offline.
      const routes = [
        `hq/${bundle.personUid}/dm`,
        `hq/${bundle.personUid}/work`,
        `hq/${bundle.personUid}/notifications`,
      ]
        .map((t) => routeForTopic(t))
        .filter((r): r is WakeRoute => r !== null)
        .concat(this.reconciler.knownRoutes());
      this.reconciler.reconcileAll(dedupeRoutes(routes));
      this.emit("catchup", "connect");
    });
  }

  /**
   * Route one MQTT message. Presence never reaches WakeReconciler. Live wakes
   * on thread-directory coalesce a live-read refresh. Everything else keeps
   * the wake-only contract.
   */
  private handleMessage(topic: string, payload?: unknown): void {
    // Presence lane — apply to store, never REST reconcile.
    if (isPresenceTopic(topic)) {
      if (!this.presenceAcceptMqtt) return;
      const change = this.presenceStore.applyMqtt(topic, payload);
      if (change) this.emit("presence", change);
      return;
    }

    const dir = parseThreadDirectoryTopic(topic);
    const live = dir ? parseLiveWake(payload) : null;
    if (dir && live) {
      // Ids-only live wake → coalesced GET /v1/work-mesh/live (not WakeReconciler).
      this.liveCoalescer.refresh(live.companyUid || dir.companyUid);
      const payloadText = mqttPayloadToText(payload);
      this.emit("wake", topic, payloadText);
      return;
    }

    const payloadText = mqttPayloadToText(payload);
    this.emit("wake", topic, payloadText);
    // type:channel / inbound type:dm / type:thread share hq/{uid}/dm.
    // Skip topic REST: GET /v1/notify/dm is the send path (404). The
    // host fetches GET /v1/notify/inbox on dm:new-message. type:thread
    // is ids-only: the host emits reply:new from the wake and the open
    // panel re-fetches GET /v1/notify/threads. Reconciling here would
    // emit reply:new a second time and bump closed-panel "N replies"
    // twice. Untyped dm-topic wakes GET inbox.
    if (
      !channelWakeFromPayload(payloadText) &&
      !parseDmDeliveredWake(payloadText) &&
      !parseReplyThreadWake(payloadText)
    ) {
      this.reconciler.wake(topic, payload);
    }
  }

  /**
   * Subscribe `topics` in IoT-legal packets. `onDone` is called once with
   * either the first batch error or no argument after every batch SUBACKs.
   */
  private subscribeAll(
    client: MeshMqttClientLike,
    topics: string[],
    generation: number,
    onDone: (err?: Error) => void,
  ): void {
    const batches = chunkSubscribeTopics(topics);
    if (batches.length === 0) {
      onDone();
      return;
    }
    let index = 0;
    const next = (): void => {
      if (this.stopped || generation !== this.generation) return;
      if (index >= batches.length) {
        onDone();
        return;
      }
      const batch = batches[index++];
      client.subscribe(batch, { qos: 0 }, (err, granted) => {
        if (this.stopped || generation !== this.generation) return;
        const rejected = (granted ?? []).filter((g) => g.qos === 128);
        if (err || rejected.length > 0) {
          onDone(
            err ??
              new Error(
                `subscription rejected: ${rejected
                  .map((g) => g.topic)
                  .join(", ")}`,
              ),
          );
          return;
        }
        next();
      });
    };
    next();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.teardownClient();
    if (this.visibility?.hidden) {
      this.setState("paused-hidden");
      return;
    }
    this.setState("reconnecting");
    this.clearReconnect();
    const delay = backoffDelayMs(
      this.attempt,
      this.baseBackoffMs,
      this.maxBackoffMs,
      this.random,
    );
    this.attempt += 1;
    this.reconnectHandle = this.timers.setTimeout(() => {
      this.reconnectHandle = null;
      void this.connectOnce();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectHandle !== null) {
      this.timers.clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
  }
}
