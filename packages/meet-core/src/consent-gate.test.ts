/**
 * US-017 — the consent-roster barrier.
 *
 * These tests are the endpoint mirror of `CompletionConsentService`: they pin
 * that no endpoint can recognize audio under an obsolete consent, that a
 * roster change pauses *before* the new roster is admitted, and that delayed
 * or reordered control events are ignored rather than applied.
 */

import { describe, expect, it } from "vitest";

import {
  consentAckFields,
  createConsentGate,
  type ConsentGate,
  type ConsentProofView,
} from "./consent-gate.js";

function clock(): { now(): number } {
  let value = 1_000;
  return {
    now: () => {
      value += 1;
      return value;
    },
  };
}

function gate(participants = ["prs_a", "prs_b"], revision = 1): ConsentGate {
  const created = createConsentGate({
    clock: clock(),
    selfPersonUid: "prs_a",
  });
  created.setEnabled(true);
  created.observeRoster({ rosterRevision: revision, participants });
  return created;
}

function proof(
  overrides: Partial<ConsentProofView> = {},
): ConsentProofView {
  return {
    revision: 1,
    consentEpoch: 1,
    rosterRevision: 1,
    processorId: null,
    participants: ["prs_a", "prs_b"],
    acknowledged: ["prs_a", "prs_b"],
    readyAt: 1_500,
    pausedAt: null,
    ...overrides,
  };
}

describe("consent gate", () => {
  it("is off by default and never recognizes without the explicit control", () => {
    const created = createConsentGate({
      clock: clock(),
      selfPersonUid: "prs_a",
    });
    created.observeRoster({ rosterRevision: 1, participants: ["prs_a"] });
    created.applyProof(proof({ participants: ["prs_a"], acknowledged: ["prs_a"] }));
    expect(created.snapshot().status).toBe("off");
    expect(created.recognitionAllowed()).toBe(false);
  });

  it("only recognizes when every current participant has acknowledged", () => {
    const created = gate();
    created.applyProof(proof({ acknowledged: ["prs_a"], readyAt: null }));
    expect(created.recognitionAllowed()).toBe(false);
    expect(created.snapshot().awaiting).toEqual(["prs_b"]);

    created.applyProof(proof({ revision: 2 }));
    expect(created.recognitionAllowed()).toBe(true);
    expect(created.snapshot().status).toBe("ready");
  });

  it("pauses on a roster change before the new participant can be transcribed", () => {
    const created = gate();
    created.applyProof(proof());
    expect(created.recognitionAllowed()).toBe(true);

    created.observeRoster({
      rosterRevision: 2,
      participants: ["prs_a", "prs_b", "prs_c"],
    });
    expect(created.recognitionAllowed()).toBe(false);
    expect(created.snapshot().status).toBe("paused");
    expect(created.snapshot().awaiting).toEqual(["prs_c"]);
  });

  it("ignores a consent formed for the previous roster revision", () => {
    const created = gate();
    created.applyProof(proof());
    created.observeRoster({
      rosterRevision: 2,
      participants: ["prs_a", "prs_b", "prs_c"],
    });
    // A delayed ack for the OLD roster lands after the join.
    created.applyProof(
      proof({ revision: 5, consentEpoch: 1, rosterRevision: 1 }),
    );
    expect(created.recognitionAllowed()).toBe(false);
  });

  it("ignores a reordered older epoch and an older store revision", () => {
    const created = gate();
    created.applyProof(proof({ consentEpoch: 3, revision: 4 }));
    expect(created.snapshot().consentEpoch).toBe(3);
    created.applyProof(proof({ consentEpoch: 2, revision: 99 }));
    expect(created.snapshot().consentEpoch).toBe(3);
    created.applyProof(
      proof({ consentEpoch: 3, revision: 4, acknowledged: ["prs_a"] }),
    );
    expect(created.recognitionAllowed()).toBe(true);
  });

  it("ignores a roster delivered out of order", () => {
    const created = gate(["prs_a", "prs_b"], 4);
    created.observeRoster({ rosterRevision: 2, participants: ["prs_a"] });
    expect(created.snapshot().rosterRevision).toBe(4);
  });

  it("stops recognizing on withdrawal and requires a new epoch", () => {
    const created = gate();
    created.applyProof(proof());
    expect(created.recognitionAllowed()).toBe(true);

    created.withdraw();
    expect(created.recognitionAllowed()).toBe(false);
    expect(created.snapshot().status).toBe("paused");
    // A paused proof can never become ready again.
    expect(created.nextConsentEpoch()).toBe(2);
    created.applyProof(proof({ revision: 3, pausedAt: 2_000 }));
    expect(created.recognitionAllowed()).toBe(false);
  });

  it("stays visibly paused when an acknowledgement is unavailable", () => {
    const created = gate();
    created.noteAcknowledgementUnavailable();
    const snapshot = created.snapshot();
    expect(snapshot.status).toBe("paused");
    expect(snapshot.acknowledgementUnavailable).toBe(true);
    expect(created.recognitionAllowed()).toBe(false);
  });

  it("turning the control off drops the proof entirely", () => {
    const created = gate();
    created.applyProof(proof());
    created.setEnabled(false);
    expect(created.snapshot().status).toBe("off");
    created.setEnabled(true);
    expect(created.recognitionAllowed()).toBe(false);
    expect(created.nextConsentEpoch()).toBe(1);
  });

  it("builds an ack envelope body for the epoch that must be opened", () => {
    const created = gate();
    expect(consentAckFields(created, true)).toEqual({
      kind: "consentControl",
      consentEpoch: 1,
      rosterRevision: 1,
      processorId: null,
      acknowledged: true,
    });
    created.applyProof(proof());
    created.observeRoster({
      rosterRevision: 2,
      participants: ["prs_a", "prs_b", "prs_c"],
    });
    expect(consentAckFields(created, true, "proc_1")).toEqual({
      kind: "consentControl",
      consentEpoch: 2,
      rosterRevision: 2,
      processorId: "proc_1",
      acknowledged: true,
    });
  });

  it("notifies subscribers on every transition", () => {
    const created = gate();
    const seen: string[] = [];
    const off = created.subscribe((snapshot) => seen.push(snapshot.status));
    created.applyProof(proof());
    created.observeRoster({ rosterRevision: 2, participants: ["prs_a"] });
    off();
    created.applyProof(proof({ consentEpoch: 9, revision: 1 }));
    expect(seen).toEqual(["paused", "ready", "paused"]);
  });
});
