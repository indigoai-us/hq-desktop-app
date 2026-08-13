import { invoke } from '@tauri-apps/api/core';
import type { AgencyTeam, AgencyQuestion, AgencyMessage } from './agency';
import { createGatedPoller } from './visibility-poller';

// ---------------------------------------------------------------------------
// Agency store (Mission Control). Module-level runes singleton — the same shape
// as sessions-store. There is no backend poll event for the agency surface, so
// this drives a light JS interval refresh (the data is just on-disk chat files).
// Consumers read the reactive getters inside their own $derived/template.
// ---------------------------------------------------------------------------

let teams = $state<AgencyTeam[]>([]);
let questions = $state<AgencyQuestion[]>([]);
let messages = $state<AgencyMessage[]>([]);
// The team whose Manager ⇄ Liaison conversation is shown + posted to.
let selected = $state<{ company: string; team: string } | null>(null);
let loading = $state(true);
let error = $state('');

/**
 * Perf: was a 4s app-lifetime interval issuing 3 Tauri invokes forever — the
 * worst CPU offender in the desktop window. Now 30s, refcounted to mounted
 * agency surfaces, and skipped entirely while the document is hidden
 * (visibility-poller). The data is on-disk chat files; 30s is plenty.
 */
export const AGENCY_REFRESH_MS = 30_000;

const poller = createGatedPoller({
  intervalMs: AGENCY_REFRESH_MS,
  tick: () => void refresh(),
});

/** Legacy lifetime lease held by startAgencyStore/stopAgencyStore. */
let lifetimeRelease: (() => void) | null = null;

/** Keep `selected` pointing at a team that still exists (default: the first). */
function reconcileSelection(): void {
  const ok = selected && teams.some((t) => t.company === selected!.company && t.team === selected!.team);
  if (!ok) selected = teams.length ? { company: teams[0].company, team: teams[0].team } : null;
}

async function refresh(): Promise<void> {
  try {
    const [t, q] = await Promise.all([
      invoke<AgencyTeam[]>('list_agency_teams'),
      invoke<AgencyQuestion[]>('list_agency_questions'),
    ]);
    teams = t ?? [];
    questions = q ?? [];
    reconcileSelection();
    messages = selected
      ? (await invoke<AgencyMessage[]>('list_agency_chat', {
          company: selected.company,
          team: selected.team,
        })) ?? []
      : [];
    error = '';
    loading = false;
  } catch (err) {
    console.error('agency refresh failed:', err);
    error = 'Could not load agency teams.';
    loading = false;
  }
}

/**
 * Acquire a polling lease for a mounted agency surface. The refresh interval
 * only runs while at least one lease is held; call the returned release in
 * onDestroy. Ticks are skipped while the document is hidden.
 */
export function acquireAgencyStore(): () => void {
  return poller.acquire();
}

/** Idempotent lifetime lease — kept for callers without a mount lifecycle. */
export function startAgencyStore(): void {
  if (lifetimeRelease) return;
  lifetimeRelease = poller.acquire();
}

export function stopAgencyStore(): void {
  lifetimeRelease?.();
  lifetimeRelease = null;
}

/** True while the refresh interval is scheduled (test hook). */
export function agencyPollerRunning(): boolean {
  return poller.isRunning();
}

/** Answer a question — writes back to the manager inbox, then refreshes so the
 *  answered card disappears. Returns `'delivered'` | `'already-answered'`. */
export async function submitAnswer(q: AgencyQuestion, answer: string): Promise<string> {
  const res = await invoke<string>('answer_agency_question', {
    company: q.company,
    team: q.team,
    id: q.id,
    answer,
  });
  await refresh();
  return res;
}

/** Switch which team's conversation is shown; refreshes immediately. */
export function selectAgencyTeam(company: string, team: string): void {
  selected = { company, team };
  void refresh();
}

/** Post an operator message into the selected team's manager inbox, then refresh. */
export async function sendAgencyMessage(text: string): Promise<string> {
  if (!selected) return 'no-team';
  const res = await invoke<string>('send_agency_message', {
    company: selected.company,
    team: selected.team,
    text,
  });
  await refresh();
  return res;
}

export const agencyStore = {
  get teams() {
    return teams;
  },
  get questions() {
    return questions;
  },
  get messages() {
    return messages;
  },
  get selected() {
    return selected;
  },
  get loading() {
    return loading;
  },
  get error() {
    return error;
  },
};
