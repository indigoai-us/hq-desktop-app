/**
 * Per-company Atlas graph cache. Paint from the cached graph first, then
 * refresh from the Console company atlas endpoint in the background.
 */

import { parseAtlasGraph, type AtlasGraph } from "./atlas-model.js";

export type AtlasFetcher = (companyUid: string) => Promise<unknown>;

export interface AtlasCacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_PREFIX = "hq.atlas.v1:";

/** Console route: `GET {consoleBase}/api/companies/{companyUid}/atlas`. */
export function atlasEndpoint(consoleBase: string, companyUid: string): string {
  return `${consoleBase.replace(/\/$/, "")}/api/companies/${encodeURIComponent(companyUid)}/atlas`;
}

/** Longest an Atlas refresh may run before it counts as failed (QA-016). */
export const ATLAS_REFRESH_TIMEOUT_MS = 15_000;

export function consoleAtlasFetcher(
  consoleBase: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  timeoutMs = ATLAS_REFRESH_TIMEOUT_MS,
): AtlasFetcher {
  return async (companyUid) => {
    const controller = typeof AbortController === "undefined" ? null : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetchImpl(atlasEndpoint(consoleBase, companyUid), {
        credentials: "include",
        cache: "no-store",
        signal: controller?.signal,
      });
      if (!res.ok) throw new Error(`atlas ${res.status}`);
      return await res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/** Reject when `job` has not settled within `ms`; the job itself is left alone. */
function withTimeout<T>(job: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("atlas refresh timed out")), ms);
    job.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function createAtlasCache(input: {
  fetcher: AtlasFetcher;
  storage?: AtlasCacheStorage | null;
  /** Upper bound for one refresh, whatever the fetcher does. */
  timeoutMs?: number;
}) {
  const timeoutMs = input.timeoutMs ?? ATLAS_REFRESH_TIMEOUT_MS;
  const memory = new Map<string, AtlasGraph>();
  const inflight = new Map<string, Promise<AtlasGraph | null>>();
  const storage = input.storage ?? null;

  function cached(companyUid: string): AtlasGraph | null {
    const hit = memory.get(companyUid);
    if (hit) return hit;
    if (!storage) return null;
    let raw: string | null = null;
    try {
      raw = storage.getItem(STORAGE_PREFIX + companyUid);
    } catch (err) {
      console.warn("[atlas] cache read failed", err);
      return null;
    }
    if (!raw) return null;
    let parsed: AtlasGraph | null = null;
    try {
      parsed = parseAtlasGraph(JSON.parse(raw));
    } catch (err) {
      console.warn("[atlas] cached graph unreadable", err);
      return null;
    }
    if (parsed) memory.set(companyUid, parsed);
    return parsed;
  }

  function refresh(companyUid: string): Promise<AtlasGraph | null> {
    const running = inflight.get(companyUid);
    if (running) return running;
    const job = withTimeout(Promise.resolve().then(() => input.fetcher(companyUid)), timeoutMs)
      .then((body) => {
        const graph = parseAtlasGraph(body);
        if (!graph) throw new Error("atlas response did not parse");
        memory.set(companyUid, graph);
        try {
          storage?.setItem(STORAGE_PREFIX + companyUid, JSON.stringify(graph));
        } catch (err) {
          console.warn("[atlas] cache write failed", err);
        }
        return graph;
      })
      .finally(() => inflight.delete(companyUid));
    inflight.set(companyUid, job);
    return job;
  }

  return { cached, refresh };
}

export type AtlasCache = ReturnType<typeof createAtlasCache>;

const shared = new Map<string, AtlasCache>();

/** One cache per Console base for the app session, backed by localStorage. */
export function sharedAtlasCache(consoleBase: string): AtlasCache {
  let cache = shared.get(consoleBase);
  if (!cache) {
    let storage: AtlasCacheStorage | null = null;
    try {
      storage = typeof localStorage === "undefined" ? null : localStorage;
    } catch (err) {
      console.warn("[atlas] localStorage unavailable", err);
    }
    cache = createAtlasCache({ fetcher: consoleAtlasFetcher(consoleBase), storage });
    shared.set(consoleBase, cache);
  }
  return cache;
}
