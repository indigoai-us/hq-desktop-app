/**
 * MeshClient — shared MQTT realtime core for browser and webview shells.
 *
 * mqtt.js over a SigV4-presigned wss URL to AWS IoT Core, implementing the
 * wake-to-REST-reconcile pattern: every MQTT message is a wake only; durable
 * state always comes from REST re-fetch (see reconcile.ts).
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
  WakeReconciler,
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
   * (the shared DM topic must not refetch the inbox).
   */
  wake: (topic: string, payloadText?: string) => void;
  /** Durable state re-fetched from REST after a wake/reconnect. */
  reconciled: (result: ReconcileResult) => void;
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
    topics.push(`hq/${companyUid}/thread/#`);
  }
  return topics;
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

  private readonly listeners: {
    [K in keyof MeshClientEvents]: Set<MeshClientEvents[K]>;
  } = {
    wake: new Set(),
    reconciled: new Set(),
    catchup: new Set(),
    droppedCompanies: new Set(),
    connectionState: new Set(),
    error: new Set(),
  };

  private readonly reconciler: WakeReconciler;
  private readonly renewal: CredentialRenewalManager;
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
        const topics = topicsForBundle(bundle);
        // Subscription establishment is part of becoming connected: a
        // subscribe failure (transport error or per-topic qos-128 rejection)
        // forces a full reconnect cycle rather than sitting "connected" deaf.
        // AWS IoT closes the socket if one Subscribe packet lists more than
        // IOT_SUBSCRIBE_BATCH_SIZE topics — batch, then mark connected.
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
      });
      client.on("message", (topic: string, payload?: unknown) => {
        if (this.stopped || generation !== this.generation) return;
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
