// The host's copy of `session_project_links`, per company.
//
// One store, because three surfaces read the same join: the sidebar's row
// decoration (badge, hover card), the Sessions strip's project pill, and the
// project-created card's "does this project already have a channel?" check.
// Refreshed on every session phase edge, on every project-created notice,
// after a channel is linked, and every 30 s while running. Local bindings
// render first; bounded background requests enrich channel labels. A failed
// cloud lookup never gates first paint or removes saved local sessions.

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

let byCompany = $state<Record<string, ProjectLink[]>>({});
let watched: string[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let unlisteners: Array<() => void> = [];
let generation = 0;
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
        byCompany = { ...byCompany, [company]: (byCompany[company] ?? []).map(row => row.channelId !== channelId ? row : {
          ...row, sessions: [...row.sessions.filter(session => !session.sharedChannelId), ...sessions],
        }) };
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
      const links = await loadSessionProjectLinks(company);
      if (mine !== generation || !watched.includes(company)) return;
      const current = byCompany[company] ?? [];
      // An intervening phase refresh owns membership/status. A slow network
      // response can enrich labels but cannot roll that newer state back.
      byCompany = { ...byCompany, [company]: revision === revisions.get(company) ? [
        ...links.map(link => ({ ...link, sessions: [...link.sessions,
          ...(current.find(row => row.channelId === link.channelId)?.sessions.filter(session => session.sharedChannelId) ?? []),
        ] })),
        ...current.filter((link) => !links.some((row) => row.project === link.project)),
      ] : [
        ...mergeLocalProjectLinks(current, links),
      ] };
      refreshShared(company, byCompany[company], mine);
    } catch {
      // Local links remain usable offline.
    } finally {
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
        const links = await loadSessionProjectLinks(company, true);
        if (mine !== generation || !watched.includes(company)) return;
        revisions.set(company, (revisions.get(company) ?? 0) + 1);
        const previous = byCompany[company] ?? [];
        byCompany = { ...byCompany, [company]: mergeLocalProjectLinks(links, previous) };
      } catch {
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
  if (timer !== null) clearInterval(timer);
  timer = null;
  watched = [];
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
