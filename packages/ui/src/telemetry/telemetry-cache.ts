/**
 * Personal telemetry cache. The view paints whatever is already stored,
 * then refreshes in the background. No timer is started here.
 *
 * There is no built-in fallback: the running app shows a skeleton until the
 * first real load, then an error state if it fails. Only the perf harness and
 * tests pass `fallback` (the design fixture).
 */
import type { TelemetryRange, TelemetrySnapshot } from "./telemetry-model.js";

export type TelemetryFetcher = (range?: TelemetryRange) => Promise<TelemetrySnapshot | null>;

export interface TelemetryCacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// v2: v1 entries can hold the design fixture written by older builds.
const STORAGE_KEY = "hq.telemetry.personal.v2";

export function createTelemetryCache(input: {
  fetcher?: TelemetryFetcher;
  storage?: TelemetryCacheStorage | null;
  fallback?: TelemetrySnapshot | null;
}) {
  const fallback = input.fallback ?? null;
  let memory: TelemetrySnapshot | null = null;
  let inflight: { range: TelemetryRange | undefined; job: Promise<TelemetrySnapshot> } | null = null;
  const storage = input.storage ?? null;

  function readStorage(): TelemetrySnapshot | null {
    if (!storage) return null;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as TelemetrySnapshot;
      if (!parsed || typeof parsed.sessions !== "number" || !Array.isArray(parsed.sessionsRows)) {
        return null;
      }
      return parsed;
    } catch (err) {
      console.warn("[telemetry] cache read failed", err);
      return null;
    }
  }

  function cached(): TelemetrySnapshot | null {
    if (memory) return memory;
    const stored = readStorage();
    if (stored) memory = stored;
    return stored;
  }

  function write(snapshot: TelemetrySnapshot): void {
    memory = snapshot;
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch (err) {
      console.warn("[telemetry] cache write failed", err);
    }
  }

  function refresh(range?: TelemetryRange): Promise<TelemetrySnapshot> {
    if (inflight && inflight.range === range) return inflight.job;
    const job = (input.fetcher ? input.fetcher(range) : Promise.resolve(null))
      .then((next) => {
        const snapshot = next ?? fallback;
        if (!snapshot) throw new Error("telemetry: no source configured");
        write(snapshot);
        return snapshot;
      })
      .finally(() => {
        if (inflight?.job === job) inflight = null;
      });
    inflight = { range, job };
    return job;
  }

  return { cached, refresh, fallback };
}

export type TelemetryCache = ReturnType<typeof createTelemetryCache>;
