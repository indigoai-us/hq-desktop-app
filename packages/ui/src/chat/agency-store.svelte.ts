import type { AgencyTeam, AgencyQuestion, AgencyMessage } from "./agency";

// ---------------------------------------------------------------------------
// Agency store (Mission Control). Module-level runes singleton — the same shape
// as the desktop-alt sessions-store. There is no backend poll event for the
// agency surface, so this drives a light JS interval refresh.
// Consumers read the reactive getters inside their own $derived/template.
//
// US-007 port: the Tauri invoke calls are replaced by an injected
// AgencyApi (configureAgencyApi) so packages/ui stays platform-pure.
// ---------------------------------------------------------------------------

/** Backend seam replacing the desktop `…_agency_…` commands. */
export interface AgencyApi {
  listTeams(): Promise<AgencyTeam[]>;
  listQuestions(): Promise<AgencyQuestion[]>;
  listChat(company: string, team: string): Promise<AgencyMessage[]>;
  answerQuestion(args: {
    company: string;
    team: string;
    id: string;
    answer: string;
  }): Promise<string>;
  sendMessage(args: {
    company: string;
    team: string;
    text: string;
  }): Promise<string>;
}

let api: AgencyApi | null = null;

/** Inject the platform backend before startAgencyStore(). */
export function configureAgencyApi(next: AgencyApi | null): void {
  api = next;
}

let teams = $state<AgencyTeam[]>([]);
let questions = $state<AgencyQuestion[]>([]);
let messages = $state<AgencyMessage[]>([]);
// The team whose Manager ⇄ Liaison conversation is shown + posted to.
let selected = $state<{ company: string; team: string } | null>(null);
let loading = $state(true);
let error = $state("");

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

const REFRESH_MS = 4000;

/** Keep `selected` pointing at a team that still exists (default: the first). */
function reconcileSelection(): void {
  const ok =
    selected &&
    teams.some(
      (t) => t.company === selected!.company && t.team === selected!.team,
    );
  if (!ok)
    selected = teams.length
      ? { company: teams[0].company, team: teams[0].team }
      : null;
}

async function refresh(): Promise<void> {
  if (!api) {
    loading = false;
    error = "Mission Control is not available on this platform yet.";
    return;
  }
  try {
    const [t, q] = await Promise.all([api.listTeams(), api.listQuestions()]);
    teams = t ?? [];
    questions = q ?? [];
    reconcileSelection();
    messages = selected
      ? ((await api.listChat(selected.company, selected.team)) ?? [])
      : [];
    error = "";
    loading = false;
  } catch (err) {
    console.error("agency refresh failed:", err);
    error = "Could not load agency teams.";
    loading = false;
  }
}

/** Idempotent lifetime singleton — starts the interval refresh. */
export function startAgencyStore(): void {
  if (started) return;
  started = true;
  void refresh();
  timer = setInterval(() => void refresh(), REFRESH_MS);
}

export function stopAgencyStore(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

/** Answer a question — writes back to the manager inbox, then refreshes so the
 *  answered card disappears. Returns `'delivered'` | `'already-answered'`. */
export async function submitAnswer(
  q: AgencyQuestion,
  answer: string,
): Promise<string> {
  if (!api) return "no-api";
  const res = await api.answerQuestion({
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
  if (!selected) return "no-team";
  if (!api) return "no-api";
  const res = await api.sendMessage({
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
