import type { AdapterResult, CompanyApi } from "@hq/platform";
import type { CompanySummary } from "./company-summary.svelte";
import type { CompanyBoard } from "./company-board.svelte";
import type { DeploymentEntry } from "./DeploymentRow.svelte";
import type { SecretEnv } from "./SecretEnvRow.svelte";
import { createResourceCache } from "../common/resource-cache.svelte";
import { withActivityRequestDeadline } from "../common/activity-request";

export type CompanyResource =
  "summary" | "board" | "activity" | "deployments" | "secrets";

// ---------------------------------------------------------------------------
// Platform seam (port of the desktop-alt company store). The five former
// `get_company_*` desktop commands map onto the injected CompanyApi slice.
// summary / board / activity are needs-new-API on web — the adapter returns
// `unavailable`, which `unwrap` rethrows as CompanyResourceUnavailableError so
// panels can render the standard degraded state instead of a generic error.
// ---------------------------------------------------------------------------

export class CompanyResourceUnavailableError extends Error {
  readonly reason = "unavailable" as const;
  constructor(resource: string, code?: string) {
    super(
      `${resource} is not available on this platform${code ? ` (${code})` : ""}`,
    );
    this.name = "CompanyResourceUnavailableError";
  }
}

/** True when a company-store rejection means "capability not on this platform". */
export function isCompanyResourceUnavailable(err: unknown): boolean {
  return err instanceof CompanyResourceUnavailableError;
}

let api: CompanyApi | null = null;

/** Inject the platform backend before using the loaders. */
export function configureCompanyApi(next: CompanyApi | null): void {
  api = next;
}

function unwrap<T>(resource: string, res: AdapterResult<T>): T {
  if (res.ok) return res.value;
  if (res.reason === "unavailable") {
    throw new CompanyResourceUnavailableError(resource, res.code);
  }
  const parts = [res.code, res.message].filter(Boolean);
  throw new Error(parts.join(": ") || "error");
}

function requireApi(): CompanyApi {
  if (!api) throw new Error("company-store: no platform api configured");
  return api;
}

const POLL_INTERVAL_MS = 30_000;
const cache = createResourceCache({ ttlMs: POLL_INTERVAL_MS });
const key = (resource: CompanyResource, slug: string) => `${slug}:${resource}`;
let active: { slug: string; resource: CompanyResource } | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const loaders = {
  summary: (slug: string) =>
    requireApi()
      .getSummary(slug)
      .then((r) => unwrap("summary", r) as unknown as CompanySummary),
  board: (slug: string) =>
    requireApi()
      .getBoard(slug)
      .then((r) => unwrap("board", r) as unknown as CompanyBoard),
  // Bound the promise stored by the shared cache, not only an individual
  // panel's projection of it. A timed-out request then clears `inFlight`,
  // so Retry and focus refreshes can issue a fresh request.
  activity: (slug: string) =>
    withActivityRequestDeadline(
      requireApi()
        .getActivity(slug)
        .then((r) => unwrap("activity", r) as unknown),
    ),
  deployments: (slug: string) =>
    requireApi()
      .getDeployments(slug)
      .then(
        (r) =>
          unwrap("deployments", r) as unknown as Partial<DeploymentEntry>[],
      )
      .then((v) => (Array.isArray(v) ? v : [])),
  secrets: (slug: string) =>
    requireApi()
      .getSecrets(slug)
      .then((r) => unwrap("secrets", r) as unknown as Partial<SecretEnv>[])
      .then((v) => (Array.isArray(v) ? v : [])),
};

function load<R extends CompanyResource>(
  resource: R,
  slug: string,
  force = false,
): Promise<Awaited<ReturnType<(typeof loaders)[R]>>> {
  return cache.load(
    key(resource, slug),
    () => loaders[resource](slug),
    force,
  ) as Promise<Awaited<ReturnType<(typeof loaders)[R]>>>;
}

function refreshActive(): void {
  if (active)
    void load(active.resource, active.slug, true).catch(() => undefined);
}

export function startCompanyStore(): void {
  if (timer !== null) return;
  timer = setInterval(refreshActive, POLL_INTERVAL_MS);
  window.addEventListener("focus", refreshActive);
}

export function setActiveCompanyResource(
  slug: string | null,
  resource: CompanyResource | null,
): void {
  active = slug && resource ? { slug, resource } : null;
}

export function invalidateCompanyResources(
  slug: string,
  resources?: CompanyResource[],
): void {
  const selected = resources ? new Set(resources) : null;
  cache.invalidate((cacheKey) => {
    const prefix = `${slug}:`;
    return (
      cacheKey.startsWith(prefix) &&
      (!selected ||
        selected.has(cacheKey.slice(prefix.length) as CompanyResource))
    );
  });
}

export function stopCompanyStore(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  if (typeof window !== "undefined")
    window.removeEventListener("focus", refreshActive);
  active = null;
  cache.clear();
}

export const companyStore = {
  /** Bumps when cache entries are written or invalidated — panels subscribe via `$effect`. */
  get revision() {
    return cache.revision;
  },
  summary: (slug: string) => cache.read<CompanySummary>(key("summary", slug)),
  board: (slug: string) => cache.read<CompanyBoard>(key("board", slug)),
  activity: (slug: string) => cache.read<unknown>(key("activity", slug)),
  deployments: (slug: string) =>
    cache.read<Partial<DeploymentEntry>[]>(key("deployments", slug)),
  secrets: (slug: string) =>
    cache.read<Partial<SecretEnv>[]>(key("secrets", slug)),
  loadSummary: (slug: string, force = false) => load("summary", slug, force),
  loadBoard: (slug: string, force = false) => load("board", slug, force),
  loadActivity: <T = unknown>(slug: string, force = false) =>
    load("activity", slug, force) as Promise<T>,
  loadDeployments: (slug: string, force = false) =>
    load("deployments", slug, force),
  loadSecrets: (slug: string, force = false) => load("secrets", slug, force),
};
