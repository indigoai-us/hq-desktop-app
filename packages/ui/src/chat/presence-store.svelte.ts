/**
 * Svelte 5 runes mirror of the framework-free PresenceStore from @hq/core.
 *
 * Hosts call `bindPresenceStore(store)` once (mesh-runtime / desktop-alt).
 * Components read `presenceSnapshot` / `presenceStatus(...)` inside $derived.
 */

import type {
  PresenceEntry,
  PresenceSnapshot,
  PresenceStatus,
  PresenceStore,
} from "@hq/core";

let snapshot = $state<PresenceSnapshot>(new Map());
let bound: PresenceStore | null = null;
let unsubscribe: (() => void) | null = null;

/** Reactive full snapshot — read inside $derived / templates. */
export function presenceSnapshot(): PresenceSnapshot {
  return snapshot;
}

export function presenceStatus(
  companyUid: string,
  actorUid: string,
): PresenceStatus | null {
  const entry = snapshot.get(companyUid)?.get(actorUid);
  return entry?.status ?? null;
}

export function presenceEntry(
  companyUid: string,
  actorUid: string,
): PresenceEntry | undefined {
  return snapshot.get(companyUid)?.get(actorUid);
}

/** Bind a core PresenceStore into the runes mirror. Returns unbind. */
export function bindPresenceStore(store: PresenceStore): () => void {
  unsubscribe?.();
  bound = store;
  snapshot = store.snapshot();
  unsubscribe = store.subscribeSnapshot((next) => {
    snapshot = next;
  });
  return () => {
    if (bound === store) {
      unsubscribe?.();
      unsubscribe = null;
      bound = null;
      snapshot = new Map();
    }
  };
}
