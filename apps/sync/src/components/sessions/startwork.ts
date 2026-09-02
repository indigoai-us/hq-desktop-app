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

/** `active` (in flight), `done` (every story passes), `archived` (under `_archive/`). */
export type ProjectStatus = 'active' | 'done' | 'archived';

/** One project row, as `hq_company_projects` returns it (camelCase). */
export interface ProjectEntry {
  name: string;
  description: string;
  branchName: string | null;
  /** Absolute path to the project directory. */
  path: string;
  storyCounts: { total: number; done: number };
  updatedAt: string | null;
  /** An email, a `prs_…` uid or a display name — whatever the PRD says; null when it says nothing. */
  owner: string | null;
  /** Newer of the PRD's mtime and the newest journal entry's, RFC-3339. */
  lastActivityAt: string | null;
  status: ProjectStatus;
}

/** Who is looking — enough to put "Mine" first in the person filter. */
export interface ProjectViewer {
  email: string | null;
  /** The `prs_…` person uid, when the shell knows it. */
  uid?: string | null;
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

/**
 * A NEW session starts on "No project": the remembered pick for `company` is
 * dropped so the fresh draft — and the next mount of the page — reads null.
 * The company itself is kept; only the project resets.
 */
export function forgetLastProject(company: string | null): void {
  rememberLastProject(company, null);
}

// ---------------------------------------------------------------------------
// The project picker's decisions — search, order, person and status filters
// ---------------------------------------------------------------------------

export type ProjectStatusFilter = 'active' | 'all';

export interface ProjectFilter {
  query: string;
  /** An owner string exactly as the rows carry it, or null for everyone. */
  owner: string | null;
  status: ProjectStatusFilter;
}

const lower = (value: string) => value.toLocaleLowerCase('en-US');

/** Most recent activity first; ties fall back to `updatedAt`, then the name. */
export function sortProjectsByActivity(projects: ReadonlyArray<ProjectEntry>): ProjectEntry[] {
  const stamp = (entry: ProjectEntry) => {
    const raw = entry.lastActivityAt ?? entry.updatedAt;
    const at = raw ? Date.parse(raw) : Number.NaN;
    return Number.isNaN(at) ? -1 : at;
  };
  return [...projects].sort(
    (a, b) => stamp(b) - stamp(a) || a.name.localeCompare(b.name, 'en-US'),
  );
}

/** A row matches a query on its name (prefix outranks substring) or description. */
export function projectMatches(entry: Pick<ProjectEntry, 'name' | 'description'>, query: string): boolean {
  const needle = lower(query.trim());
  if (!needle) return true;
  return lower(entry.name).includes(needle) || lower(entry.description).includes(needle);
}

/**
 * The rows the picker shows for a filter, in order: name-prefix hits first,
 * then other name hits, then description hits — each bucket by recency.
 */
export function filterProjects(
  projects: ReadonlyArray<ProjectEntry>,
  filter: ProjectFilter,
): ProjectEntry[] {
  const needle = lower(filter.query.trim());
  const kept = sortProjectsByActivity(projects).filter((entry) => {
    // Older preview fixtures and cached Tauri responses predate `status`.
    // Treat a missing value as active so the migration cannot empty the menu.
    if (filter.status === 'active' && entry.status && entry.status !== 'active') return false;
    if (filter.owner !== null && !sameOwner(entry.owner, filter.owner)) return false;
    return projectMatches(entry, needle);
  });
  if (!needle) return kept;
  const rank = (entry: ProjectEntry) => {
    const name = lower(entry.name);
    if (name.startsWith(needle)) return 0;
    if (name.includes(needle)) return 1;
    return 2;
  };
  return kept
    .map((entry, index) => ({ entry, rank: rank(entry), index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.entry);
}

/** Owners compare case-insensitively — emails and uids both read that way. */
export function sameOwner(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return lower(a.trim()) === lower(b.trim());
}

/** The row's owner is the viewer: by email or by person uid. */
export function isMine(owner: string | null, viewer: ProjectViewer | null): boolean {
  if (!owner || !viewer) return false;
  return sameOwner(owner, viewer.email) || sameOwner(owner, viewer.uid ?? null);
}

/** One person chip: the owner string, its short label, and how many rows it has. */
export interface OwnerChip {
  owner: string;
  label: string;
  count: number;
  mine: boolean;
}

/**
 * Distinct owners across the rows, "Mine" first when the viewer owns any,
 * then by row count, then by label. Rows without an owner make no chip.
 */
export function ownerChips(
  projects: ReadonlyArray<ProjectEntry>,
  viewer: ProjectViewer | null,
): OwnerChip[] {
  const counts = new Map<string, { owner: string; count: number }>();
  for (const entry of projects) {
    const owner = entry.owner?.trim();
    if (!owner) continue;
    const key = lower(owner);
    const found = counts.get(key);
    if (found) found.count += 1;
    else counts.set(key, { owner, count: 1 });
  }
  return [...counts.values()]
    .map(({ owner, count }) => {
      const mine = isMine(owner, viewer);
      return { owner, label: mine ? 'Mine' : ownerLabel(owner), count, mine };
    })
    .sort(
      (a, b) =>
        Number(b.mine) - Number(a.mine) ||
        b.count - a.count ||
        a.label.localeCompare(b.label, 'en-US'),
    );
}

/** A short human label: the mailbox of an email, "Person" for a bare uid, the name otherwise. */
export function ownerLabel(owner: string | null): string {
  const value = owner?.trim() ?? '';
  if (!value) return 'Unowned';
  const at = value.indexOf('@');
  if (at > 0) return lower(value.slice(0, at));
  if (/^prs_[A-Za-z0-9]+$/.test(value)) return `Person ${value.slice(4, 8).toUpperCase()}`;
  return value;
}

/** One or two initials for the avatar: `hassaan@…` → "H", "Hassaan Saleem" → "HS". */
export function ownerInitials(owner: string | null): string {
  const value = owner?.trim() ?? '';
  if (!value) return '·';
  const at = value.indexOf('@');
  if (at > 0) return value.charAt(0).toUpperCase();
  if (/^prs_/.test(value)) return value.charAt(4).toUpperCase() || 'P';
  const words = value.split(/\s+/).filter(Boolean);
  const initials = words.slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join('');
  return initials || value.charAt(0).toUpperCase();
}

/** "just now", "5m ago", "2h ago", "3d ago", "2mo ago", "1y ago" — or "" when unknown. */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

/** 0–100, the share of stories done; 0 when there are none. */
export function storyPercent(entry: Pick<ProjectEntry, 'storyCounts'>): number {
  const { total, done } = entry.storyCounts;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

/** "3/12" — the stories done over the total, for a project row. */
export function storyProgress(entry: Pick<ProjectEntry, 'storyCounts'>): string {
  return `${entry.storyCounts.done}/${entry.storyCounts.total}`;
}
