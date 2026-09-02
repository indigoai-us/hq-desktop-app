// The host's copy of `session_project_links`, per company.
//
// One store, because three surfaces read the same join: the sidebar's row
// decoration (badge, hover card), the Sessions strip's project pill, and the
// project-created card's "does this project already have a channel?" check.
// Refreshed on every session phase edge, on every project-created notice,
// after a channel is linked, and every 30 s while running. Each load is
// best-effort: a company that fails keeps its last known links.

import { listen } from '@tauri-apps/api/event';

import { safeUnlisten } from '../../lib/listener-registry';
import {
  loadSessionProjectLinks,
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

async function refresh(): Promise<void> {
  const mine = ++generation;
  const companies = watched.slice();
  await Promise.all(
    companies.map(async (company) => {
      try {
        const links = await loadSessionProjectLinks(company);
        if (mine !== generation && !watched.includes(company)) return;
        byCompany = { ...byCompany, [company]: links };
      } catch {
        // Keep the last known links: the flag may be off, or hq-pro away.
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
};
