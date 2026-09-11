/**
 * US-017 — the content-delivery gate.
 *
 * The authoritative event closes content delivery immediately and permanently:
 * a removed peer is never re-admitted by a later, staler roster, and a
 * traffic stop closes the whole call regardless of the control plane.
 */

import { describe, expect, it } from "vitest";

import {
  createContentDeliveryGate,
  type ContentGateEvent,
} from "./content-gate.js";

describe("content delivery gate", () => {
  it("delivers only to admitted peers", () => {
    const gate = createContentDeliveryGate();
    expect(gate.allows("prs_b dev_b")).toBe(false);
    gate.admit(["prs_b dev_b"]);
    expect(gate.allows("prs_b dev_b")).toBe(true);
  });

  it("closes a removed peer synchronously and never re-admits it", () => {
    const gate = createContentDeliveryGate();
    const events: ContentGateEvent[] = [];
    gate.onClose((event) => events.push(event));
    gate.admit(["prs_b dev_b", "prs_c dev_c"]);

    gate.closePeer("prs_b dev_b");
    expect(gate.allows("prs_b dev_b")).toBe(false);
    expect(gate.allows("prs_c dev_c")).toBe(true);
    expect(events).toEqual([
      { peerId: "prs_b dev_b", reason: "peer-removed" },
    ]);

    // A stale roster redelivery must not resurrect the peer.
    gate.admit(["prs_b dev_b", "prs_c dev_c"]);
    expect(gate.allows("prs_b dev_b")).toBe(false);
    gate.closePeer("prs_b dev_b");
    expect(events).toHaveLength(1);
  });

  it("closes the whole call on a traffic stop and stays closed", () => {
    const gate = createContentDeliveryGate();
    const events: ContentGateEvent[] = [];
    gate.onClose((event) => events.push(event));
    gate.admit(["prs_b dev_b"]);

    gate.closeAll("traffic-stopped");
    expect(gate.open()).toBe(false);
    expect(gate.allows("prs_b dev_b")).toBe(false);
    gate.admit(["prs_b dev_b"]);
    expect(gate.allows("prs_b dev_b")).toBe(false);

    gate.closeAll("account-changed");
    expect(events).toEqual([{ peerId: null, reason: "traffic-stopped" }]);
  });

  it("unsubscribes cleanly", () => {
    const gate = createContentDeliveryGate();
    const events: ContentGateEvent[] = [];
    const off = gate.onClose((event) => events.push(event));
    gate.admit(["prs_b dev_b"]);
    off();
    gate.closePeer("prs_b dev_b");
    expect(events).toEqual([]);
  });
});
