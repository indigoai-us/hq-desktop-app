import { createHash, createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MeshClient,
  backoffDelayMs,
  chunkSubscribeTopics,
  IOT_SUBSCRIBE_BATCH_SIZE,
  topicsForBundle,
  type MqttConnectFn,
  type VisibilityHost,
} from "./client.js";
import {
  CredentialRenewalManager,
  renewalDelayMs,
  type CredentialProvider,
  type MeshCredentialBundle,
  type TimerHost,
} from "./credentials.js";
import type { SigV4Crypto } from "./presign.js";
import { WakeReconciler, routeForTopic } from "./reconcile.js";

/**
 * Synchronous SigV4 crypto (node:crypto) whose promises resolve as plain
 * microtasks. The default WebCrypto seam completes on Node's threadpool — a
 * REAL async event that can land after the fixed number of macrotask hops
 * `settle()`/`FakeTimers.advance()` wait, which made these tests flake under
 * full-suite CPU load. With a sync implementation every presign chain
 * deterministically resolves within the hops the harness already awaits.
 */
const syncSigV4Crypto: SigV4Crypto = {
  sha256Hex: (data) =>
    Promise.resolve(createHash("sha256").update(data).digest("hex")),
  hmac: (key, data) =>
    Promise.resolve(
      new Uint8Array(createHmac("sha256", key).update(data).digest()),
    ),
};

// ---------------------------------------------------------------------------
// Test harness pieces
// ---------------------------------------------------------------------------

/** Deterministic manual timer host. */
class FakeTimers implements TimerHost {
  private timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;
  current = 0;

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  now(): number {
    return this.current;
  }
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.current = due[1].at;
      this.timers.delete(due[0]);
      due[1].fn();
      // Real macrotask hop so async chains (WebCrypto presign) resolve.
      await new Promise((r) => setTimeout(r, 0));
    }
    this.current = target;
  }
}

type Handler = (...args: unknown[]) => void;

class FakeMqttClient {
  handlers = new Map<string, Handler[]>();
  subscribed: string[][] = [];
  ended = 0;

  on(event: string, handler: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }
  subscribeError: Error | null = null;
  subscribeGranted: Array<{ topic: string; qos: number }> | null = null;
  /** 1-based subscribe call to fail; null fails none extra. */
  subscribeFailOnCall: number | null = null;

  subscribe(
    topics: string | string[],
    _opts: unknown,
    cb?: (
      err?: Error | null,
      granted?: Array<{ topic: string; qos: number }>,
    ) => void,
  ): this {
    const list = Array.isArray(topics) ? topics : [topics];
    this.subscribed.push(list);
    const fail =
      this.subscribeError ??
      (this.subscribeFailOnCall === this.subscribed.length
        ? new Error("later Subscribe batch failed")
        : null);
    cb?.(
      fail ?? undefined,
      this.subscribeGranted ?? list.map((topic) => ({ topic, qos: 0 })),
    );
    return this;
  }
  end(_force?: boolean): this {
    this.ended++;
    return this;
  }
  fire(event: string, ...args: unknown[]): void {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
}

function bundle(
  overrides: Partial<MeshCredentialBundle> = {},
): MeshCredentialBundle {
  return {
    credentials: {
      accessKeyId: "AKIA1",
      secretAccessKey: "secret1",
      sessionToken: "token1",
    },
    expiration: new Date(3_600_000).toISOString(), // 1h from epoch
    iotEndpoint: "example-ats.iot.us-east-1.amazonaws.com",
    region: "us-east-1",
    personUid: "prs_alice",
    companyTopics: ["cmp_acme"],
    droppedCompanies: [],
    ...overrides,
  };
}

interface Harness {
  client: MeshClient;
  timers: FakeTimers;
  mqttClients: FakeMqttClient[];
  connectUrls: string[];
  fetchCalls: string[];
  vendCount: () => number;
  events: Record<string, unknown[][]>;
}

function makeHarness(
  opts: {
    bundles?: MeshCredentialBundle[];
    visibility?: VisibilityHost | null;
    connectThrows?: number; // first N connect() calls throw synchronously
    random?: () => number;
  } = {},
): Harness {
  const timers = new FakeTimers();
  const mqttClients: FakeMqttClient[] = [];
  const connectUrls: string[] = [];
  const fetchCalls: string[] = [];
  let vends = 0;
  let throwsLeft = opts.connectThrows ?? 0;
  const bundles = opts.bundles ?? [bundle()];

  const provider: CredentialProvider = {
    fetchCredentials: () => {
      const b = bundles[Math.min(vends, bundles.length - 1)];
      vends++;
      return Promise.resolve(b);
    },
  };
  const mqttConnect: MqttConnectFn = (url) => {
    if (throwsLeft > 0) {
      throwsLeft--;
      throw new Error("Safari sync throw");
    }
    connectUrls.push(url);
    const c = new FakeMqttClient();
    mqttClients.push(c);
    return c;
  };
  const events: Record<string, unknown[][]> = {
    wake: [],
    reconciled: [],
    droppedCompanies: [],
    connectionState: [],
    catchup: [],
    error: [],
  };
  const client = new MeshClient({
    credentialProvider: provider,
    fetcher: (route) => {
      fetchCalls.push(route.path);
      return Promise.resolve({ state: { path: route.path }, cursor: "c1" });
    },
    mqttConnect,
    timers,
    sigv4Crypto: syncSigV4Crypto,
    random: opts.random ?? (() => 1),
    visibilityHost: opts.visibility ?? null,
  });
  for (const name of Object.keys(events)) {
    client.on(name as "wake", (...args: unknown[]) => {
      events[name].push(args);
    });
  }
  return {
    client,
    timers,
    mqttClients,
    connectUrls,
    fetchCalls,
    vendCount: () => vends,
    events,
  };
}

async function settle(): Promise<void> {
  // Real macrotask hops so async presign (WebCrypto) chains fully resolve.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// routeForTopic + subscription set
// ---------------------------------------------------------------------------

describe("routeForTopic", () => {
  it("maps person and company topics to REST paths", () => {
    expect(routeForTopic("hq/prs_a/dm")?.path).toBe("/v1/notify/inbox");
    expect(routeForTopic("hq/prs_a/work")?.path).toBe("/v1/work-mesh/work");
    expect(routeForTopic("hq/prs_a/notifications")?.path).toBe(
      "/v1/notify/notifications",
    );
    expect(routeForTopic("hq/cmp_x/thread/t1")?.path).toBe(
      "/v1/work-mesh/companies/cmp_x/threads/t1",
    );
    expect(routeForTopic("hq/cmp_x/bogus")).toBeNull();
    expect(routeForTopic("nope/x/dm")).toBeNull();
  });
});

describe("topicsForBundle", () => {
  it("includes person topics plus one thread wildcard per company", () => {
    expect(topicsForBundle(bundle({ companyTopics: ["c1", "c2"] }))).toEqual([
      "hq/prs_alice/dm",
      "hq/prs_alice/work",
      "hq/prs_alice/notifications",
      "hq/prs_alice/work-session/#",
      "hq/c1/thread/#",
      "hq/c2/thread/#",
    ]);
  });
});

describe("chunkSubscribeTopics", () => {
  it("keeps packets at the AWS IoT Subscribe quota", () => {
    expect(IOT_SUBSCRIBE_BATCH_SIZE).toBe(8);
    expect(chunkSubscribeTopics([])).toEqual([]);
    expect(chunkSubscribeTopics(["a", "b", "c"], 8)).toEqual([["a", "b", "c"]]);
    const nine = Array.from({ length: 9 }, (_, i) => `t${i}`);
    expect(chunkSubscribeTopics(nine)).toEqual([nine.slice(0, 8), ["t8"]]);
    expect(
      chunkSubscribeTopics(nine).every(
        (batch) => batch.length <= IOT_SUBSCRIBE_BATCH_SIZE,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wake → reconcile ordering + coalescing
// ---------------------------------------------------------------------------

describe("WakeReconciler", () => {
  it("payloads are never applied — every wake triggers a REST re-fetch", async () => {
    const results: string[] = [];
    const reconciler = new WakeReconciler(
      (route) => Promise.resolve({ state: `rest:${route.path}` }),
      (r) => results.push(r.state as string),
    );
    reconciler.wake("hq/prs_a/dm");
    await settle();
    expect(results).toEqual(["rest:/v1/notify/inbox"]);
  });

  it("coalesces concurrent wakes into one trailing fetch", async () => {
    let resolvers: Array<(v: { state: unknown }) => void> = [];
    let fetches = 0;
    const reconciler = new WakeReconciler(
      () => {
        fetches++;
        return new Promise((res) => resolvers.push(res));
      },
      () => {},
    );
    reconciler.wake("hq/prs_a/work");
    reconciler.wake("hq/prs_a/work");
    reconciler.wake("hq/prs_a/work");
    expect(fetches).toBe(1);
    resolvers.shift()!({ state: 1 });
    await settle();
    // The three wakes collapse to exactly one trailing fetch.
    expect(fetches).toBe(2);
    resolvers.shift()!({ state: 2 });
    await settle();
    expect(fetches).toBe(2);
  });

  it("serializes fetches per resource so results emit in fetch order", async () => {
    const emitted: number[] = [];
    let call = 0;
    const resolvers: Array<() => void> = [];
    const reconciler = new WakeReconciler(
      () => {
        const n = ++call;
        return new Promise((res) => resolvers.push(() => res({ state: n })));
      },
      (r) => emitted.push(r.state as number),
    );
    reconciler.wake("hq/cmp_x/thread/t1");
    reconciler.wake("hq/cmp_x/thread/t1"); // queued behind in-flight
    resolvers.shift()!();
    await settle();
    resolvers.shift()!();
    await settle();
    expect(emitted).toEqual([1, 2]); // never out of order
  });

  it("threads the cursor from one fetch into the next", async () => {
    const cursors: Array<string | undefined> = [];
    let n = 0;
    const reconciler = new WakeReconciler(
      (_route, cursor) => {
        cursors.push(cursor);
        return Promise.resolve({ state: null, cursor: `cur-${++n}` });
      },
      () => {},
    );
    reconciler.wake("hq/prs_a/dm");
    await settle();
    reconciler.wake("hq/prs_a/dm");
    await settle();
    expect(cursors).toEqual([undefined, "cur-1"]);
  });

  it("independent resources reconcile independently", async () => {
    let fetches = 0;
    const reconciler = new WakeReconciler(
      () => {
        fetches++;
        return new Promise(() => {}); // never resolves
      },
      () => {},
    );
    reconciler.wake("hq/prs_a/dm");
    reconciler.wake("hq/prs_a/work");
    expect(fetches).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Proactive credential renewal
// ---------------------------------------------------------------------------

describe("renewalDelayMs", () => {
  it("uses min(80% lifetime, expiry-5min)", () => {
    const hour = 3_600_000;
    // 1h lifetime: 80% = 48min; expiry-5min = 55min → 48min wins.
    expect(renewalDelayMs(0, new Date(hour).toISOString())).toBe(hour * 0.8);
    // 10min lifetime: 80% = 8min; expiry-5min = 5min → 5min wins.
    expect(renewalDelayMs(0, new Date(600_000).toISOString())).toBe(300_000);
  });

  it("floors at a minimum delay for bogus/short expiries", () => {
    expect(renewalDelayMs(0, new Date(1_000).toISOString())).toBe(5_000);
    expect(renewalDelayMs(0, "not-a-date")).toBe(30 * 60_000);
  });
});

describe("CredentialRenewalManager", () => {
  it("renews proactively before expiry and reschedules (fake timers)", async () => {
    const timers = new FakeTimers();
    const renewed: MeshCredentialBundle[] = [];
    let vends = 0;
    const mgr = new CredentialRenewalManager(
      {
        fetchCredentials: () => {
          vends++;
          return Promise.resolve(
            bundle({
              expiration: new Date(timers.now() + 3_600_000).toISOString(),
            }),
          );
        },
      },
      (b) => renewed.push(b),
      () => {},
      timers,
    );
    mgr.schedule(bundle({ expiration: new Date(3_600_000).toISOString() }));
    await timers.advance(3_600_000 * 0.8);
    expect(vends).toBe(1);
    expect(renewed).toHaveLength(1);
    // Rescheduled off the fresh bundle: another 80%-of-1h later it renews again.
    await timers.advance(3_600_000 * 0.8);
    expect(vends).toBe(2);
    mgr.stop();
  });

  it("retries on renewal failure without stopping", async () => {
    const timers = new FakeTimers();
    const errors: unknown[] = [];
    let calls = 0;
    const mgr = new CredentialRenewalManager(
      {
        fetchCredentials: () => {
          calls++;
          return calls === 1
            ? Promise.reject(new Error("vend down"))
            : Promise.resolve(
                bundle({
                  expiration: new Date(timers.now() + 3_600_000).toISOString(),
                }),
              );
        },
      },
      () => {},
      (e) => errors.push(e),
      timers,
      30_000,
    );
    mgr.schedule(bundle({ expiration: new Date(3_600_000).toISOString() }));
    await timers.advance(3_600_000 * 0.8);
    expect(errors).toHaveLength(1);
    await timers.advance(30_000);
    expect(calls).toBe(2);
    mgr.stop();
  });
});

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

describe("backoffDelayMs", () => {
  it("caps exponential growth and applies full jitter", () => {
    // random()=1 → the full cap; verify exponential-then-capped shape.
    expect(backoffDelayMs(0, 1_000, 60_000, () => 1)).toBe(1_000);
    expect(backoffDelayMs(3, 1_000, 60_000, () => 1)).toBe(8_000);
    expect(backoffDelayMs(10, 1_000, 60_000, () => 1)).toBe(60_000);
    // Full jitter: random scales the whole range down to 0.
    expect(backoffDelayMs(10, 1_000, 60_000, () => 0)).toBe(0);
    expect(backoffDelayMs(10, 1_000, 60_000, () => 0.5)).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// MeshClient integration behaviors
// ---------------------------------------------------------------------------

describe("MeshClient", () => {
  it("connects, subscribes the full set, and reconciles catch-up on connect", async () => {
    const h = makeHarness();
    await h.client.start();
    await settle();
    expect(h.mqttClients).toHaveLength(1);
    expect(h.connectUrls[0]).toContain("wss://");
    expect(h.connectUrls[0]).toContain("X-Amz-Security-Token=");
    h.mqttClients[0].fire("connect");
    await settle();
    expect(h.mqttClients[0].subscribed.flat()).toEqual([
      "hq/prs_alice/dm",
      "hq/prs_alice/work",
      "hq/prs_alice/notifications",
      "hq/prs_alice/work-session/#",
      "hq/cmp_acme/thread/#",
    ]);
    expect(
      h.mqttClients[0].subscribed.every(
        (batch) => batch.length <= IOT_SUBSCRIBE_BATCH_SIZE,
      ),
    ).toBe(true);
    expect(h.fetchCalls).toEqual(
      expect.arrayContaining([
        "/v1/notify/inbox",
        "/v1/work-mesh/work",
        "/v1/notify/notifications",
      ]),
    );
    expect(h.events.catchup).toEqual([["connect"]]);
    expect(h.client.getConnectionState()).toBe("connected");
  });

  it("batches Subscribe packets so a 5-company vend still reaches connected", async () => {
    const companies = ["c1", "c2", "c3", "c4", "c5"];
    const h = makeHarness({
      bundles: [bundle({ companyTopics: companies })],
    });
    await h.client.start();
    await settle();
    h.mqttClients[0].fire("connect");
    await settle();
    const packets = h.mqttClients[0].subscribed;
    const topics = topicsForBundle(bundle({ companyTopics: companies }));
    expect(topics).toHaveLength(9);
    expect(packets.length).toBeGreaterThan(1);
    expect(
      packets.every((batch) => batch.length <= IOT_SUBSCRIBE_BATCH_SIZE),
    ).toBe(true);
    expect(packets.flat()).toEqual(topics);
    expect(h.client.getConnectionState()).toBe("connected");
    expect(h.events.catchup).toEqual([["connect"]]);
  });

  it("does not refetch the DM inbox for a targeted channel wake", async () => {
    const h = makeHarness();
    await h.client.start();
    await settle();
    h.mqttClients[0].fire("connect");
    await settle();
    h.fetchCalls.length = 0;
    const payload = JSON.stringify({
      type: "channel",
      channelId: "chn_x",
      eventId: "evt_1",
      createdAt: "2026-08-18T12:00:00.000Z",
    });
    h.mqttClients[0].fire(
      "message",
      "hq/prs_alice/dm",
      new TextEncoder().encode(payload),
    );
    await settle();
    expect(h.events.wake).toEqual([["hq/prs_alice/dm", payload]]);
    expect(h.fetchCalls).toEqual([]);
  });

  it("does not refetch GET /v1/notify/threads for a targeted type:thread wake", async () => {
    const h = makeHarness();
    await h.client.start();
    await settle();
    h.mqttClients[0].fire("connect");
    await settle();
    h.fetchCalls.length = 0;
    const payload = JSON.stringify({
      type: "thread",
      scope: "dm",
      rootEventId: "evt_root",
      eventId: "evt_reply",
      fromPersonUid: "agt_grok",
    });
    h.mqttClients[0].fire(
      "message",
      "hq/prs_alice/dm",
      new TextEncoder().encode(payload),
    );
    await settle();
    expect(h.events.wake).toEqual([["hq/prs_alice/dm", payload]]);
    expect(h.fetchCalls).toEqual([]);
  });

  it("does not refetch GET /v1/notify/dm for a targeted type:dm wake", async () => {
    const h = makeHarness();
    await h.client.start();
    await settle();
    h.mqttClients[0].fire("connect");
    await settle();
    h.fetchCalls.length = 0;
    const payload = JSON.stringify({
      type: "dm",
      fromPersonUid: "agt_deacon",
      eventId: "evt_dm",
      createdAt: "2026-08-22T19:00:00.000Z",
    });
    h.mqttClients[0].fire(
      "message",
      "hq/prs_alice/dm",
      new TextEncoder().encode(payload),
    );
    await settle();
    expect(h.events.wake).toEqual([["hq/prs_alice/dm", payload]]);
    expect(h.fetchCalls).toEqual([]);
  });

  it("still refetches the DM inbox when the dm-topic wake is not targeted", async () => {
    const h = makeHarness();
    await h.client.start();
    await settle();
    h.mqttClients[0].fire("connect");
    await settle();
    h.fetchCalls.length = 0;
    h.mqttClients[0].fire(
      "message",
      "hq/prs_alice/dm",
      new TextEncoder().encode(JSON.stringify({ type: "dm" })),
    );
    await settle();
    expect(h.fetchCalls).toEqual(["/v1/notify/inbox"]);
  });

  it("treats messages as wakes and re-fetches from REST (payload ignored)", async () => {
    const h = makeHarness();
    await h.client.start();
    await settle();
    h.mqttClients[0].fire("connect");
    await settle();
    h.fetchCalls.length = 0;
    h.mqttClients[0].fire(
      "message",
      "hq/cmp_acme/thread/t42",
      new TextEncoder().encode('{"sneaky":"payload-state"}'),
    );
    await settle();
    expect(h.events.wake).toEqual([
      ["hq/cmp_acme/thread/t42", '{"sneaky":"payload-state"}'],
    ]);
    expect(h.fetchCalls).toEqual([
      "/v1/work-mesh/companies/cmp_acme/threads/t42",
    ]);
    const reconciled = h.events.reconciled.map((a) => a[0]) as Array<{
      state: unknown;
    }>;
    // Reconciled state comes from the fetcher, never the MQTT payload.
    expect(reconciled.at(-1)?.state).toEqual({
      path: "/v1/work-mesh/companies/cmp_acme/threads/t42",
    });
  });

  it("reconnects with capped-backoff delays on close", async () => {
    const h = makeHarness({ random: () => 1 });
    await h.client.start();
    await settle();
    h.mqttClients[0].fire("connect");
    await settle();
    h.mqttClients[0].fire("close");
    expect(h.client.getConnectionState()).toBe("reconnecting");
    await h.timers.advance(1_000); // attempt 0 → base * 2^0
    await settle();
    expect(h.mqttClients).toHaveLength(2);
    h.mqttClients[1].fire("close");
    await h.timers.advance(1_999);
    await settle();
    expect(h.mqttClients).toHaveLength(2); // attempt 1 needs 2000ms
    await h.timers.advance(1);
    await settle();
    expect(h.mqttClients).toHaveLength(3);
  });

  it("handles Safari-style synchronous connect() throws by backing off", async () => {
    const h = makeHarness({ connectThrows: 1 });
    await h.client.start();
    await settle();
    expect(h.events.error).toHaveLength(1);
    expect(h.client.getConnectionState()).toBe("reconnecting");
    await h.timers.advance(1_000);
    await settle();
    expect(h.mqttClients).toHaveLength(1); // second attempt succeeded
  });

  it("pauses reconnection while document.hidden and resumes on visible", async () => {
    let hidden = false;
    const listeners: Array<() => void> = [];
    const visibility: VisibilityHost = {
      get hidden() {
        return hidden;
      },
      addEventListener: (_t, l) => listeners.push(l),
      removeEventListener: (_t, l) => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      },
    };
    const h = makeHarness({ visibility });
    await h.client.start();
    await settle();
    h.mqttClients[0].fire("connect");
    await settle();
    hidden = true;
    h.mqttClients[0].fire("close");
    expect(h.client.getConnectionState()).toBe("paused-hidden");
    await h.timers.advance(600_000);
    await settle();
    expect(h.mqttClients).toHaveLength(1); // no reconnect while hidden
    hidden = false;
    for (const l of listeners) l();
    await settle();
    expect(h.mqttClients).toHaveLength(2); // immediate reconnect on visible
  });

  it("reconnects with fresh presign on credential renewal without losing subscriptions", async () => {
    const first = bundle();
    const second = bundle({
      credentials: {
        accessKeyId: "AKIA2",
        secretAccessKey: "secret2",
        sessionToken: "token2",
      },
      expiration: new Date(2 * 3_600_000).toISOString(),
    });
    const h = makeHarness({ bundles: [first, second] });
    await h.client.start();
    await settle();
    h.mqttClients[0].fire("connect");
    await settle();
    // Advance to the proactive renewal point (80% of 1h).
    await h.timers.advance(3_600_000 * 0.8);
    await settle();
    expect(h.vendCount()).toBe(2);
    expect(h.mqttClients[0].ended).toBeGreaterThan(0); // old socket torn down
    expect(h.mqttClients).toHaveLength(2);
    // New URL presigned with the renewed credentials.
    expect(h.connectUrls[1]).toContain("AKIA2");
    h.mqttClients[1].fire("connect");
    await settle();
    // Identical subscription set re-established after renewal reconnect.
    expect(h.mqttClients[1].subscribed.flat()).toEqual(
      h.mqttClients[0].subscribed.flat(),
    );
  });

  it("renewal during a pending backoff does not leak a duplicate socket", async () => {
    const first = bundle();
    const second = bundle({
      credentials: {
        accessKeyId: "AKIA2",
        secretAccessKey: "secret2",
        sessionToken: "token2",
      },
      expiration: new Date(2 * 3_600_000).toISOString(),
    });
    // random()=1 pushes backoff delays PAST the renewal point so the backoff
    // timer is still pending when renewal fires.
    const h = makeHarness({ bundles: [first, second], random: () => 1 });
    await h.client.start();
    await settle();
    h.mqttClients[0].fire("connect");
    await settle();
    // Enter 'reconnecting' just before the 80%-of-1h renewal, leaving a
    // pending backoff timer that straddles the renewal.
    await h.timers.advance(3_600_000 * 0.8 - 1_000);
    h.mqttClients[0].fire("close");
    expect(h.client.getConnectionState()).toBe("reconnecting");
    // Renewal fires while the backoff timer is still pending; then advance
    // through where the stale backoff timer would have fired.
    await h.timers.advance(120_000);
    await settle();
    expect(h.vendCount()).toBe(2);
    // Exactly ONE renewal-driven connect attempt — the stale backoff timer
    // was cancelled and did not create a second, orphaned client.
    expect(h.mqttClients).toHaveLength(2);
    expect(h.connectUrls[1]).toContain("AKIA2");
    // The superseded socket was end()ed, never leaked.
    expect(h.mqttClients[0].ended).toBeGreaterThan(0);
  });

  it("always emits droppedCompanies on renewal, even when empty", async () => {
    const h = makeHarness({
      bundles: [bundle({ droppedCompanies: ["cmp_big1"] }), bundle()],
    });
    await h.client.start();
    await settle();
    h.mqttClients[0].fire("connect");
    await settle();
    await h.timers.advance(3_600_000 * 0.8);
    await settle();
    expect(h.events.droppedCompanies).toEqual([[["cmp_big1"]], [[]]]);
  });

  it("emits droppedCompanies surfaced from the vend", async () => {
    const h = makeHarness({
      bundles: [bundle({ droppedCompanies: ["cmp_big1", "cmp_big2"] })],
    });
    await h.client.start();
    await settle();
    expect(h.events.droppedCompanies).toEqual([[["cmp_big1", "cmp_big2"]]]);
  });

  it("stop() during an in-flight handshake does not resurrect the client", async () => {
    const h = makeHarness();
    await h.client.start();
    await settle();
    // Handshake in flight: connect() returned a socket but no CONNACK yet.
    expect(h.mqttClients).toHaveLength(1);
    h.client.stop();
    expect(h.client.getConnectionState()).toBe("closed");
    // Late CONNACK arrives after stop().
    h.mqttClients[0].fire("connect");
    await settle();
    expect(h.client.getConnectionState()).toBe("closed");
    expect(h.mqttClients[0].subscribed).toHaveLength(0); // no resubscribe
    expect(h.fetchCalls).toHaveLength(0); // no catch-up reconcile
  });

  it("a stale close during renewal teardown cannot kill the fresh socket", async () => {
    const first = bundle();
    const second = bundle({
      credentials: {
        accessKeyId: "AKIA2",
        secretAccessKey: "secret2",
        sessionToken: "token2",
      },
      expiration: new Date(2 * 3_600_000).toISOString(),
    });
    const h = makeHarness({ bundles: [first, second] });
    await h.client.start();
    await settle();
    h.mqttClients[0].fire("connect");
    await settle();
    // Renewal → connectOnce() tears the old socket down; the real transport
    // emits `close` during end(). Simulate that stale close AFTER the fresh
    // socket exists — it must be ignored (old generation).
    await h.timers.advance(3_600_000 * 0.8);
    await settle();
    expect(h.mqttClients).toHaveLength(2);
    h.mqttClients[1].fire("connect");
    await settle();
    expect(h.client.getConnectionState()).toBe("connected");
    h.mqttClients[0].fire("close"); // stale close from torn-down socket
    await settle();
    expect(h.client.getConnectionState()).toBe("connected"); // untouched
    await h.timers.advance(600_000);
    await settle();
    expect(h.mqttClients).toHaveLength(2); // no stray reconnect either
  });

  it("a later Subscribe batch failure still reconnects instead of staying connected", async () => {
    const h = makeHarness({
      random: () => 1,
      bundles: [
        bundle({
          companyTopics: ["c1", "c2", "c3", "c4", "c5"],
        }),
      ],
    });
    await h.client.start();
    await settle();
    h.mqttClients[0].subscribeFailOnCall = 2;
    h.mqttClients[0].fire("connect");
    await settle();
    expect(h.mqttClients[0].subscribed).toHaveLength(2);
    expect(h.client.getConnectionState()).toBe("reconnecting");
    expect(String((h.events.error[0] ?? [])[0])).toContain(
      "later Subscribe batch failed",
    );
  });

  it("subscribe failure forces a reconnect cycle instead of staying connected", async () => {
    const h = makeHarness({ random: () => 1 });
    await h.client.start();
    await settle();
    h.mqttClients[0].subscribeError = new Error("SUBACK failure");
    h.mqttClients[0].fire("connect");
    await settle();
    expect(h.client.getConnectionState()).toBe("reconnecting");
    expect(h.events.error).toHaveLength(1);
    expect(h.mqttClients[0].ended).toBeGreaterThan(0);
    await h.timers.advance(1_000);
    await settle();
    expect(h.mqttClients).toHaveLength(2);
    h.mqttClients[1].fire("connect");
    await settle();
    expect(h.client.getConnectionState()).toBe("connected");
  });

  it("per-topic qos-128 rejection is treated as a subscribe failure", async () => {
    const h = makeHarness({ random: () => 1 });
    await h.client.start();
    await settle();
    h.mqttClients[0].subscribeGranted = [
      { topic: "hq/prs_alice/dm", qos: 0 },
      { topic: "hq/cmp_acme/thread/#", qos: 128 },
    ];
    h.mqttClients[0].fire("connect");
    await settle();
    expect(h.client.getConnectionState()).toBe("reconnecting");
    expect(String((h.events.error[0] ?? [])[0])).toContain(
      "hq/cmp_acme/thread/#",
    );
  });

  it("reconnect asks the host to catch up instead of refetching known threads", async () => {
    const h = makeHarness({ random: () => 1 });
    await h.client.start();
    await settle();
    h.mqttClients[0].fire("connect");
    await settle();
    h.mqttClients[0].fire(
      "message",
      "hq/cmp_acme/thread/t42",
      new TextEncoder().encode("{}"),
    );
    await settle();
    h.fetchCalls.length = 0;
    h.events.catchup.length = 0;
    h.mqttClients[0].fire("close");
    await h.timers.advance(1_000);
    await settle();
    h.mqttClients[1].fire("connect");
    await settle();
    expect(h.fetchCalls).toEqual(
      expect.arrayContaining([
        "/v1/notify/inbox",
        "/v1/work-mesh/work",
        "/v1/notify/notifications",
      ]),
    );
    expect(h.events.catchup).toEqual([["connect"]]);
  });

  it("asks the host to catch up on focus when the socket stayed up", async () => {
    let hidden = false;
    const listeners: Array<() => void> = [];
    const visibility: VisibilityHost = {
      get hidden() {
        return hidden;
      },
      addEventListener: (_t, l) => listeners.push(l),
      removeEventListener: (_t, l) => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      },
    };
    const h = makeHarness({ visibility });
    await h.client.start();
    await settle();
    h.mqttClients[0].fire("connect");
    await settle();
    h.events.catchup.length = 0;
    hidden = true;
    for (const l of listeners) l();
    hidden = false;
    for (const l of listeners) l();
    expect(h.events.catchup).toEqual([["focus"]]);
    expect(h.mqttClients).toHaveLength(1);
  });

  it("stop() tears down and prevents further reconnects", async () => {
    const h = makeHarness();
    await h.client.start();
    await settle();
    h.mqttClients[0].fire("connect");
    await settle();
    h.client.stop();
    expect(h.client.getConnectionState()).toBe("closed");
    h.mqttClients[0].fire("close");
    await h.timers.advance(600_000);
    await settle();
    expect(h.mqttClients).toHaveLength(1);
    expect(h.mqttClients[0].ended).toBeGreaterThan(0);
  });
});
