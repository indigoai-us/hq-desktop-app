/**
 * The consent-roster barrier (US-017).
 *
 * Transcription is only lawful while *every current participant* has
 * acknowledged the *current* consent epoch for the *current* roster. The
 * authority for that lives in hq-pro (`CompletionConsentService`); this module
 * is the endpoint-side mirror of the same rules, so that no endpoint ever
 * recognizes audio under an obsolete consent — including in the window between
 * a participant joining and the backend reaching readiness again.
 *
 * The rules mirrored here, one for one:
 *
 *  - a proof is keyed by `consentEpoch` and pinned to the `rosterRevision` it
 *    was formed at;
 *  - readiness (`readyAt`) is reached only when every current participant has
 *    acknowledged and the proof is not paused;
 *  - a paused proof can never become ready again — a *new* epoch must be
 *    opened (the backend answers `CONSENT_REQUIRED` on a paused proof);
 *  - any roster change pauses first, and recognition must stop *before* the
 *    new roster is admitted into a transcribed conversation;
 *  - withdrawal (`acknowledged: false`) pauses exactly the same way;
 *  - delayed or reordered control events — an older epoch, an older roster
 *    revision, a stale store revision — are ignored, never applied.
 *
 * There is no ASR here and no audio: this is a gate, and its only output is
 * whether recognition may run. The default is off.
 */

import type { Clock } from "./ports.js";

/** What the window shows, and what any future recognizer must consult. */
export type ConsentStatus = "off" | "paused" | "ready";

/** The endpoint's view of one consent proof. Mirrors hq-pro's `ConsentProof`. */
export interface ConsentProofView {
  /** Optimistic-concurrency revision of the stored proof. */
  revision: number;
  consentEpoch: number;
  rosterRevision: number;
  processorId: string | null;
  /** Person uids of every participant the proof was formed over. */
  participants: string[];
  /** Person uids that have acknowledged this epoch. */
  acknowledged: string[];
  readyAt: number | null;
  pausedAt: number | null;
}

export interface ConsentGateSnapshot {
  status: ConsentStatus;
  /** The local actor's own "Allow transcription" control. Default false. */
  enabled: boolean;
  /** Roster revision the gate currently believes is live. */
  rosterRevision: number;
  /** Epoch of the proof currently held, or 0 when none. */
  consentEpoch: number;
  /** True when an acknowledgement could not be delivered or accepted. */
  acknowledgementUnavailable: boolean;
  /** Processor the currently held proof was formed for, or null when none. */
  processorId: string | null;
  /** Person uids of the current roster that have not acknowledged yet. */
  awaiting: string[];
}

export interface ConsentRosterView {
  rosterRevision: number;
  /** Person uids currently admitted, including this device's own person. */
  participants: string[];
}

export interface ConsentGateOptions {
  clock: Clock;
  /** Person uid of the local actor; used to compute its own pending ack. */
  selfPersonUid: string;
}

export interface ConsentGate {
  /** True only when recognition is lawful *right now*. */
  recognitionAllowed(): boolean;
  snapshot(): ConsentGateSnapshot;
  /** The local "Allow transcription" control. Off by default. */
  setEnabled(enabled: boolean): void;
  /**
   * A roster delivery. Any change of revision or membership pauses the gate
   * before the new roster is admitted into a transcribed conversation; an
   * older revision is a reordered delivery and is ignored.
   */
  observeRoster(roster: ConsentRosterView): void;
  /**
   * A consent proof from the control plane. Older epochs, older roster
   * revisions and stale store revisions are ignored.
   */
  applyProof(proof: ConsentProofView): void;
  /** The epoch a fresh acknowledgement must open. Never reuses a paused one. */
  nextConsentEpoch(): number;
  /** A control-plane acknowledgement could not be delivered. Stays paused. */
  noteAcknowledgementUnavailable(): void;
  /** Local withdrawal: pauses immediately, without waiting for the backend. */
  withdraw(): void;
  subscribe(listener: (snapshot: ConsentGateSnapshot) => void): () => void;
}

export function createConsentGate(options: ConsentGateOptions): ConsentGate {
  const listeners = new Set<(snapshot: ConsentGateSnapshot) => void>();
  let enabled = false;
  let rosterRevision = 0;
  let participants: string[] = [];
  let proof: ConsentProofView | null = null;
  let unavailable = false;
  /** Local pause latch: set the instant a roster changes or consent is pulled. */
  let localPause = true;

  function sameMembers(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    const left = [...a].sort();
    const right = [...b].sort();
    return left.every((value, index) => value === right[index]);
  }

  function ready(): boolean {
    if (!enabled || localPause || proof === null) return false;
    if (proof.pausedAt !== null || proof.readyAt === null) return false;
    // The proof must describe the roster we are actually in.
    if (proof.rosterRevision !== rosterRevision) return false;
    if (!sameMembers(proof.participants, participants)) return false;
    return participants.every((person) => proof!.acknowledged.includes(person));
  }

  function awaiting(): string[] {
    if (proof === null) return [...participants].sort();
    return participants
      .filter((person) => !proof!.acknowledged.includes(person))
      .sort();
  }

  function snapshot(): ConsentGateSnapshot {
    return {
      status: !enabled ? "off" : ready() ? "ready" : "paused",
      enabled,
      rosterRevision,
      consentEpoch: proof?.consentEpoch ?? 0,
      acknowledgementUnavailable: unavailable,
      processorId: proof?.processorId ?? null,
      awaiting: awaiting(),
    };
  }

  function publish(): void {
    const next = snapshot();
    for (const listener of [...listeners]) listener(next);
  }

  function pause(): void {
    localPause = true;
  }

  return {
    recognitionAllowed: () => ready(),
    snapshot,

    setEnabled(next: boolean): void {
      if (enabled === next) return;
      enabled = next;
      if (!next) {
        // Turning the control off is a withdrawal: recognition stops now, and
        // turning it back on requires a fresh, re-acknowledged epoch.
        //
        // The proof is PAUSED, never dropped. Dropping it would lose the epoch
        // the withdrawal has to be filed against — the backend only accepts an
        // `acknowledged: false` control for the epoch that is currently head,
        // and a gate that forgot its epoch would propose epoch 1 forever while
        // the real proof stayed open and ready for everyone else. Keeping the
        // paused proof also makes the later re-enable propose head + 1, which
        // is exactly what `CompletionConsentService` demands of a new epoch.
        // It is cleared only when `applyProof` supersedes it.
        pause();
        if (proof && proof.pausedAt === null) {
          proof = { ...proof, pausedAt: options.clock.now() };
        }
        unavailable = false;
      } else {
        pause();
      }
      publish();
    },

    observeRoster(roster: ConsentRosterView): void {
      if (roster.rosterRevision < rosterRevision) return; // reordered delivery
      const changed =
        roster.rosterRevision !== rosterRevision ||
        !sameMembers(roster.participants, participants);
      rosterRevision = roster.rosterRevision;
      participants = [...roster.participants].sort();
      if (changed) {
        // Pause FIRST: recognition must stop before newly joined audio can be
        // admitted into a transcribed conversation.
        pause();
        unavailable = false;
        publish();
      }
    },

    applyProof(next: ConsentProofView): void {
      if (proof) {
        if (next.consentEpoch < proof.consentEpoch) return; // older epoch
        if (
          next.consentEpoch === proof.consentEpoch &&
          next.revision <= proof.revision
        ) {
          return; // stale or redelivered store revision
        }
      }
      if (next.rosterRevision < rosterRevision) return; // formed for an old roster
      proof = {
        ...next,
        participants: [...next.participants].sort(),
        acknowledged: [...next.acknowledged].sort(),
      };
      unavailable = false;
      // The local latch lifts only for a proof that is itself ready and
      // matches the roster we are in; `ready()` re-checks all of that.
      localPause = proof.readyAt === null || proof.pausedAt !== null;
      publish();
    },

    nextConsentEpoch(): number {
      // A paused proof can never become ready again, so it is never reused.
      if (proof === null) return 1;
      if (proof.pausedAt !== null) return proof.consentEpoch + 1;
      if (proof.rosterRevision !== rosterRevision) return proof.consentEpoch + 1;
      if (!sameMembers(proof.participants, participants)) {
        return proof.consentEpoch + 1;
      }
      return proof.consentEpoch;
    },

    noteAcknowledgementUnavailable(): void {
      unavailable = true;
      pause();
      publish();
    },

    withdraw(): void {
      pause();
      if (proof) proof = { ...proof, pausedAt: options.clock.now() };
      publish();
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
  };
}

/**
 * A signed-envelope body for `calls.completionConsent`, minus the signature
 * and the binding the caller already holds. Kept here so the shape the gate
 * drives and the shape the backend validates stay in one place.
 */
export interface ConsentAckFields {
  kind: "consentControl";
  consentEpoch: number;
  rosterRevision: number;
  processorId: string | null;
  acknowledged: boolean;
}

export function consentAckFields(
  gate: ConsentGate,
  acknowledged: boolean,
  processorId?: string | null,
): ConsentAckFields {
  const snapshot = gate.snapshot();
  return {
    kind: "consentControl",
    // A withdrawal is filed against the epoch that is actually open: the
    // backend pauses the *current* proof, and an `acknowledged: false` naming
    // a not-yet-existent head + 1 is refused as `STALE_EPOCH`. Only a positive
    // acknowledgement opens (or re-uses) an epoch.
    consentEpoch:
      !acknowledged && snapshot.consentEpoch >= 1
        ? snapshot.consentEpoch
        : gate.nextConsentEpoch(),
    rosterRevision: snapshot.rosterRevision,
    // Defaults to the processor the held proof was formed for: a proof opened
    // for `processor` must not be amended by a control claiming no processor —
    // the backend compares `old.processorId !== input.processorId` and refuses.
    processorId: processorId === undefined ? snapshot.processorId : processorId,
    acknowledged,
  };
}
