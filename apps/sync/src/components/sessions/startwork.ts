// Company / project start-work — the pure decisions behind the first send.
//
// The FIRST message of a new in-app session is preceded by an orientation
// turn: `/startwork {company}` (or `/startwork {project}` when the company
// pill's Project submenu picked one). The CLI runs HQ's startwork skill on
// that turn, and the user's own text follows as a second send. This module
// decides what that first turn IS, whether it should be sent at all, and how
// the transcript names it — all as functions of (text, target, preference),
// so the whole contract is testable without a store, a page or Tauri.
//
// Persistence is localStorage under the same defensive reads the other pills
// use (`session-models.ts`): a lost preference must never stop a send.

import { readRemembered, remember } from './session-models';

/** The slash command that orients a session in HQ. */
export const STARTWORK_COMMAND = '/startwork';

/** "Run /startwork on first message" — `'off'` is the only opt-out value. */
export const STARTWORK_ENABLED_KEY = 'hq.sessions.startworkOnFirstMessage';

/** `hq.sessions.lastProject.<slug>` — the remembered project per company. */
export const LAST_PROJECT_KEY_PREFIX = 'hq.sessions.lastProject.';

/** One project row, as `hq_company_projects` returns it (camelCase). */
export interface ProjectEntry {
  name: string;
  description: string;
  branchName: string | null;
  /** Absolute path to the project directory. */
  path: string;
  storyCounts: { total: number; done: number };
  updatedAt: string | null;
}

/** What the first turn should orient on. */
export interface StartworkTarget {
  company: string | null;
  /** A project NAME (the startwork skill resolves it), or null for company mode. */
  project: string | null;
}

/** One send the page will make, in order. */
export interface PlannedTurn {
  text: string;
  /** Rendered as a quiet system divider rather than a bubble. */
  hidden: boolean;
  /** The divider's wording, when hidden. */
  label?: string;
}

export function lastProjectKey(company: string): string {
  return `${LAST_PROJECT_KEY_PREFIX}${company}`;
}

/**
 * The orientation command for a target: the project wins over the company
 * because the skill resolves a project name to its company on its own. No
 * company and no project → nothing to orient on, so no command.
 */
export function startworkCommand(target: StartworkTarget): string | null {
  const project = target.project?.trim();
  if (project) return `${STARTWORK_COMMAND} ${project}`;
  const company = target.company?.trim();
  if (company) return `${STARTWORK_COMMAND} ${company}`;
  return null;
}

/** The operator's text IS a `/startwork` turn (optionally with arguments). */
export function isStartworkTurn(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(STARTWORK_COMMAND)) return false;
  const next = trimmed.charAt(STARTWORK_COMMAND.length);
  return next === '' || /\s/.test(next);
}

/** The system line the transcript shows instead of a raw `/startwork` bubble. */
export function startworkLabel(target: StartworkTarget): string {
  const company = target.company?.trim() ?? '';
  const project = target.project?.trim() ?? '';
  if (company && project) return `Starting work in ${company} · project ${project}`;
  if (project) return `Starting work · project ${project}`;
  if (company) return `Starting work in ${company}`;
  return 'Starting work';
}

/**
 * The best label a bare `/startwork …` text can yield — used for a turn the
 * backend recorded once the mirror (which carried the exact label) is gone.
 */
export function startworkLabelFromText(text: string): string {
  const argument = text.trimStart().slice(STARTWORK_COMMAND.length).trim();
  return argument ? `Starting work in ${argument}` : 'Starting work';
}

/**
 * The sends a FIRST message expands into: the orientation turn (hidden) and
 * then the user's text — or just the text when the toggle is off, there is
 * nothing to orient on, or the user already typed `/startwork` themselves
 * (never double-send the orientation).
 */
export function planFirstSend(
  text: string,
  target: StartworkTarget,
  enabled: boolean,
): PlannedTurn[] {
  const user: PlannedTurn = { text, hidden: false };
  if (!enabled) return [user];
  if (isStartworkTurn(text)) return [user];
  const command = startworkCommand(target);
  if (!command) return [user];
  return [{ text: command, hidden: true, label: startworkLabel(target) }, user];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Default ON; only an explicit `'off'` disables it. */
export function readStartworkEnabled(): boolean {
  return readRemembered(STARTWORK_ENABLED_KEY) !== 'off';
}

export function rememberStartworkEnabled(enabled: boolean): void {
  remember(STARTWORK_ENABLED_KEY, enabled ? null : 'off');
}

export function readLastProject(company: string | null): string | null {
  if (!company) return null;
  return readRemembered(lastProjectKey(company));
}

export function rememberLastProject(company: string | null, project: string | null): void {
  if (!company) return;
  remember(lastProjectKey(company), project);
}

/** "3/12" — the stories done over the total, for a project row. */
export function storyProgress(entry: Pick<ProjectEntry, 'storyCounts'>): string {
  return `${entry.storyCounts.done}/${entry.storyCounts.total}`;
}
