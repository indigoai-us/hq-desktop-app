/**
 * Per-company Atlas graph cache. Paint from the cached graph first, then
 * refresh in the background: from the Console company atlas endpoint on the
 * web, or from the vault through the platform adapter in the native app.
 */

import { parseAtlasGraph, type AtlasGraph } from "./atlas-model.js";
import {
  buildAtlasGraph,
  listingVaultSource,
  parseLocalListing,
  type AtlasLocalSource,
  type AtlasVaultSource,
} from "./atlas-build.js";

export type AtlasFetcher = (companyUid: string) => Promise<unknown>;

/**
 * A fetcher that can paint a partial map first (QA-016). `first` resolves a
 * graph body, or null when it has nothing quick to offer (the full load then
 * runs under the first-page timeout instead).
 */
export type AtlasStagedFetcher = { first: AtlasFetcher; full: AtlasFetcher };

export interface AtlasCacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_PREFIX = "hq.atlas.v1:";

/** Console route: `GET {consoleBase}/api/companies/{companyUid}/atlas`. */
export function atlasEndpoint(consoleBase: string, companyUid: string): string {
  return `${consoleBase.replace(/\/$/, "")}/api/companies/${encodeURIComponent(companyUid)}/atlas`;
}

/**
 * BLANK-3 (owner, 2026-10-03): no timer turns a pending Atlas read into a
 * failure. By default a refresh has no time limit: the view keeps the shared
 * loader (waiting lines, then Try again) until the map arrives, and only a
 * real failure shows "The map didn't load". A caller may still pass explicit
 * limits (tests do).
 */
export const ATLAS_REFRESH_TIMEOUT_MS: number | null = null;
export const ATLAS_FULL_LOAD_TIMEOUT_MS: number | null = null;

/** Why a refresh failed, in terms the failed state can explain to a person. */
export type AtlasFailReason = "signed-out" | "no-access" | "timeout" | "offline" | "unavailable";

export class AtlasLoadError extends Error {
  constructor(
    readonly reason: AtlasFailReason,
    detail: string,
  ) {
    super(`atlas ${reason}: ${detail}`);
    this.name = "AtlasLoadError";
  }
}

/** Map an HTTP status or adapter failure code onto a fail reason. */
export function atlasFailReason(code: string | number | null | undefined): AtlasFailReason {
  const text = String(code ?? "").toLowerCase();
  if (/401|auth|sign|session|token/.test(text)) return "signed-out";
  if (/403|forbidden|denied/.test(text)) return "no-access";
  if (/timeout|timed out|abort/.test(text)) return "timeout";
  if (/network|offline|fetch|connect|dns/.test(text)) return "offline";
  return "unavailable";
}

/** The failed-state reason for any thrown refresh error. */
export function reasonForError(err: unknown): AtlasFailReason {
  if (err instanceof AtlasLoadError) return err.reason;
  if (err instanceof Error) return atlasFailReason(`${err.name} ${err.message}`);
  return "unavailable";
}

export function consoleAtlasFetcher(
  consoleBase: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  timeoutMs: number | null = ATLAS_REFRESH_TIMEOUT_MS,
): AtlasFetcher {
  return async (companyUid) => {
    const controller = typeof AbortController === "undefined" || timeoutMs === null ? null : new AbortController();
    const timer = controller && timeoutMs !== null ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetchImpl(atlasEndpoint(consoleBase, companyUid), {
        credentials: "include",
        cache: "no-store",
        signal: controller?.signal,
      });
      if (!res.ok) throw new AtlasLoadError(atlasFailReason(res.status), `http ${res.status}`);
      return await res.json();
    } catch (err) {
      if (err instanceof AtlasLoadError) throw err;
      throw new AtlasLoadError(reasonForError(err), err instanceof Error ? err.message : String(err));
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/**
 * Native path: build the graph from the ACL-filtered vault listing the
 * platform adapter reaches with the app's own HQ sign-in (QA-016).
 */
export function vaultAtlasFetcher(source: AtlasVaultSource): AtlasFetcher {
  return async (companyUid) => {
    try {
      return await buildAtlasGraph(source, companyUid);
    } catch (err) {
      if (err instanceof AtlasLoadError) throw err;
      throw new AtlasLoadError(reasonForError(err), err instanceof Error ? err.message : String(err));
    }
  };
}

/**
 * Native path over the company folder synced to this machine (QA-016): the
 * first page (district roots, no recursive walk) paints the map at once, the
 * full listing (cached on disk by folder revision) fills counts and links.
 * Without a local folder it falls back to the vault listing.
 */
export function localAtlasFetcher(
  local: AtlasLocalSource,
  companySlug: string,
  fallback: AtlasVaultSource | null,
): AtlasStagedFetcher {
  const read = (key: string) => local.readText(companySlug, key);
  const wrap = async <T>(job: () => Promise<T>): Promise<T> => {
    try {
      return await job();
    } catch (err) {
      if (err instanceof AtlasLoadError) throw err;
      throw new AtlasLoadError(reasonForError(err), err instanceof Error ? err.message : String(err));
    }
  };
  return {
    first: (companyUid) =>
      wrap(async () => {
        const page = parseLocalListing(await local.firstPage(companySlug));
        if (!page) return null;
        return buildAtlasGraph(listingVaultSource(page, read), companyUid, { links: false });
      }),
    full: (companyUid) =>
      wrap(async () => {
        const listing = parseLocalListing(await local.listing(companySlug));
        if (listing) return buildAtlasGraph(listingVaultSource(listing, read), companyUid);
        if (fallback) return buildAtlasGraph(fallback, companyUid);
        throw new AtlasLoadError("unavailable", "company folder is not on this machine");
      }),
  };
}

/** Reject when `job` has not settled within `ms`; the job itself is left alone. */
function withTimeout<T>(job: Promise<T>, ms: number | null): Promise<T> {
  if (ms === null) return job;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AtlasLoadError("timeout", "atlas refresh timed out")), ms);
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

export type AtlasPartialListener = (graph: AtlasGraph) => void;

export function createAtlasCache(input: {
  fetcher: AtlasFetcher | AtlasStagedFetcher;
  storage?: AtlasCacheStorage | null;
  /** Upper bound for the first paint (or the whole refresh without a first page); none by default. */
  timeoutMs?: number | null;
  /** Upper bound for the full load once a partial map is showing; none by default. */
  fullTimeoutMs?: number | null;
}) {
  const timeoutMs = input.timeoutMs ?? ATLAS_REFRESH_TIMEOUT_MS;
  const fullTimeoutMs = input.fullTimeoutMs ?? ATLAS_FULL_LOAD_TIMEOUT_MS;
  const staged = typeof input.fetcher === "function" ? null : input.fetcher;
  const fetchFull = typeof input.fetcher === "function" ? input.fetcher : input.fetcher.full;
  const memory = new Map<string, AtlasGraph>();
  const inflight = new Map<
    string,
    { job: Promise<AtlasGraph | null>; partial: AtlasGraph | null; listeners: Set<AtlasPartialListener> }
  >();
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

  /**
   * Load the company graph. With a staged fetcher the first page must arrive
   * within the refresh timeout; it goes to `onPartial` (never to storage) and
   * the full load then runs under the longer full-load ceiling.
   */
  function refresh(companyUid: string, onPartial?: AtlasPartialListener): Promise<AtlasGraph | null> {
    const running = inflight.get(companyUid);
    if (running) {
      if (onPartial) {
        running.listeners.add(onPartial);
        if (running.partial) onPartial(running.partial);
      }
      return running.job;
    }
    const entry = {
      job: null as unknown as Promise<AtlasGraph | null>,
      partial: null as AtlasGraph | null,
      listeners: new Set<AtlasPartialListener>(onPartial ? [onPartial] : []),
    };
    const load = async (): Promise<unknown> => {
      if (!staged) return withTimeout(Promise.resolve().then(() => fetchFull(companyUid)), timeoutMs);
      const firstBody = await withTimeout(Promise.resolve().then(() => staged.first(companyUid)), timeoutMs);
      if (firstBody == null) {
        return withTimeout(Promise.resolve().then(() => fetchFull(companyUid)), timeoutMs);
      }
      const partial = parseAtlasGraph(firstBody);
      if (!partial) throw new Error("atlas first page did not parse");
      entry.partial = partial;
      for (const listener of entry.listeners) listener(partial);
      return withTimeout(Promise.resolve().then(() => fetchFull(companyUid)), fullTimeoutMs);
    };
    const job = load()
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
    entry.job = job;
    inflight.set(companyUid, entry);
    return job;
  }

  return { cached, refresh };
}

export type AtlasCache = ReturnType<typeof createAtlasCache>;

const shared = new Map<string, AtlasCache>();

/**
 * One cache per source for the app session, backed by localStorage. Pass a
 * `fetcher` (with a distinct `key`) to load through something other than the
 * Console endpoint at `key`; the snapshot storage is shared either way.
 */
export function sharedAtlasCache(key: string, fetcher?: AtlasFetcher | AtlasStagedFetcher): AtlasCache {
  let cache = shared.get(key);
  if (!cache) {
    let storage: AtlasCacheStorage | null = null;
    try {
      storage = typeof localStorage === "undefined" ? null : localStorage;
    } catch (err) {
      console.warn("[atlas] localStorage unavailable", err);
    }
    cache = createAtlasCache({ fetcher: fetcher ?? consoleAtlasFetcher(key), storage });
    shared.set(key, cache);
  }
  return cache;
}
