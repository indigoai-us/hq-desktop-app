/**
 * Personal telemetry cache. The view paints whatever is already stored,
 * then refreshes in the background. No timer is started here.
 */
import { TELEMETRY_SMOKE } from "./telemetry-smoke.js";
import type { TelemetrySnapshot } from "./telemetry-model.js";

export type TelemetryFetcher = () => Promise<TelemetrySnapshot | null>;

export interface TelemetryCacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = "hq.telemetry.personal.v1";

export function createTelemetryCache(input: {
  fetcher?: TelemetryFetcher;
  storage?: TelemetryCacheStorage | null;
  fallback?: TelemetrySnapshot;
}) {
  const fallback = input.fallback ?? TELEMETRY_SMOKE;
  let memory: TelemetrySnapshot | null = null;
  let inflight: Promise<TelemetrySnapshot> | null = null;
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

  function refresh(): Promise<TelemetrySnapshot> {
    if (inflight) return inflight;
    const job = (input.fetcher ? input.fetcher() : Promise.resolve(fallback))
      .then((next) => {
        const snapshot = next ?? fallback;
        write(snapshot);
        return snapshot;
      })
      .finally(() => {
        inflight = null;
      });
    inflight = job;
    return job;
  }

  return { cached, refresh, fallback };
}

export type TelemetryCache = ReturnType<typeof createTelemetryCache>;
