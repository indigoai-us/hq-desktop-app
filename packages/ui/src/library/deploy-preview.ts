/**
 * Side-panel preview for one deployment. The desktop reads the deployed page's
 * og:image (or twitter:image) only when a row is selected, and keeps the result
 * on disk keyed by app id and deploy time. This module keeps a session copy in
 * memory so reselecting a row paints at once, and shares one in-flight read per
 * key.
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
