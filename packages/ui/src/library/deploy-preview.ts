/**
 * Side-panel preview for one deployment, read only when a row is selected.
 *
 * First choice is a rendered snapshot of the live page: the desktop loads it in
 * a hidden window and captures a 1280x800 view (macOS today). Public apps only;
 * protected apps sit behind hq-deploy's access gate, which the hidden window
 * has no session for. When the snapshot fails, times out, or is unsupported,
 * the panel falls back to the page's og:image (or twitter:image). Both are kept
 * on disk by the desktop, keyed by app id and deploy time; this module keeps a
 * session copy in memory so reselecting a row paints at once, and shares one
 * in-flight read per key.
 */
import type { AdapterPromise, Json } from "@hq/platform";
import type { PersonalDeployment } from "./personal-deployments.js";

export interface DeployPreview {
  /** Absolute og:image URL the page declared, or null when it has none. */
  ogImageUrl: string | null;
  /** Downloaded image as a data: URL, or null when there is no image to show. */
  thumbnail: string | null;
}

export type DeployPreviewFetcher = (
  appId: string,
  url: string,
  deployedAt: string,
  refresh: boolean,
) => AdapterPromise<Json>;

/** A redeploy changes deployedAt, so it changes the key and the old preview is not reused. */
export function previewCacheKey(row: Pick<PersonalDeployment, "id" | "deployedAt">): string {
  return `${row.id}|${row.deployedAt ?? ""}`;
}

/** Only live https deployments get a preview. */
export function previewable(row: PersonalDeployment | null): row is PersonalDeployment {
  return Boolean(row && row.status === "active" && row.url.startsWith("https://"));
}

const memory = new Map<string, DeployPreview>();
const inflight = new Map<string, Promise<DeployPreview>>();

export function cachedDeployPreview(row: Pick<PersonalDeployment, "id" | "deployedAt">): DeployPreview | null {
  return memory.get(previewCacheKey(row)) ?? null;
}

export function resetDeployPreviewCacheForTests(): void {
  memory.clear();
  inflight.clear();
}

function parsePreview(value: unknown): DeployPreview {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const og = typeof raw.ogImageUrl === "string" && raw.ogImageUrl ? raw.ogImageUrl : null;
  const thumb = typeof raw.thumbnail === "string" && raw.thumbnail.startsWith("data:image/") ? raw.thumbnail : null;
  return { ogImageUrl: og, thumbnail: thumb };
}

/** Read a preview through the desktop. Rejects on failure; the panel shows "Preview unavailable". */
export function loadDeployPreview(
  fetcher: DeployPreviewFetcher,
  row: PersonalDeployment,
  options: { refresh?: boolean } = {},
): Promise<DeployPreview> {
  const key = previewCacheKey(row);
  const refresh = options.refresh === true;
  if (!refresh) {
    const hit = memory.get(key);
    if (hit) return Promise.resolve(hit);
    const pending = inflight.get(key);
    if (pending) return pending;
  }
  const request = fetcher(row.id, row.url, row.deployedAt ?? "", refresh).then((result) => {
    if (!result.ok) throw new Error(`deploy preview ${result.reason}`);
    const preview = parsePreview(result.value);
    memory.set(key, preview);
    return preview;
  });
  inflight.set(key, request);
  const clear = () => {
    if (inflight.get(key) === request) inflight.delete(key);
  };
  request.then(clear, clear);
  return request;
}

export type DeploySnapshotFetcher = DeployPreviewFetcher;

export interface PanelPreview {
  /** "snapshot" = rendered page, "og" = share image, "none" = nothing to show. */
  kind: "snapshot" | "og" | "none";
  src: string | null;
}

/** Wait after the last selection change before reading, so arrow-key scrolling does not fan out. */
export const PREVIEW_DEBOUNCE_MS = 250;
/** The desktop gives up at 8 s; this covers the IPC round trip on top. */
export const SNAPSHOT_TIMEOUT_MS = 10_000;

/** Only public live apps are rendered; protected ones would show their access gate. */
export function snapshotEligible(row: PersonalDeployment | null): row is PersonalDeployment {
  return previewable(row) && row.access === "Public";
}

const panelMemory = new Map<string, PanelPreview>();
const panelInflight = new Map<string, Promise<PanelPreview>>();

export function cachedPanelPreview(row: Pick<PersonalDeployment, "id" | "deployedAt">): PanelPreview | null {
  return panelMemory.get(previewCacheKey(row)) ?? null;
}

export function resetPanelPreviewCacheForTests(): void {
  panelMemory.clear();
  panelInflight.clear();
  resetDeployPreviewCacheForTests();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("deploy snapshot timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function readSnapshot(fetcher: DeploySnapshotFetcher, row: PersonalDeployment, refresh: boolean, timeoutMs: number): Promise<string> {
  const result = await withTimeout(Promise.resolve(fetcher(row.id, row.url, row.deployedAt ?? "", refresh)), timeoutMs);
  if (!result.ok) throw new Error(`deploy snapshot ${result.reason}`);
  const raw = (result.value && typeof result.value === "object" ? result.value : {}) as Record<string, unknown>;
  if (typeof raw.snapshot !== "string" || !raw.snapshot.startsWith("data:image/")) throw new Error("deploy snapshot empty");
  return raw.snapshot;
}

/**
 * Snapshot first (public apps), then og:image, then nothing. Rejects only when
 * every source that was tried failed; the panel then shows "Preview unavailable".
 */
export function loadPanelPreview(
  fetchers: { snapshot?: DeploySnapshotFetcher; og?: DeployPreviewFetcher },
  row: PersonalDeployment,
  options: { refresh?: boolean; timeoutMs?: number } = {},
): Promise<PanelPreview> {
  const key = previewCacheKey(row);
  const refresh = options.refresh === true;
  if (!refresh) {
    const hit = panelMemory.get(key);
    if (hit) return Promise.resolve(hit);
    const pending = panelInflight.get(key);
    if (pending) return pending;
  }
  const request = (async (): Promise<PanelPreview> => {
    let snapshotFailed = false;
    if (fetchers.snapshot && snapshotEligible(row)) {
      try {
        const src = await readSnapshot(fetchers.snapshot, row, refresh, options.timeoutMs ?? SNAPSHOT_TIMEOUT_MS);
        return { kind: "snapshot", src };
      } catch (err) {
        snapshotFailed = true;
        console.warn("[deployments] snapshot unavailable, using share image", err);
      }
    }
    if (fetchers.og) {
      const og = await loadDeployPreview(fetchers.og, row, { refresh });
      return og.thumbnail ? { kind: "og", src: og.thumbnail } : { kind: "none", src: null };
    }
    if (snapshotFailed) throw new Error("deploy preview unavailable");
    return { kind: "none", src: null };
  })();
  panelInflight.set(key, request);
  request.then(
    (preview) => {
      panelMemory.set(key, preview);
    },
    () => undefined,
  );
  const clear = () => {
    if (panelInflight.get(key) === request) panelInflight.delete(key);
  };
  request.then(clear, clear);
  return request;
}
