/**
 * US-016 e2e behaviour: three actors across two projects; a stopped actor
 * disappears when the presence store receives the retained offline payload
 * (within the broker's <30s detection window — asserted via fake store event,
 * not a wall-clock wait).
 */
import { describe, expect, it } from "vitest";
import { PresenceStore } from "@hq/core";
import { ATLAS_MIXED_LIVE, buildAtlasView } from "./atlas-model.js";

describe("US-016 Atlas e2e projection", () => {
  it("shows three online actors across two projects when Atlas opens", () => {
    const view = buildAtlasView({ live: ATLAS_MIXED_LIVE });
    expect(view.projects).toHaveLength(2);
    const byProject = Object.fromEntries(
      view.projects.map((p) => [
        p.projectId,
        p.onlineActors.map((a) => a.actorUid).sort(),
      ]),
    );
    expect(byProject["work-mesh-live"]).toEqual(["agt_ralph", "prs_corey"]);
    expect(byProject["hq-desktop"]).toEqual(["prs_stefan"]);
  });

  it("removes a stopped actor within 30s via retained offline payload on the store", () => {
    const store = new PresenceStore();
    // Seed online from live-read rebuild (MeshClient reconnect path).
    store.replaceCompany(
      "cmp_indigo",
      ATLAS_MIXED_LIVE.participants.map((p) => ({
        actorUid: p.actorUid,
        actorType: p.actorType,
        presence: p.presence,
        lastSeenAt: p.lastSeenAt,
      })),
    );

    const before = buildAtlasView({
      live: ATLAS_MIXED_LIVE,
      presenceByActor: new Map(
        [...(store.snapshot().get("cmp_indigo") ?? [])].map(([uid, entry]) => [
          uid,
          entry.status,
        ]),
      ),
    });
    expect(
      before.projects
        .flatMap((p) => p.onlineActors)
        .some((a) => a.actorUid === "prs_stefan"),
    ).toBe(true);

    // Server-published retained offline (IoT lifecycle → PresenceIngest).
    // Broker keepalive 15s ⇒ detection under 30s; Atlas reacts to the store
    // event immediately — no timestamp derivation.
    store.applyMqtt("hq/cmp_indigo/presence/prs_stefan", {
      v: 1,
      status: "offline",
      actorUid: "prs_stefan",
      actorType: "human",
      at: "2026-09-04T12:00:25.000Z",
    });

    const after = buildAtlasView({
      live: ATLAS_MIXED_LIVE,
      presenceByActor: new Map(
        [...(store.snapshot().get("cmp_indigo") ?? [])].map(([uid, entry]) => [
          uid,
          entry.status,
        ]),
      ),
    });
    expect(
      after.projects
        .flatMap((p) => p.onlineActors)
        .some((a) => a.actorUid === "prs_stefan"),
    ).toBe(false);
    expect(
      after.projects.find((p) => p.projectId === "hq-desktop")?.offlineCount,
    ).toBe(1);
  });
});
