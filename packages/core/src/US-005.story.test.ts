/**
 * US-005 acceptance tests (from PRD e2eTests):
 * 1. Given a connected MeshClient, when a wake arrives on a thread topic,
 *    then the client re-fetches the thread from REST and emits the
 *    reconciled state.
 * 2. Given credentials nearing expiry, when the renewal window is reached,
 *    then new credentials are fetched and the connection continues without
 *    message loss beyond QoS semantics (subscriptions re-established, wakes
 *    after renewal still reconcile).
 */
import { describe, expect, it } from "vitest";

import { MeshClient, type MqttConnectFn } from "./mesh/client.js";
import type {
  CredentialProvider,
  MeshCredentialBundle,
  TimerHost,
} from "./mesh/credentials.js";
import type { ReconcileResult } from "./mesh/reconcile.js";

// ---------------------------------------------------------------------------
// Deterministic seams (no network, no real timers)
// ---------------------------------------------------------------------------

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
  subscribe(
    topics: string | string[],
    _opts: unknown,
    cb?: (err?: Error) => void,
  ): this {
    this.subscribed.push(Array.isArray(topics) ? topics : [topics]);
    cb?.();
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

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

/** Hop macrotasks (bounded) until `cond` holds — robust under parallel load. */
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  expect(cond()).toBe(true);
}

interface StoryHarness {
  client: MeshClient;
  timers: FakeTimers;
  mqttClients: FakeMqttClient[];
  connectUrls: string[];
  fetchCalls: string[];
  reconciled: ReconcileResult[];
  wakes: string[];
}

function makeStoryHarness(bundles: MeshCredentialBundle[]): StoryHarness {
  const timers = new FakeTimers();
  const mqttClients: FakeMqttClient[] = [];
  const connectUrls: string[] = [];
  const fetchCalls: string[] = [];
  const reconciled: ReconcileResult[] = [];
  const wakes: string[] = [];
  let vends = 0;

  const provider: CredentialProvider = {
    fetchCredentials: () => {
      const b = bundles[Math.min(vends, bundles.length - 1)];
      vends++;
      return Promise.resolve(b);
    },
  };
  const mqttConnect: MqttConnectFn = (url) => {
    connectUrls.push(url);
    const c = new FakeMqttClient();
    mqttClients.push(c);
    return c;
  };
  const client = new MeshClient({
    credentialProvider: provider,
    fetcher: (route) => {
      fetchCalls.push(route.path);
      return Promise.resolve({ state: { path: route.path }, cursor: "c1" });
    },
    mqttConnect,
    timers,
    random: () => 1,
    visibilityHost: null,
  });
  client.on("reconciled", (r) => reconciled.push(r));
  client.on("wake", (t) => wakes.push(t));
  return {
    client,
    timers,
    mqttClients,
    connectUrls,
    fetchCalls,
    reconciled,
    wakes,
  };
}

// ---------------------------------------------------------------------------
// US-005 story acceptance
// ---------------------------------------------------------------------------

describe("US-005: Shared MeshClient", () => {
  it("a wake on a thread topic re-fetches the thread from REST and emits the reconciled state", async () => {
    const h = makeStoryHarness([bundle()]);
    await h.client.start();
    await settle();
    h.mqttClients[0].fire("connect");
    await settle();

    // Connected; clear connect-time catch-up fetches so we isolate the wake.
    expect(h.client.getConnectionState()).toBe("connected");
    h.fetchCalls.length = 0;
    h.reconciled.length = 0;

    h.mqttClients[0].fire(
      "message",
      "hq/cmp_acme/thread/t7",
      new TextEncoder().encode('{"payload":"is advisory only"}'),
    );
    await settle();

    // The wake surfaced, the thread was re-fetched from REST, and the
    // reconciled state comes from the fetcher — never the MQTT payload.
    expect(h.wakes).toEqual(["hq/cmp_acme/thread/t7"]);
    expect(h.fetchCalls).toEqual([
      "/v1/work-mesh/companies/cmp_acme/threads/t7",
    ]);
    expect(h.reconciled).toHaveLength(1);
    expect(h.reconciled[0].state).toEqual({
      path: "/v1/work-mesh/companies/cmp_acme/threads/t7",
    });
  });

  it("at the renewal window fresh credentials are fetched and the connection continues: subscriptions re-established, wakes after renewal still reconcile", async () => {
    const first = bundle();
    const second = bundle({
      credentials: {
        accessKeyId: "AKIA2",
        secretAccessKey: "secret2",
        sessionToken: "token2",
      },
      expiration: new Date(2 * 3_600_000).toISOString(),
    });
    const h = makeStoryHarness([first, second]);
    await h.client.start();
    await settle();
    h.mqttClients[0].fire("connect");
    await settle();
    const originalSubscriptions = h.mqttClients[0].subscribed[0];

    // Renewal fires at min(80% lifetime, expiry-5min) → 48min for a 1h vend.
    await h.timers.advance(3_600_000 * 0.8);
    // Renewal → re-presign → reconnect is an async chain; wait until the new
    // socket exists (bounded macrotask hops keep this robust under load).
    await waitFor(() => h.mqttClients.length === 2);

    // New credentials vended; the new socket is presigned with them.
    expect(h.mqttClients[0].ended).toBeGreaterThan(0);
    expect(h.connectUrls[1]).toContain("AKIA2");

    h.mqttClients[1].fire("connect");
    await settle();

    // Identical subscription set re-established (no lost topics).
    expect(h.mqttClients[1].subscribed[0]).toEqual(originalSubscriptions);
    expect(h.client.getConnectionState()).toBe("connected");

    // Wakes after renewal still reconcile through REST.
    h.fetchCalls.length = 0;
    h.reconciled.length = 0;
    h.mqttClients[1].fire("message", "hq/cmp_acme/thread/t9");
    await settle();
    expect(h.fetchCalls).toEqual([
      "/v1/work-mesh/companies/cmp_acme/threads/t9",
    ]);
    expect(h.reconciled[0]?.state).toEqual({
      path: "/v1/work-mesh/companies/cmp_acme/threads/t9",
    });
  });
});
