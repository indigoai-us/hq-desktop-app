/**
 * In-memory presence store — the one exception to the wake-only MQTT contract.
 *
 * Messages on `hq/{companyUid}/presence/{actorUid}` carry durable-enough
 * retained status and are applied here directly (never via REST reconcile).
 * On reconnect the store is rebuilt from GET /v1/work-mesh/live before new
 * MQTT payloads are applied.
 *
 * Framework-free: no Svelte, no DOM. UI hosts subscribe and mirror into runes.
 */

import { decodeWakePayload } from "./reconcile.js";

export type PresenceStatus = "online" | "offline";
export type PresenceActorType = "human" | "agent";

export interface PresenceEntry {
  status: PresenceStatus;
  actorType: PresenceActorType;
  at: string;
}

/** Nested snapshot: companyUid → actorUid → entry. */
export type PresenceSnapshot = ReadonlyMap<
  string,
  ReadonlyMap<string, PresenceEntry>
>;

export interface PresenceChange {
  companyUid: string;
  actorUid: string;
  status: PresenceStatus;
}

export type PresenceListener = (change: PresenceChange) => void;
export type PresenceSnapshotListener = (snapshot: PresenceSnapshot) => void;

/** One participant row from GET /v1/work-mesh/live (presence fields only). */
export interface LiveParticipantPresence {
  actorUid: string;
  actorType?: string;
  presence?: string;
  lastSeenAt?: string;
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** `hq/{companyUid}/presence/{actorUid}` (concrete actor segment required). */
export function parsePresenceTopic(
  topic: string,
): { companyUid: string; actorUid: string } | null {
  const parts = topic.split("/");
  if (parts.length !== 4) return null;
  if (parts[0] !== "hq" || parts[2] !== "presence") return null;
  const companyUid = parts[1];
  const actorUid = parts[3];
  // Reject MQTT wildcard filter forms — only concrete actor topics apply.
  if (!companyUid || !actorUid || actorUid === "#" || actorUid === "+") {
    return null;
  }
  if (companyUid === "#" || companyUid === "+") return null;
  return { companyUid, actorUid };
}

export function isPresenceTopic(topic: string): boolean {
  return parsePresenceTopic(topic) !== null;
}

/** Filter subscribed per entitled company (derived from companyUid, not vend). */
export function presenceFilterForCompany(companyUid: string): string {
  return `hq/${companyUid}/presence/#`;
}

export function parsePresencePayload(raw: unknown): {
  status: PresenceStatus;
  actorUid: string;
  actorType: PresenceActorType;
  at: string;
} | null {
  const obj = asRecord(decodeWakePayload(raw) ?? raw);
  if (!obj) return null;
  const status = trimmed(obj.status);
  if (status !== "online" && status !== "offline") return null;
  const actorUid = trimmed(obj.actorUid);
  if (!actorUid) return null;
  const actorTypeRaw = trimmed(obj.actorType);
  const actorType: PresenceActorType =
    actorTypeRaw === "agent" ? "agent" : "human";
  const at = trimmed(obj.at) || new Date(0).toISOString();
  return { status, actorUid, actorType, at };
}

function normalizeActorType(value: unknown): PresenceActorType {
  return trimmed(value) === "agent" ? "agent" : "human";
}

function normalizeStatus(value: unknown): PresenceStatus | null {
  const status = trimmed(value);
  if (status === "online" || status === "offline") return status;
  return null;
}

/**
 * Mutable presence map keyed by company then actor.
 */
export class PresenceStore {
  private readonly companies = new Map<string, Map<string, PresenceEntry>>();
  private readonly listeners = new Set<PresenceListener>();
  private readonly snapshotListeners = new Set<PresenceSnapshotListener>();
  /** Per-company frozen copies handed out by the last `snapshot()`; reused
   *  verbatim for companies that have not mutated since (see `dirty`). */
  private readonly snapshotCache = new Map<
    string,
    ReadonlyMap<string, PresenceEntry>
  >();
  /** Companies mutated since their cached snapshot map was built. */
  private readonly dirty = new Set<string>();
  /** True while a coalesced snapshot emit is queued on the microtask queue. */
  private snapshotPending = false;

  /** Subscribe to per-actor changes. Returns unsubscribe. */
  subscribe(listener: PresenceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Subscribe to full-snapshot notifications after any mutation. */
  subscribeSnapshot(listener: PresenceSnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    return () => {
      this.snapshotListeners.delete(listener);
    };
  }

  get(companyUid: string, actorUid: string): PresenceEntry | undefined {
    return this.companies.get(companyUid)?.get(actorUid);
  }

  /** Deep-frozen-ish snapshot suitable for UI reads. The outer map is fresh
   *  on every call, but each company's inner map is only rebuilt when that
   *  company changed since the previous snapshot — unchanged companies keep
   *  the same inner map identity so consumers can cheaply skip them. */
  snapshot(): PresenceSnapshot {
    const outer = new Map<string, ReadonlyMap<string, PresenceEntry>>();
    for (const [companyUid, actors] of this.companies) {
      let cached = this.snapshotCache.get(companyUid);
      if (!cached || this.dirty.has(companyUid)) {
        cached = new Map(actors);
        this.snapshotCache.set(companyUid, cached);
      }
      outer.set(companyUid, cached);
    }
    // Drop cache entries for companies that no longer exist.
    if (this.snapshotCache.size !== this.companies.size) {
      for (const companyUid of [...this.snapshotCache.keys()]) {
        if (!this.companies.has(companyUid)) this.snapshotCache.delete(companyUid);
      }
    }
    this.dirty.clear();
    return outer;
  }

  /**
   * Apply a retained/live MQTT presence payload. Returns the change when the
   * store updated (or null when the topic/payload was ignored).
   */
  applyMqtt(topic: string, payload: unknown): PresenceChange | null {
    const parsedTopic = parsePresenceTopic(topic);
    if (!parsedTopic) return null;
    const body = parsePresencePayload(payload);
    if (!body) return null;
    // Topic actor wins when payload disagrees (broker topic is authoritative).
    const actorUid = parsedTopic.actorUid;
    return this.set(parsedTopic.companyUid, actorUid, {
      status: body.status,
      actorType: body.actorType,
      at: body.at,
    });
  }

  /**
   * Replace one company's actors from a live-read participants list.
   * Actors absent from the response are removed.
   */
  replaceCompany(
    companyUid: string,
    participants: readonly LiveParticipantPresence[],
  ): PresenceChange[] {
    const uid = companyUid.trim();
    if (!uid) return [];
    const next = new Map<string, PresenceEntry>();
    const changes: PresenceChange[] = [];
    for (const row of participants) {
      const actorUid = trimmed(row.actorUid);
      if (!actorUid) continue;
      const status = normalizeStatus(row.presence);
      if (!status) continue;
      next.set(actorUid, {
        status,
        actorType: normalizeActorType(row.actorType),
        at: trimmed(row.lastSeenAt) || new Date(0).toISOString(),
      });
    }
    const prev = this.companies.get(uid) ?? new Map<string, PresenceEntry>();
    const actorIds = new Set([...prev.keys(), ...next.keys()]);
    for (const actorUid of actorIds) {
      const before = prev.get(actorUid);
      const after = next.get(actorUid);
      if (!after) {
        // Dropped from live read — treat as offline if we had a row.
        if (before && before.status !== "offline") {
          changes.push({ companyUid: uid, actorUid, status: "offline" });
        }
        continue;
      }
      if (!before || before.status !== after.status) {
        changes.push({ companyUid: uid, actorUid, status: after.status });
      }
    }
    this.companies.set(uid, next);
    this.dirty.add(uid);
    for (const change of changes) this.emitChange(change);
    this.emitSnapshot();
    return changes;
  }

  /** Drop every company (used before a full reconnect rebuild). */
  clear(): void {
    if (this.companies.size === 0) return;
    this.companies.clear();
    this.snapshotCache.clear();
    this.dirty.clear();
    this.emitSnapshot();
  }

  private set(
    companyUid: string,
    actorUid: string,
    entry: PresenceEntry,
  ): PresenceChange | null {
    let actors = this.companies.get(companyUid);
    if (!actors) {
      actors = new Map();
      this.companies.set(companyUid, actors);
    }
    const prev = actors.get(actorUid);
    if (
      prev &&
      prev.status === entry.status &&
      prev.actorType === entry.actorType &&
      prev.at === entry.at
    ) {
      return null;
    }
    actors.set(actorUid, entry);
    this.dirty.add(companyUid);
    const change: PresenceChange = {
      companyUid,
      actorUid,
      status: entry.status,
    };
    this.emitChange(change);
    this.emitSnapshot();
    return change;
  }

  private emitChange(change: PresenceChange): void {
    for (const listener of this.listeners) listener(change);
  }

  /** Coalesce snapshot notifications onto one microtask so a burst of
   *  presence messages (e.g. the retained flood on reconnect) builds and
   *  delivers a single snapshot instead of one per message. Per-actor change
   *  listeners are still invoked synchronously. */
  private emitSnapshot(): void {
    if (this.snapshotListeners.size === 0) return;
    if (this.snapshotPending) return;
    this.snapshotPending = true;
    queueMicrotask(() => {
      this.snapshotPending = false;
      if (this.snapshotListeners.size === 0) return;
      const snap = this.snapshot();
      for (const listener of this.snapshotListeners) listener(snap);
    });
  }
}
