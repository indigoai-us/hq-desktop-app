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

/** The slash token currently being edited at the caret. */
export interface SlashQueryRange extends SlashQuery {
  /** Index of the leading slash. */
  start: number;
  /** Caret position, immediately after the typed prefix. */
  end: number;
}

const WHITESPACE = /\s/;

/**
 * Read the `/token` at the caret, anywhere in a draft.
 *
 * Like mentions, a slash starts a picker only at a word boundary. This keeps
 * URLs and prose such as `and/or` from opening it while allowing `make this /`
 * and a slash after a newline.
 */
export function slashQueryAt(draft: string, caret: number): SlashQueryRange | null {
  const end = Math.max(0, Math.min(caret, draft.length));
  let start = -1;
  for (let index = end - 1; index >= 0; index -= 1) {
    const character = draft.charAt(index);
    if (WHITESPACE.test(character)) return null;
    if (character === '/') {
      start = index;
      break;
    }
  }
  if (start === -1) return null;
  if (start > 0 && !WHITESPACE.test(draft.charAt(start - 1))) return null;
  return {
    start,
    end,
    prefix: draft.slice(start + 1, end).toLocaleLowerCase('en-US'),
  };
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
  const query = slashQueryAt(draft, draft.length);
  return query ? { prefix: query.prefix } : null;
}

/** Replace the active slash query while preserving all surrounding prose. */
export function replaceSlashQuery(
  draft: string,
  range: Pick<SlashQueryRange, 'start' | 'end'>,
  replacement: string,
): { draft: string; caret: number } {
  const head = draft.slice(0, range.start);
  let tail = draft.slice(range.end);
  if (replacement.length === 0) {
    if (head.length === 0) tail = tail.replace(/^[\t ]/, '');
    else if (/[\t ]$/.test(head)) tail = tail.replace(/^[\t ]/, '');
  }
  const nextHead = head + replacement;
  return { draft: nextHead + tail, caret: nextHead.length };
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
  searchTerms?: string[];
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
  searchTerms?: string[];
  /** Console taxonomy for an installed company skill; absent while offline. */
  cloudTags?: string[];
  /** The real slash form, e.g. `/handoff`, `/indigo:capture`. */
  invoke: string;
  skillUid?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  companyWide?: boolean;
}

export interface SkillCatalog {
  workers: WorkerEntry[];
  skills: SkillEntry[];
}

export interface SkillMetadata {
  skillUid: string;
  tags: string[];
  groupId: string | null;
  groupName: string | null;
  companyWide: boolean;
}

/** Enrich matching installed skills while preserving every local-only entry. */
export function mergeSkillMetadata(
  catalog: SkillCatalog,
  metadata: ReadonlyArray<SkillMetadata>,
): SkillCatalog {
  const byUid = new Map(metadata.map((entry) => [entry.skillUid, entry]));
  return {
    ...catalog,
    skills: catalog.skills.map((skill) => {
      const cloud = skill.skillUid ? byUid.get(skill.skillUid) : undefined;
      if (!cloud) return skill;
      return {
        ...skill,
        cloudTags: [...new Set(cloud.tags)],
        groupId: cloud.groupId,
        groupName: cloud.groupName,
        companyWide: cloud.companyWide,
      };
    }),
  };
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
  searchTerms?: string[];
  cloudTags?: string[];
  /** Skills only. */
  scope?: string;
  /** Worker rows: the worker to drill into. */
  workerId?: string;
  skillUid?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  companyWide?: boolean;
  route?: ComposerRoute;
}

export type ComposerRoute =
  | { kind: 'skill'; invoke: string; label: string }
  | { kind: 'worker'; workerId: string; label: string };

export type GroupFilter = 'company-wide' | string | null;

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
      searchTerms: skill.searchTerms,
      cloudTags: skill.cloudTags,
      scope: skill.scope,
      skillUid: skill.skillUid,
      groupId: skill.groupId,
      groupName: skill.groupName,
      companyWide: skill.companyWide,
      route: { kind: 'skill', invoke: skill.invoke, label: skill.name || skill.invoke },
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
      searchTerms: worker.skills.flatMap((skill) => skill.searchTerms ?? []),
      workerId: worker.id,
      route: { kind: 'worker', workerId: worker.id, label: worker.name || worker.id },
    }));
}

export function groupOptions(rows: ReadonlyArray<PickerRow>): Array<{ id: string; name: string }> {
  const groups = new Map<string, string>();
  for (const row of rows) {
    if (row.groupId && row.groupName) groups.set(row.groupId, row.groupName);
  }
  return [...groups.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en-US'));
}

/** Group and tag filters combine with AND semantics, matching HQ Console. */
export function filterSkillRows(
  rows: ReadonlyArray<PickerRow>,
  query: string,
  group: GroupFilter,
  tag: string | null,
  useCloudTaxonomy = false,
): PickerRow[] {
  return filterRows(rows, query).filter((row) => {
    const groupMatch =
      group === null
        ? true
        : group === 'company-wide'
          ? row.companyWide === true
          : row.groupId === group;
    const tags = useCloudTaxonomy ? (row.cloudTags ?? []) : row.tags;
    return groupMatch && (tag === null || tags.includes(tag));
  });
}

/** Turn the route pill and natural-language draft into the exact CLI text. */
export function serializeComposerRoute(route: ComposerRoute, prompt: string): string {
  const text = prompt.trim();
  if (route.kind === 'skill') return text ? `${route.invoke} ${text}` : route.invoke;
  return `/run ${route.workerId} -- ${text}`;
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
    searchTerms: skill.searchTerms,
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
  return [...row.tags, ...(row.cloudTags ?? []), ...(row.searchTerms ?? [])].some((term) =>
    lowerCase(term).includes(needle),
  );
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
export function tagUnion(
  rows: ReadonlyArray<PickerRow>,
  limit = 24,
  useCloudTaxonomy = false,
): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const tag of useCloudTaxonomy ? (row.cloudTags ?? []) : row.tags) {
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
