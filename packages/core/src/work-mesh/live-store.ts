/**
 * In-memory company live-read cache (US-015).
 *
 * MeshClient rebuilds this from GET /v1/work-mesh/live on open/reconnect and
 * on `{kind:"live"}` directory wakes. UI hosts subscribe and mirror into runes.
 */

import {
  parseLiveReadResponse,
  type LiveParticipant,
  type LiveReadResponse,
  type LiveSession,
} from "./live.js";

export type LiveReadSnapshot = ReadonlyMap<string, LiveReadResponse>;

export type LiveReadListener = (
  companyUid: string,
  response: LiveReadResponse,
) => void;

export type LiveReadSnapshotListener = (snapshot: LiveReadSnapshot) => void;

/**
 * Mutable live-read map keyed by companyUid.
 */
export class LiveReadStore {
  private readonly companies = new Map<string, LiveReadResponse>();
  private readonly listeners = new Set<LiveReadListener>();
  private readonly snapshotListeners = new Set<LiveReadSnapshotListener>();

  subscribe(listener: LiveReadListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeSnapshot(listener: LiveReadSnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    return () => {
      this.snapshotListeners.delete(listener);
    };
  }

  get(companyUid: string): LiveReadResponse | undefined {
    return this.companies.get(companyUid.trim());
  }

  snapshot(): LiveReadSnapshot {
    return new Map(this.companies);
  }

  /** Replace one company's live-read projection. */
  replace(companyUid: string, response: LiveReadResponse): void {
    const uid = companyUid.trim();
    if (!uid) return;
    this.companies.set(uid, response);
    for (const listener of this.listeners) listener(uid, response);
    this.emitSnapshot();
  }

  /** Parse raw GET /v1/work-mesh/live JSON and replace when valid. */
  replaceFromRaw(companyUid: string, raw: unknown): LiveReadResponse | null {
    const parsed = parseLiveReadResponse(raw);
    if (!parsed) return null;
    this.replace(companyUid, parsed);
    return parsed;
  }

  clear(): void {
    if (this.companies.size === 0) return;
    this.companies.clear();
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    if (this.snapshotListeners.size === 0) return;
    const snap = this.snapshot();
    for (const listener of this.snapshotListeners) listener(snap);
  }
}

/** Presence-shaped rows for PresenceStore.replaceCompany. */
export function presenceRowsFromLive(
  response: LiveReadResponse,
): Array<{
  actorUid: string;
  actorType: string;
  presence: string;
  lastSeenAt: string;
}> {
  return response.participants.map((p: LiveParticipant) => ({
    actorUid: p.actorUid,
    actorType: p.actorType,
    presence: p.presence,
    lastSeenAt: p.lastSeenAt,
  }));
}

export type { LiveParticipant, LiveReadResponse, LiveSession };
