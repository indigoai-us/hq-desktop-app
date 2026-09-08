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

const REFRESH_MS = 15000;

// Per-field fingerprints of the last applied payloads. Reassigning `teams` /
// `questions` / `messages` mints a new array identity that invalidates every
// derived and re-renders every mounted panel; doing that on every poll even
// when nothing changed was a periodic main-thread stall. We only write the
// reactive field whose serialized value actually changed (same pattern as
// sessions-store, but per field so a new chat message does not also re-render
// the teams list).
let teamsKey = "";
let questionsKey = "";
let messagesKey = "";

function fingerprint(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    // Non-serializable payload: force a write rather than silently dropping.
    return `\u0000${Math.random()}`;
  }
}

/** Pause the interval while the document is hidden (background window/tab);
 *  resume with an immediate refresh once it becomes visible again. */
function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function onVisibilityChange(): void {
  if (!started) return;
  if (isHidden()) {
    stopTimer();
    return;
  }
  void refresh();
  startTimer();
}

function startTimer(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (isHidden()) return;
    void refresh();
  }, REFRESH_MS);
}

function stopTimer(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

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

/**
 * Monotonic request generation. Every `refresh()` claims the next value; any
 * response that comes back after a newer refresh has started (a team switch, or
 * simply the next poll) is discarded instead of writing the WRONG team's
 * messages into the panel. The poll interval is 15s, so a slow backend has a
 * wide window in which to land stale.
 */
let refreshGeneration = 0;

async function refresh(): Promise<void> {
  if (!api) {
    loading = false;
    error = "Mission Control is not available on this platform yet.";
    return;
  }
  const generation = ++refreshGeneration;
  const stale = () => generation !== refreshGeneration;
  try {
    const [t, q] = await Promise.all([api.listTeams(), api.listQuestions()]);
    if (stale()) return;
    const nextTeams = t ?? [];
    const nextTeamsKey = fingerprint(nextTeams);
    if (nextTeamsKey !== teamsKey) {
      teamsKey = nextTeamsKey;
      teams = nextTeams;
    }
    const nextQuestions = q ?? [];
    const nextQuestionsKey = fingerprint(nextQuestions);
    if (nextQuestionsKey !== questionsKey) {
      questionsKey = nextQuestionsKey;
      questions = nextQuestions;
    }
    reconcileSelection();
    // Capture the team this response belongs to: `selected` can change while
    // the request is in flight.
    const target = selected ? { ...selected } : null;
    const nextMessages = target
      ? ((await api.listChat(target.company, target.team)) ?? [])
      : [];
    if (
      stale() ||
      target?.company !== selected?.company ||
      target?.team !== selected?.team
    ) {
      return;
    }
    const nextMessagesKey = fingerprint(nextMessages);
    if (nextMessagesKey !== messagesKey) {
      messagesKey = nextMessagesKey;
      messages = nextMessages;
    }
    if (error !== "") error = "";
    if (loading) loading = false;
  } catch (err) {
    if (stale()) return;
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
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  if (!isHidden()) startTimer();
}

export function stopAgencyStore(): void {
  stopTimer();
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }
  started = false;
  // Invalidate any refresh still in flight so it cannot write after stop.
  refreshGeneration += 1;
  teamsKey = "";
  questionsKey = "";
  messagesKey = "";
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
