/**
 * Settings › Storage loading: one read at a time per host, and the age line
 * for last-known figures.
 *
 * `hq storage status` takes minutes on a cold cache when it runs
 * `hq-storage.sh large` (older CLIs). Newer CLIs leave that big-file scan out
 * of status and run it as `hq storage big-files`, which the pane reads
 * separately so the summary shows first. Re-opening the screen or a
 * re-render must join the read already running instead of asking the host
 * for another; the desktop host also runs only one scan of each kind at a
 * time, so this is the first of two guards.
 */
import type { AdapterResult, StorageApi, StorageBigFiles, StorageStatus } from "@hq/platform";

type Read<T> = () => Promise<AdapterResult<T>>;

/**
 * `read()`, joined with a read already running for the same host.
 * `afterWrite` (after a delete or move): a running read started before the
 * change, so wait for it and then read again, still one at a time.
 */
function joinRead<T>(
  inFlight: WeakMap<StorageApi, Promise<AdapterResult<T>>>,
  api: StorageApi,
  read: Read<T>,
  opts: { afterWrite?: boolean },
): Promise<AdapterResult<T>> {
  const running = inFlight.get(api);
  if (running && !opts.afterWrite) return running;
  const next = (running ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => read())
    .catch((err: unknown) => ({
      ok: false as const,
      reason: "error" as const,
      message: err instanceof Error ? err.message : String(err),
    }))
    .finally(() => {
      if (inFlight.get(api) === next) inFlight.delete(api);
    }) as Promise<AdapterResult<T>>;
  inFlight.set(api, next);
  return next;
}

const statusInFlightMap = new WeakMap<StorageApi, Promise<AdapterResult<StorageStatus>>>();
const bigFilesInFlightMap = new WeakMap<StorageApi, Promise<AdapterResult<StorageBigFiles>>>();

/** `api.status()`, joined with a status read already running for the same host. */
export function joinStatus(
  api: StorageApi,
  opts: { afterWrite?: boolean } = {},
): Promise<AdapterResult<StorageStatus>> {
  return joinRead(statusInFlightMap, api, () => api.status(), opts);
}

/**
 * `api.bigFiles()`, joined with a big-files read already running for the
 * same host. Hosts without `bigFiles` answer `update-hq`, like an older CLI.
 */
export function joinBigFiles(
  api: StorageApi,
  opts: { afterWrite?: boolean } = {},
): Promise<AdapterResult<StorageBigFiles>> {
  const bigFiles = api.bigFiles?.bind(api);
  if (!bigFiles) {
    return Promise.resolve({ ok: false, reason: "error", message: "update-hq" } as AdapterResult<StorageBigFiles>);
  }
  return joinRead(bigFilesInFlightMap, api, bigFiles, opts);
}

/** True while a status read is running for this host. */
export function statusInFlight(api: StorageApi): boolean {
  return statusInFlightMap.has(api);
}

/** True while a big-files read is running for this host. */
export function bigFilesInFlight(api: StorageApi): boolean {
  return bigFilesInFlightMap.has(api);
}

/** "Figures from 20 min ago." for a cached status; null when unknown. */
export function cachedAgeCopy(fetchedAt: string | null | undefined, now: number = Date.now()): string | null {
  if (!fetchedAt) return null;
  const at = Date.parse(fetchedAt);
  if (Number.isNaN(at)) return null;
  const mins = Math.max(0, Math.floor((now - at) / 60_000));
  if (mins < 1) return "Figures from just now.";
  if (mins < 60) return `Figures from ${mins} min ago.`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Figures from ${hours} h ago.`;
  const days = Math.floor(hours / 24);
  return `Figures from ${days} day${days === 1 ? "" : "s"} ago.`;
}
