// The host's copy of `session_project_links`, per company.
//
// One store, because three surfaces read the same join: the sidebar's row
// decoration (badge, hover card), the Sessions strip's project pill, and the
// project-created card's "does this project already have a channel?" check.
// Refreshed on every session phase edge, on every project-created notice,
// after a channel is linked, and every 30 s while running. Local bindings
// render first; bounded background requests enrich channel labels. A failed
// cloud lookup never gates first paint or removes saved local sessions.

import { untrack } from 'svelte';
import * as Sentry from '@sentry/svelte';
import { listen } from '@tauri-apps/api/event';

import { safeUnlisten } from '../../lib/listener-registry';
import { loadSharedRows } from './shared-project-sessions';
import {
  loadSessionProjectLinks,
  mergeLocalProjectLinks,
  PROJECT_CHANNEL_LINKED_EVENT,
  PROJECT_CREATED_EVENT,
  type ProjectLink,
} from './session-project-links';

/** Session phase edges (Rust `agent-session:phase`). */
const PHASE_EVENT = 'agent-session:phase';

export const LINKS_REFRESH_MS = 30_000;
export const LINKS_CACHE_KEY = 'hq.session-project-links.v1';

function browserStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function loadCachedLinks(): Record<string, ProjectLink[]> {
  const storage = browserStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(LINKS_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { byCompany?: Record<string, ProjectLink[]> };
    if (!parsed?.byCompany || typeof parsed.byCompany !== 'object') return {};
    return parsed.byCompany;
  } catch {
    return {};
  }
}

function persistLinks(next: Record<string, ProjectLink[]>): void {
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.setItem(LINKS_CACHE_KEY, JSON.stringify({ byCompany: next, cachedAt: Date.now() }));
  } catch {
    // best-effort
  }
}

let settledCompanies = $state<string[]>([]);
let bootTimer: ReturnType<typeof setTimeout> | null = null;
let watchedCompanies = $state<string[]>([]);
let failedCompanies = $state<string[]>([]);
let byCompany = $state<Record<string, ProjectLink[]>>(loadCachedLinks());
let watched: string[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let unlisteners: Array<() => void> = [];
let generation = 0;
/** Dedupe Sentry until that company succeeds again. */
const reportedFailures = new Set<string>();

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function reportLinksFailure(
  company: string,
  stage: 'local' | 'enrich' | 'boot',
  err: unknown,
): void {
  const message = errorText(err);
  const key = `${company}:${stage}:${message}`;
  if (reportedFailures.has(key)) return;
  reportedFailures.add(key);
  console.error('[session-project-links]', stage, company, message);
  Sentry.captureException(err instanceof Error ? err : new Error(message), {
    tags: {
      area: 'session-project-links',
      company,
      stage,
    },
    extra: { company, stage, message },
  });
}

function clearReportedFailures(company: string): void {
  for (const key of [...reportedFailures]) {
    if (key.startsWith(`${company}:`)) reportedFailures.delete(key);
  }
}
const localRequests = new Map<string, object>();
const remoteRequests = new Map<string, object>();
const revisions = new Map<string, number>();
let remoteQueue: Array<() => Promise<void>> = [];
let activeRemote = 0;
const sharedRequests = new Set<string>();
const visibleSharedChannels = new Set<string>();

// Use the same bounded queue as channel enrichment. Shared transcript reads
// never delay local session first paint, nor replace the owner's local row.
function refreshShared(company: string, links: ProjectLink[], mine: number): void {
  for (const link of links) {
    if (!link.channelId || !visibleSharedChannels.has(link.channelId) || sharedRequests.has(link.channelId)) continue;
    const channelId = link.channelId;
    sharedRequests.add(channelId);
    remoteQueue.push(async () => {
      try {
        if (mine !== generation || !watched.includes(company) || !visibleSharedChannels.has(channelId)) return;
        const sessions = await loadSharedRows(link).catch(() => []);
        if (mine !== generation || !watched.includes(company) || !visibleSharedChannels.has(channelId)) return;
        setCompanyLinks(company, (byCompany[company] ?? []).map(row => row.channelId !== channelId ? row : {
          ...row, sessions: [...row.sessions.filter(session => !session.sharedChannelId), ...sessions],
        }));
      } finally {
        if (mine === generation) sharedRequests.delete(channelId);
      }
    });
  }
  drainRemote();
}

function watchSharedChannel(company: string, link: ProjectLink, visible: boolean): void {
  if (!link.channelId) return;
  if (!visible) { visibleSharedChannels.delete(link.channelId); return; }
  if (visibleSharedChannels.has(link.channelId)) return;
  visibleSharedChannels.add(link.channelId);
  refreshShared(company, [link], generation);
}

function setCompanyLinks(company: string, links: ProjectLink[]): void {
  byCompany = { ...byCompany, [company]: links };
  persistLinks(byCompany);
}

function drainRemote(): void {
  while (activeRemote < 4 && remoteQueue.length) {
    const run = remoteQueue.shift()!;
    activeRemote += 1;
    void run().finally(() => { activeRemote -= 1; drainRemote(); });
  }
}

function enrich(company: string, mine: number): void {
  if (remoteRequests.has(company)) return;
  const request = {};
  remoteRequests.set(company, request);
  remoteQueue.push(async () => {
    if (mine !== generation) return;
    const revision = revisions.get(company);
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const links = await Promise.race([
        loadSessionProjectLinks(company),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Project links timed out')), 10000); }),
      ]).finally(() => clearTimeout(timeout));
      if (mine !== generation || !watched.includes(company)) return;
      failedCompanies = failedCompanies.filter(item => item !== company);
      clearReportedFailures(company);
      const current = byCompany[company] ?? [];
      // An intervening phase refresh owns membership/status. A slow network
      // response can enrich labels but cannot roll that newer state back.
      setCompanyLinks(company, revision === revisions.get(company) ? [
        ...links.map(link => ({ ...link, sessions: [...link.sessions,
          ...(current.find(row => row.channelId === link.channelId)?.sessions.filter(session => session.sharedChannelId) ?? []),
        ] })),
        ...current.filter((link) => !links.some((row) => row.project === link.project)),
      ] : [
        ...mergeLocalProjectLinks(current, links),
      ]);
      refreshShared(company, byCompany[company], mine);
    } catch (err) {
      if (mine === generation && !failedCompanies.includes(company)) failedCompanies = [...failedCompanies, company];
      if (mine === generation) reportLinksFailure(company, 'enrich', err);
      // Local links remain usable offline.
    } finally {
      if (mine === generation && !settledCompanies.includes(company)) settledCompanies = [...settledCompanies, company];
      if (remoteRequests.get(company) === request) remoteRequests.delete(company);
    }
  });
  drainRemote();
}

async function refresh(): Promise<void> {
  const mine = generation;
  const companies = watched.slice();
  await Promise.all(
    companies.map(async (company) => {
      if (localRequests.has(company)) return;
      const request = {};
      localRequests.set(company, request);
      try {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const links = await Promise.race([
          loadSessionProjectLinks(company, true),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Project sessions timed out')), 10000); }),
        ]).finally(() => clearTimeout(timeout));
        if (mine !== generation || !watched.includes(company)) return;
        revisions.set(company, (revisions.get(company) ?? 0) + 1);
        failedCompanies = failedCompanies.filter(item => item !== company);
        clearReportedFailures(company);
        const previous = byCompany[company] ?? [];
        setCompanyLinks(company, mergeLocalProjectLinks(links, previous));
      } catch (err) {
        if (mine === generation && !failedCompanies.includes(company)) failedCompanies = [...failedCompanies, company];
        if (mine === generation) reportLinksFailure(company, 'local', err);
        // Keep the last known links: the flag may be off, or hq-pro away.
      } finally {
        if (localRequests.get(company) === request) localRequests.delete(company);
      }
      if (mine === generation && watched.includes(company)) {
        refreshShared(company, byCompany[company] ?? [], mine);
        enrich(company, mine);
      }
    }),
  );
}

function scheduleRefresh(): void {
  void refresh();
}

async function subscribe(): Promise<void> {
  const names = [PHASE_EVENT, PROJECT_CREATED_EVENT];
  const attached = await Promise.all(
    names.map((name) =>
      listen(name, () => scheduleRefresh()).catch(() => () => {}),
    ),
  );
  if (timer === null) {
    // Stopped while the listeners were being attached.
    for (const unlisten of attached) safeUnlisten(unlisten)();
    return;
  }
  unlisteners.push(...attached.map((unlisten) => safeUnlisten(unlisten)));
}

function onLinked(): void {
  scheduleRefresh();
}

/**
 * Start (or retarget) the store for these company slugs. Idempotent: calling
 * it again with the same list only refreshes.
 */
function start(companies: string[]): void {
  const next = Array.from(new Set(companies.map((c) => c.trim()).filter(Boolean)));
  const changed = next.length !== watched.length || next.some((c) => !watched.includes(c));
  watched = next;
  watchedCompanies = next;
  const cached = loadCachedLinks();
  const currentByCompany = untrack(() => byCompany);
  const currentSettled = untrack(() => settledCompanies);
  if (Object.keys(cached).length > 0) {
    byCompany = { ...cached, ...currentByCompany };
  }
  const merged = untrack(() => byCompany);
  const alreadyCached = next.filter((company) => (merged[company]?.length ?? 0) > 0 || company in merged);
  if (alreadyCached.length > 0) {
    settledCompanies = [...new Set([...currentSettled, ...alreadyCached])];
  }
  if (changed || timer === null) {
    if (bootTimer !== null) clearTimeout(bootTimer);
    bootTimer = setTimeout(() => {
      const missing = watchedCompanies.filter(company => !settledCompanies.includes(company));
      failedCompanies = [...new Set([...failedCompanies, ...missing])];
      settledCompanies = [...new Set([...settledCompanies, ...missing])];
      for (const company of missing) {
        reportLinksFailure(company, 'boot', new Error('Project session links boot timed out'));
      }
    }, 10000);
  }
  if (timer === null) {
    timer = setInterval(scheduleRefresh, LINKS_REFRESH_MS);
    window.addEventListener(PROJECT_CHANNEL_LINKED_EVENT, onLinked);
    void subscribe();
    scheduleRefresh();
    return;
  }
  if (changed) scheduleRefresh();
}

function stop(): void {
  if (bootTimer !== null) clearTimeout(bootTimer);
  bootTimer = null;
  if (timer !== null) clearInterval(timer);
  timer = null;
  watched = [];
  watchedCompanies = [];
  settledCompanies = [];
  failedCompanies = [];
  reportedFailures.clear();
  generation += 1;
  localRequests.clear();
  remoteRequests.clear();
  revisions.clear();
  sharedRequests.clear();
  visibleSharedChannels.clear();
  remoteQueue = [];
  window.removeEventListener(PROJECT_CHANNEL_LINKED_EVENT, onLinked);
  for (const unlisten of unlisteners.splice(0)) unlisten();
  byCompany = {};
}

export const projectLinksStore = {
  get loading(): boolean { return watchedCompanies.some(company => !settledCompanies.includes(company)); },
  get initialError(): boolean { return failedCompanies.some(company => watchedCompanies.includes(company)); },
  /** Links per company slug — a new object on every change (derive off it). */
  get byCompany(): Record<string, ProjectLink[]> {
    return byCompany;
  },
  linksFor(company: string | null | undefined): ProjectLink[] {
    return (company && byCompany[company]) || [];
  },
  get running(): boolean {
    return timer !== null;
  },
  start,
  stop,
  refresh,
  watchSharedChannel,
};
