import { invoke } from '@tauri-apps/api/core';
import type { CompanySummary } from './company-summary.svelte';
import type { CompanyBoard } from './company-board.svelte';
import { createResourceCache } from './resource-cache.svelte';
import { withActivityRequestDeadline } from './activity-request';

/**
 * Cached company cloud resources for the desktop shell.
 *
 * US-021: secrets and the deployments panel loader are gone — the desktop
 * never requests company secrets. Activity remains for the Overview digest;
 * summary/board power Overview + board surfaces. Deployments count still
 * arrives inside `get_company_summary` when the backend aggregates it.
 */
export type CompanyResource = 'summary' | 'board' | 'activity';

const POLL_INTERVAL_MS = 30_000;
const cache = createResourceCache({ ttlMs: POLL_INTERVAL_MS });
const key = (resource: CompanyResource, slug: string) => `${slug}:${resource}`;
let active: { slug: string; resource: CompanyResource } | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const loaders = {
  summary: (slug: string) => invoke<CompanySummary>('get_company_summary', { slug }),
  board: (slug: string) => invoke<CompanyBoard>('get_company_board', { slug }),
  // Bound the promise stored by the shared cache, not only an individual
  // panel's projection of it. A timed-out native request then clears
  // `inFlight`, so Retry and focus refreshes can issue a fresh request.
  activity: (slug: string) =>
    withActivityRequestDeadline(invoke<unknown>('get_company_activity', { slug })),
};

function load<R extends CompanyResource>(
  resource: R,
  slug: string,
  force = false,
): Promise<Awaited<ReturnType<(typeof loaders)[R]>>> {
  return cache.load(key(resource, slug), () => loaders[resource](slug), force) as Promise<
    Awaited<ReturnType<(typeof loaders)[R]>>
  >;
}

function refreshActive(): void {
  if (active) void load(active.resource, active.slug, true).catch(() => undefined);
}

export function startCompanyStore(): void {
  if (timer !== null) return;
  timer = setInterval(refreshActive, POLL_INTERVAL_MS);
  window.addEventListener('focus', refreshActive);
}

export function setActiveCompanyResource(
  slug: string | null,
  resource: CompanyResource | null,
): void {
  active = slug && resource ? { slug, resource } : null;
}

export function invalidateCompanyResources(slug: string, resources?: CompanyResource[]): void {
  const selected = resources ? new Set(resources) : null;
  cache.invalidate((cacheKey) => {
    const prefix = `${slug}:`;
    return cacheKey.startsWith(prefix) && (!selected || selected.has(cacheKey.slice(prefix.length) as CompanyResource));
  });
}

export function stopCompanyStore(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  window.removeEventListener('focus', refreshActive);
  active = null;
  cache.clear();
}

export const companyStore = {
  /** Bumps when cache entries are written or invalidated — panels subscribe via `$effect`. */
  get revision() {
    return cache.revision;
  },
  summary: (slug: string) => cache.read<CompanySummary>(key('summary', slug)),
  board: (slug: string) => cache.read<CompanyBoard>(key('board', slug)),
  activity: (slug: string) => cache.read<unknown>(key('activity', slug)),
  loadSummary: (slug: string, force = false) => load('summary', slug, force),
  loadBoard: (slug: string, force = false) => load('board', slug, force),
  loadActivity: <T = unknown>(slug: string, force = false) =>
    load('activity', slug, force) as Promise<T>,
};
