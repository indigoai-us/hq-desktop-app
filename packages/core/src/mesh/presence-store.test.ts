import { describe, expect, it } from "vitest";

import {
  PresenceStore,
  isPresenceTopic,
  parsePresencePayload,
  parsePresenceTopic,
  presenceFilterForCompany,
} from "./presence-store.js";

describe("presenceFilterForCompany", () => {
  it("derives the subscribe filter from companyUid (not contract-1 presenceTopic)", () => {
    expect(presenceFilterForCompany("cmp_acme")).toBe("hq/cmp_acme/presence/#");
    expect(presenceFilterForCompany("cmp_01KSR2D0Y920PD7NK0Z232DEK2")).toBe(
      "hq/cmp_01KSR2D0Y920PD7NK0Z232DEK2/presence/#",
    );
  });
});

describe("parsePresenceTopic / isPresenceTopic", () => {
  it("matches hq/{companyUid}/presence/{actorUid}", () => {
    expect(parsePresenceTopic("hq/cmp_x/presence/prs_a")).toEqual({
      companyUid: "cmp_x",
      actorUid: "prs_a",
    });
    expect(isPresenceTopic("hq/cmp_x/presence/agt_b")).toBe(true);
    expect(isPresenceTopic("hq/cmp_x/presence/#")).toBe(false);
    expect(isPresenceTopic("hq/cmp_x/thread/t1")).toBe(false);
    expect(isPresenceTopic("hq/cmp_x/presence")).toBe(false);
  });
});

describe("parsePresencePayload", () => {
  it("accepts the contract retained shape", () => {
    expect(
      parsePresencePayload({
        v: 1,
        status: "online",
        actorUid: "prs_a",
        actorType: "human",
        at: "2026-09-03T12:00:00.000Z",
      }),
    ).toEqual({
      status: "online",
      actorUid: "prs_a",
      actorType: "human",
      at: "2026-09-03T12:00:00.000Z",
    });
  });

  it("rejects payloads that are not presence status", () => {
    expect(parsePresencePayload({ kind: "live", companyUid: "cmp_x" })).toBeNull();
    expect(parsePresencePayload({ status: "away", actorUid: "prs_a" })).toBeNull();
  });
});

describe("PresenceStore", () => {
  it("applies retained MQTT payloads and notifies listeners", () => {
    const store = new PresenceStore();
    const changes: Array<{ actorUid: string; status: string }> = [];
    store.subscribe((c) => changes.push({ actorUid: c.actorUid, status: c.status }));
    const change = store.applyMqtt(
      "hq/cmp_x/presence/prs_a",
      JSON.stringify({
        v: 1,
        status: "online",
        actorUid: "prs_a",
        actorType: "human",
        at: "2026-09-03T12:00:00.000Z",
      }),
    );
    expect(change).toEqual({
      companyUid: "cmp_x",
      actorUid: "prs_a",
      status: "online",
    });
    expect(store.get("cmp_x", "prs_a")?.status).toBe("online");
    expect(changes).toEqual([{ actorUid: "prs_a", status: "online" }]);
  });

  it("flips an actor offline on the server-published offline payload", () => {
    const store = new PresenceStore();
    store.applyMqtt("hq/cmp_x/presence/prs_a", {
      v: 1,
      status: "online",
      actorUid: "prs_a",
      actorType: "human",
      at: "2026-09-03T12:00:00.000Z",
    });
    store.applyMqtt("hq/cmp_x/presence/prs_a", {
      v: 1,
      status: "offline",
      actorUid: "prs_a",
      actorType: "human",
      at: "2026-09-03T12:00:30.000Z",
    });
    expect(store.get("cmp_x", "prs_a")?.status).toBe("offline");
  });

  it("replaceCompany rebuilds from a live-read participants list", () => {
    const store = new PresenceStore();
    store.applyMqtt("hq/cmp_x/presence/prs_old", {
      v: 1,
      status: "online",
      actorUid: "prs_old",
      actorType: "human",
      at: "2026-09-03T11:00:00.000Z",
    });
    const changes = store.replaceCompany("cmp_x", [
      {
        actorUid: "prs_a",
        actorType: "human",
        presence: "online",
        lastSeenAt: "2026-09-03T12:00:00.000Z",
      },
      {
        actorUid: "agt_b",
        actorType: "agent",
        presence: "offline",
        lastSeenAt: "2026-09-03T11:59:00.000Z",
      },
    ]);
    expect(store.get("cmp_x", "prs_a")?.status).toBe("online");
    expect(store.get("cmp_x", "agt_b")?.actorType).toBe("agent");
    expect(store.get("cmp_x", "prs_old")).toBeUndefined();
    expect(changes.some((c) => c.actorUid === "prs_old" && c.status === "offline")).toBe(
      true,
    );
  });
});
