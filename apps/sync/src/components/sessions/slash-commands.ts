// Composer slash-command autocomplete — pure helpers.
//
// The composer merges TWO sources of commands: the `agent_session_slash_commands`
// probe (rich: description + argument hint, fetched once per page) and the
// `started` event's own catalog (whatever THIS session's CLI announced). They
// overlap heavily, so they are merged by name with the richer entry winning,
// and the result is filtered by whatever the user has typed after the '/'.
//
// PURE: no runes, no Tauri, no DOM — the whole autocomplete decision is a
// function of (draft, catalog), which is what makes it directly testable in
// the node-environment suite.

import type { SessionCommand } from './session-events';

/** A draft that is asking for command completion, and the prefix to match on. */
export interface SlashQuery {
  /** The text after the leading '/', lowercased. */
  prefix: string;
}

/**
 * Read a composer draft as a slash query.
 *
 * A draft completes commands only while it is still ONE `/name` token: the
 * moment a space is typed the user is writing arguments, and popping a list
 * over their arguments would be noise. Leading whitespace is tolerated;
 * anything else (including an empty draft) is not a query.
 */
export function slashQueryFor(draft: string): SlashQuery | null {
  const trimmed = draft.trimStart();
  if (!trimmed.startsWith('/')) return null;
  const token = trimmed.slice(1);
  if (/\s/.test(token)) return null;
  return { prefix: token.toLocaleLowerCase('en-US') };
}

/**
 * Merge two command catalogs by name. `primary` wins on collision — it is the
 * richer probe result — but a name only the session announced is still kept,
 * so a session-local command never disappears from the list.
 */
export function mergeSlashCommands(
  primary: ReadonlyArray<SessionCommand>,
  secondary: ReadonlyArray<SessionCommand>,
): SessionCommand[] {
  const byName = new Map<string, SessionCommand>();
  for (const command of secondary) byName.set(command.name, command);
  for (const command of primary) byName.set(command.name, command);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'en-US'));
}

/**
 * The commands to offer for `draft`, best match first.
 *
 * Returns `[]` for a draft that is not a slash query at all, so the caller's
 * "is the popup open?" test is simply "did this return anything?". Ranking:
 * a name that STARTS WITH the typed prefix outranks one that merely contains
 * it, and ties keep the merged catalog's (alphabetical) order.
 */
export function filterSlashCommands(
  draft: string,
  commands: ReadonlyArray<SessionCommand>,
  limit = 8,
): SessionCommand[] {
  const query = slashQueryFor(draft);
  if (!query) return [];
  const { prefix } = query;
  if (prefix.length === 0) return commands.slice(0, limit);

  const starts: SessionCommand[] = [];
  const contains: SessionCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLocaleLowerCase('en-US');
    if (name.startsWith(prefix)) starts.push(command);
    else if (name.includes(prefix)) contains.push(command);
  }
  return [...starts, ...contains].slice(0, limit);
}

/**
 * Apply a picked command to the draft: the whole `/name ` token is replaced,
 * with a trailing space so the user types arguments straight away. Any leading
 * whitespace the draft carried is preserved.
 */
export function applySlashCommand(draft: string, command: SessionCommand): string {
  const leading = draft.slice(0, draft.length - draft.trimStart().length);
  return `${leading}/${command.name} `;
}

// ---------------------------------------------------------------------------
// The discovery picker — HQ workers + skills + the CLI's own commands
// ---------------------------------------------------------------------------
//
// `SlashPicker.svelte` paints rows; everything that decides WHICH rows, in
// what group, in what order, and what a pick inserts lives here so it can be
// asserted without a DOM. The catalog shapes mirror `hq_skill_catalog`.

/** One skill a worker exposes (`WorkerSkill` on the Rust side). */
export interface WorkerSkill {
  name: string;
  description: string;
  tags: string[];
  /** The literal `/run {worker} {skill}` form. */
  invoke: string;
}

export interface WorkerEntry {
  id: string;
  name: string;
  description: string;
  company: string | null;
  skills: WorkerSkill[];
}

export interface SkillEntry {
  name: string;
  description: string;
  /** `core` | `personal` | `company:<slug>` | `package`. */
  scope: string;
  tags: string[];
  /** The real slash form, e.g. `/handoff`, `/indigo:capture`. */
  invoke: string;
}

export interface SkillCatalog {
  workers: WorkerEntry[];
  skills: SkillEntry[];
}

export type PickerGroup = 'recent' | 'workers' | 'skills' | 'cli';

/**
 * What a row IS, for the kind pill and the chip a pick leaves in the composer:
 * a worker (drill in), one of a worker's skills (`/run w s`), an HQ skill, or
 * a command the CLI itself announced.
 */
export type PickerKind = 'worker' | 'worker-skill' | 'skill' | 'cli';

/** One row the picker can show. `insert === ''` means "drill in" (a worker). */
export interface PickerRow {
  id: string;
  /** Mono label — the invocation for a skill, the worker's name for a worker. */
  name: string;
  description: string;
  /** What lands in the draft (with its trailing space), or '' to drill in. */
  insert: string;
  group: PickerGroup;
  tags: string[];
  /** Skills only. */
  scope?: string;
  /** Worker rows: the worker to drill into. */
  workerId?: string;
}

/** Rows shown per group before the "more…" affordance. */
export const PICKER_PAGE = 8;

/** The kind a row renders as — see [`PickerKind`]. Recent rows infer theirs. */
export function rowKind(row: Pick<PickerRow, 'group' | 'insert' | 'workerId'> & { kind?: PickerKind }): PickerKind {
  if (row.kind) return row.kind;
  if (row.group === 'workers') return row.insert === '' && row.workerId ? 'worker' : 'worker-skill';
  if (row.group === 'skills') return 'skill';
  if (row.group === 'cli') return 'cli';
  return kindFromInsert(row.insert);
}

/** Best guess for a remembered pick that predates the kind field. */
export function kindFromInsert(insert: string): PickerKind {
  return /^\s*\/run\s+\S+\s+\S+/.test(insert) ? 'worker-skill' : 'skill';
}

export function kindLabel(kind: PickerKind): string {
  switch (kind) {
    case 'worker':
      return 'worker';
    case 'worker-skill':
      return 'worker skill';
    case 'skill':
      return 'skill';
    case 'cli':
      return 'command';
  }
}

/**
 * The chip text a pick leaves above the draft: `design · mockup` for a worker
 * skill, the bare invocation otherwise. The DRAFT keeps the exact command —
 * the chip only names it.
 */
export function chipLabel(insert: string, kind: PickerKind): string {
  const token = insert.trim();
  if (kind === 'worker-skill') {
    const match = /^\/run\s+(\S+)\s+(\S+)/.exec(token);
    if (match) return `${match[1]} · ${match[2]}`;
  }
  return token;
}

/** The scope chips the Skills filter row offers, before the tag union. */
export type ScopeFilter = 'company' | 'personal' | 'core' | 'package';

export const SCOPE_FILTERS: ReadonlyArray<{ id: ScopeFilter; label: string }> = [
  { id: 'company', label: 'Company' },
  { id: 'personal', label: 'Personal' },
  { id: 'core', label: 'Core' },
  { id: 'package', label: 'Packages' },
];

/** A skill row belongs to a scope chip. `company` means ANY company scope. */
export function scopeFilterMatches(row: Pick<PickerRow, 'scope'>, filter: ScopeFilter | null): boolean {
  if (!filter) return true;
  const scope = row.scope ?? 'core';
  if (filter === 'company') return scope.startsWith('company:');
  return scope === filter;
}

const lowerCase = (value: string) => value.toLocaleLowerCase('en-US');

/** Company (the selected one first), then Personal, Core, Packages. */
export function scopeRank(scope: string, company: string | null): number {
  if (scope.startsWith('company:')) {
    return company && scope === `company:${company}` ? 0 : 1;
  }
  if (scope === 'personal') return 2;
  if (scope === 'core') return 3;
  return 4;
}

export function scopeLabel(scope: string): string {
  if (scope.startsWith('company:')) return scope.slice('company:'.length);
  if (scope === 'personal') return 'Personal';
  if (scope === 'core') return 'Core';
  if (scope === 'package') return 'Packages';
  return scope;
}

/** Every HQ skill as a row, ordered by scope then name. */
export function skillRows(catalog: SkillCatalog | null, company: string | null): PickerRow[] {
  if (!catalog) return [];
  return [...catalog.skills]
    .sort(
      (a, b) =>
        scopeRank(a.scope, company) - scopeRank(b.scope, company) ||
        a.invoke.localeCompare(b.invoke, 'en-US'),
    )
    .map((skill) => ({
      id: `skill:${skill.invoke}`,
      name: skill.invoke,
      description: skill.description,
      insert: `${skill.invoke} `,
      group: 'skills',
      tags: skill.tags,
      scope: skill.scope,
    }));
}

/** Every worker as a drill-in row. */
export function workerRows(catalog: SkillCatalog | null): PickerRow[] {
  if (!catalog) return [];
  return [...catalog.workers]
    .sort((a, b) => a.name.localeCompare(b.name, 'en-US'))
    .map((worker) => ({
      id: `worker:${worker.id}`,
      name: worker.name || worker.id,
      description: worker.description,
      insert: '',
      group: 'workers',
      tags: worker.skills.flatMap((skill) => skill.tags),
      workerId: worker.id,
    }));
}

/** A worker's skills, each inserting its `/run {worker} {skill}` form. */
export function workerSkillRows(worker: WorkerEntry): PickerRow[] {
  return worker.skills.map((skill) => ({
    id: `worker:${worker.id}:${skill.name}`,
    name: skill.invoke || `/run ${worker.id} ${skill.name}`,
    description: skill.description,
    insert: `${skill.invoke || `/run ${worker.id} ${skill.name}`} `,
    group: 'workers',
    tags: skill.tags,
    workerId: worker.id,
  }));
}

/**
 * The CLI's own commands, minus anything the HQ catalog already names — the
 * HQ row carries the description and tags, so it wins the slot.
 */
export function cliRows(
  commands: ReadonlyArray<SessionCommand>,
  catalog: SkillCatalog | null,
): PickerRow[] {
  const covered = new Set((catalog?.skills ?? []).map((skill) => lowerCase(skill.invoke)));
  return commands
    .filter((command) => !covered.has(`/${lowerCase(command.name)}`))
    .map((command) => ({
      id: `cli:${command.name}`,
      name: `/${command.name}`,
      description: command.argumentHint
        ? `${command.description} ${command.argumentHint}`.trim()
        : command.description,
      insert: `/${command.name} `,
      group: 'cli',
      tags: [],
    }));
}

/** Name, description or a tag contains the query (case-insensitive). */
export function rowMatches(row: PickerRow, query: string): boolean {
  const needle = lowerCase(query.trim());
  if (!needle) return true;
  if (lowerCase(row.name).includes(needle)) return true;
  if (lowerCase(row.description).includes(needle)) return true;
  return row.tags.some((tag) => lowerCase(tag).includes(needle));
}

/**
 * Filter and rank: a name that STARTS with the query (with or without its
 * leading slash) outranks a name that contains it, which outranks a hit on
 * the description or a tag. Ties keep the incoming order.
 */
export function filterRows(rows: ReadonlyArray<PickerRow>, query: string): PickerRow[] {
  const needle = lowerCase(query.trim());
  if (!needle) return [...rows];
  const ranked: Array<{ row: PickerRow; rank: number; index: number }> = [];
  rows.forEach((row, index) => {
    const name = lowerCase(row.name);
    const bare = name.startsWith('/') ? name.slice(1) : name;
    let rank: number | null = null;
    if (bare.startsWith(needle) || name.startsWith(needle)) rank = 0;
    else if (name.includes(needle)) rank = 1;
    else if (rowMatches(row, needle)) rank = 2;
    if (rank !== null) ranked.push({ row, rank, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.map((entry) => entry.row);
}

/** The union of tags across rows, most common first, capped. */
export function tagUnion(rows: ReadonlyArray<PickerRow>, limit = 24): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const tag of row.tags) {
      const key = tag.trim();
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en-US'))
    .slice(0, limit)
    .map(([tag]) => tag);
}

/** Group skill rows by scope, in scope order. */
export function groupByScope(
  rows: ReadonlyArray<PickerRow>,
  company: string | null,
): Array<{ scope: string; label: string; rows: PickerRow[] }> {
  const groups = new Map<string, PickerRow[]>();
  for (const row of rows) {
    const scope = row.scope ?? 'core';
    const list = groups.get(scope) ?? [];
    list.push(row);
    groups.set(scope, list);
  }
  return [...groups.entries()]
    .sort((a, b) => scopeRank(a[0], company) - scopeRank(b[0], company) || a[0].localeCompare(b[0]))
    .map(([scope, list]) => ({ scope, label: scopeLabel(scope), rows: list }));
}

// --- Recent ------------------------------------------------------------------

export const RECENT_SLASH_KEY = 'hq.sessions.recentSlash';
export const RECENT_SLASH_LIMIT = 8;

/** A remembered pick — enough to re-render the row without the catalog. */
export interface RecentSlash {
  name: string;
  description: string;
  insert: string;
  /** Absent on picks remembered before the kind pill existed. */
  kind?: PickerKind;
}

const KINDS: ReadonlyArray<PickerKind> = ['worker', 'worker-skill', 'skill', 'cli'];

export function readRecentSlash(): RecentSlash[] {
  try {
    const raw = globalThis.localStorage?.getItem(RECENT_SLASH_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is RecentSlash =>
          Boolean(entry) &&
          typeof (entry as RecentSlash).insert === 'string' &&
          typeof (entry as RecentSlash).name === 'string',
      )
      .map((entry) => ({
        name: entry.name,
        description: typeof entry.description === 'string' ? entry.description : '',
        insert: entry.insert,
        kind: KINDS.includes(entry.kind as PickerKind) ? entry.kind : kindFromInsert(entry.insert),
      }))
      .slice(0, RECENT_SLASH_LIMIT);
  } catch {
    return [];
  }
}

/** Most recent first, deduped by what it inserts, capped at eight. */
export function pushRecentSlash(
  recent: ReadonlyArray<RecentSlash>,
  pick: RecentSlash,
): RecentSlash[] {
  const rest = recent.filter((entry) => entry.insert !== pick.insert);
  return [pick, ...rest].slice(0, RECENT_SLASH_LIMIT);
}

export function rememberRecentSlash(recent: ReadonlyArray<RecentSlash>): void {
  try {
    globalThis.localStorage?.setItem(RECENT_SLASH_KEY, JSON.stringify(recent));
  } catch {
    // A lost history is not worth failing a pick over.
  }
}

export function recentRows(recent: ReadonlyArray<RecentSlash>): Array<PickerRow & { kind: PickerKind }> {
  return recent.map((entry) => ({
    id: `recent:${entry.insert}`,
    name: entry.name,
    description: entry.description,
    insert: entry.insert,
    group: 'recent',
    tags: [],
    kind: entry.kind ?? kindFromInsert(entry.insert),
  }));
}

/** Apply a picked row to the draft, keeping any leading whitespace. */
export function applyPickerRow(draft: string, row: Pick<PickerRow, 'insert'>): string {
  const leading = draft.slice(0, draft.length - draft.trimStart().length);
  return `${leading}${row.insert}`;
}
