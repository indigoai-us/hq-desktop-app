/**
 * Thin adapter over the US-003 Rust commands (`get_local_projects` /
 * `get_local_project_prd`) that normalises their wire shapes into the pure
 * US-004 model types (`Project` / `Story`).
 *
 * The Rust `LocalProject` is camelCase-serialised as
 * `{ id, title, description, company, status, prdPath?, createdAt?, updatedAt?,
 * storyCount, storiesComplete }`
 * and `LocalStory.priority` is an optional *string* — the US-004 `Story` type
 * wants `storiesTotal`/`storiesComplete` on the project and a numeric
 * `priority`, so this module owns that coercion in one place. No Svelte runes
 * here — just data mapping, so it stays trivially unit-testable.
 */

import { invoke } from '@tauri-apps/api/core';
import type { Project, Story } from './projects-model';
import {
  hasProvenance,
  mergeProvenance,
  normalizeProvenance,
  type WorkProvenance,
} from './provenance';

/** Raw `LocalProject` wire shape from `get_local_projects`. */
export interface LocalProjectWire {
  id: string;
  title: string;
  description?: string;
  company: string;
  status?: string;
  prdPath?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  creatorFallback?: string | null;
  storyCount: number;
  storiesComplete: number;
  provenance?: unknown;
  owner?: unknown;
  ownerName?: unknown;
  owner_name?: unknown;
  creator?: unknown;
  creatorName?: unknown;
  creator_name?: unknown;
  createdBy?: unknown;
  created_by?: unknown;
  createdByName?: unknown;
  created_by_name?: unknown;
  origin?: unknown;
  source?: unknown;
}

/** Raw `LocalStory` wire shape (stories inside `get_local_project_prd`). */
export interface LocalStoryWire {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  passes?: boolean;
  priority?: string | number | null;
  labels?: string[];
  dependsOn?: string[];
  notes?: string | null;
  files?: string[];
  model_hint?: string | null;
  metadata?: unknown;
  provenance?: unknown;
  owner?: unknown;
  ownerName?: unknown;
  owner_name?: unknown;
  assignee?: unknown;
  assigneeName?: unknown;
  assignee_name?: unknown;
  assignedTo?: unknown;
  assigned_to?: unknown;
  creator?: unknown;
  creatorName?: unknown;
  creator_name?: unknown;
  createdBy?: unknown;
  created_by?: unknown;
  createdByName?: unknown;
  created_by_name?: unknown;
  origin?: unknown;
  source?: unknown;
}

/** Raw `LocalProjectPrd` wire shape from `get_local_project_prd`. */
export interface LocalProjectPrdWire {
  name: string;
  description?: string;
  branchName?: string | null;
  userStories?: LocalStoryWire[];
  metadata?: unknown;
  provenance?: unknown;
  owner?: unknown;
  ownerName?: unknown;
  owner_name?: unknown;
  assignee?: unknown;
  assigneeName?: unknown;
  assignee_name?: unknown;
  assignedTo?: unknown;
  assigned_to?: unknown;
  creator?: unknown;
  creatorName?: unknown;
  creator_name?: unknown;
  createdBy?: unknown;
  created_by?: unknown;
  createdByName?: unknown;
  created_by_name?: unknown;
  origin?: unknown;
  source?: unknown;
}

/** Normalized PRD detail contract consumed by project surfaces. */
export interface LocalProjectPrd extends LocalProjectPrdWire {
  provenance: WorkProvenance;
}

/** Coerce a string|number priority to the numeric `Story.priority`. */
export function coercePriority(raw: string | number | null | undefined): number | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  // Accept "P1", "1", "high"-style strings — pull the first integer if present.
  const match = raw.match(/\d+/);
  if (match) return Number.parseInt(match[0], 10);
  return undefined;
}

/** Add an actionable file source without fabricating any person attribution. */
function withOriginFallback(
  provenance: WorkProvenance,
  sourcePath: string | null | undefined,
): WorkProvenance {
  if (provenance.origin) return provenance;
  const origin = normalizeProjectPath(sourcePath);
  return origin ? { ...provenance, origin } : provenance;
}

function projectSourceFallback(
  wire: Pick<LocalProjectWire, 'company' | 'prdPath'>,
): string | null {
  const prdPath = normalizeProjectPath(wire.prdPath);
  if (prdPath) return prdPath;
  const company = wire.company.trim();
  return company ? `companies/${company}/board.json` : null;
}

/**
 * Project provenance can supply authorship and source context for a task, but
 * project responsibility is not task responsibility. Creator may flow down as
 * the best available "created by" attribution; owner and assignee never do.
 * Explicit task owner/assignee/creator/source fields still win in
 * {@link toStory}.
 */
function storyProjectFallback(
  provenance: WorkProvenance | null | undefined,
): WorkProvenance {
  const normalized = normalizeProvenance(provenance);
  return {
    owner: null,
    assignee: null,
    creator: normalized.creator,
    origin: normalized.origin,
  };
}

/** Map one `LocalProject` wire object into the US-004 `Project` shape. */
export function toProject(wire: LocalProjectWire): Project {
  const explicitProvenance = withOriginFallback(
    normalizeProvenance(wire.provenance, wire),
    projectSourceFallback(wire),
  );
  const creatorFallback =
    typeof wire.creatorFallback === 'string' && wire.creatorFallback.trim()
      ? wire.creatorFallback.trim()
      : null;
  const usesCreatorFallback = Boolean(
    creatorFallback &&
      !explicitProvenance.owner &&
      !explicitProvenance.assignee &&
      !explicitProvenance.creator,
  );
  const provenance = usesCreatorFallback
    ? { ...explicitProvenance, creator: creatorFallback }
    : explicitProvenance;
  return {
    id: wire.id,
    title: wire.title,
    name: wire.title,
    description: wire.description ?? '',
    company: wire.company,
    status: wire.status ?? '',
    prdPath: wire.prdPath ?? '',
    createdAt: wire.createdAt ?? null,
    updatedAt: wire.updatedAt ?? null,
    storiesTotal: Math.max(0, wire.storyCount ?? 0),
    storiesComplete: Math.max(0, wire.storiesComplete ?? 0),
    provenance,
    creatorFallback: usesCreatorFallback ? creatorFallback : null,
  };
}

/**
 * Stable frontend identity for project rows.
 *
 * Project ids distinguish board entries even when two entries point at the same
 * PRD, while the PRD path distinguishes legacy entries that reuse an id. Use
 * the combined company + id + path identity for keyed lists and frontend caches
 * rather than the display-oriented `project.id`.
 */
export function projectIdentity(
  project: Pick<Project, 'company' | 'id' | 'prdPath'>,
): string {
  const company = project.company.trim();
  const projectId = project.id.trim();
  const prdPath = normalizeProjectPath(project.prdPath);
  return prdPath
    ? `${company}:id:${projectId}:path:${prdPath}`
    : `${company}:id:${projectId}`;
}

/** Normalize board/cloud path variants for provenance lookup and identity. */
export function normalizeProjectPath(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '');
}

/** Collapse exact duplicate scan results while preserving distinct board entries. */
export function dedupeProjects(projects: Project[]): Project[] {
  const seen = new Set<string>();
  return projects.filter((project) => {
    const identity = projectIdentity(project);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/**
 * Apply a status result only when it belongs to the project still being shown.
 *
 * Returning the original object for a non-match lets async callers cheaply
 * ignore a late completion from another project that happens to reuse the id.
 */
export function withProjectStatus(
  project: Project,
  changedIdentity: string,
  status: string,
): Project {
  return projectIdentity(project) === changedIdentity
    ? { ...project, status }
    : project;
}

/** Map one `LocalStory` wire object into the US-004 `Story` shape. */
export function toStory(
  wire: LocalStoryWire,
  sourcePath?: string,
  projectProvenance?: WorkProvenance | null,
): Story {
  return {
    id: wire.id,
    title: wire.title,
    description: wire.description ?? '',
    acceptanceCriteria: wire.acceptanceCriteria ?? [],
    passes: wire.passes ?? false,
    priority: coercePriority(wire.priority),
    labels: wire.labels ?? [],
    dependsOn: wire.dependsOn ?? [],
    notes: wire.notes ?? null,
    files: wire.files ?? [],
    model_hint: wire.model_hint ?? null,
    provenance: withOriginFallback(
      mergeProvenance(
        normalizeProvenance(wire.provenance, wire, wire.metadata),
        storyProjectFallback(projectProvenance),
      ),
      sourcePath,
    ),
  };
}

/** One best-effort project attribution row from the cloud board endpoint. */
export interface ProjectProvenanceRecord {
  id: string;
  prdPath: string | null;
  provenance: WorkProvenance;
}

export interface ProjectProvenanceIndex {
  byPath: Record<string, WorkProvenance>;
  byId: Record<string, WorkProvenance>;
  ambiguousIds: Set<string>;
}

/** Fresh empty attribution index for reactive page state. */
export function emptyProjectProvenanceIndex(): ProjectProvenanceIndex {
  return {
    byPath: {},
    byId: {},
    ambiguousIds: new Set<string>(),
  };
}

function provenanceIdKey(id: string | null | undefined): string | null {
  const clean = (id ?? '').trim();
  return clean ? `id:${clean}` : null;
}

function provenancePathKey(path: string | null | undefined): string | null {
  const clean = normalizeProjectPath(path);
  return clean ? `path:${clean}` : null;
}

/**
 * Read project attribution from the cloud board. The legacy command name is
 * retained for compatibility; newer responses may add owner/origin alongside
 * `creator`.
 */
export async function loadCompanyProjectProvenance(
  slug: string,
): Promise<ProjectProvenanceRecord[]> {
  const response = await invoke<unknown>('get_company_project_creators', { slug });
  if (!Array.isArray(response)) return [];
  return response.flatMap((raw): ProjectProvenanceRecord[] => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const row = raw as Record<string, unknown>;
    const provenance = normalizeProvenance(row.provenance, row);
    if (!hasProvenance(provenance)) return [];
    return [{
      id: typeof row.id === 'string' ? row.id : '',
      prdPath: typeof row.prdPath === 'string' ? row.prdPath : null,
      provenance,
    }];
  });
}

/**
 * Index cloud rows by normalized PRD path and by id only while the id is
 * unique. Legacy boards may reuse an id for multiple PRDs; those ids are
 * intentionally marked ambiguous instead of merging unrelated attribution.
 */
export function indexProjectProvenance(
  records: readonly ProjectProvenanceRecord[],
): ProjectProvenanceIndex {
  const index = emptyProjectProvenanceIndex();
  const idCounts = new Map<string, number>();
  for (const record of records) {
    const pathKey = provenancePathKey(record.prdPath);
    if (pathKey) {
      index.byPath[pathKey] = index.byPath[pathKey]
        ? mergeProvenance(index.byPath[pathKey], record.provenance)
        : record.provenance;
    }

    const idKey = provenanceIdKey(record.id);
    if (!idKey) continue;
    const count = (idCounts.get(idKey) ?? 0) + 1;
    idCounts.set(idKey, count);
    if (count === 1) {
      index.byId[idKey] = record.provenance;
    } else {
      index.ambiguousIds.add(idKey);
      delete index.byId[idKey];
    }
  }
  return index;
}

/** Apply cloud fallback fields without replacing explicit local attribution. */
export function applyProjectProvenance(
  project: Project,
  index: ProjectProvenanceIndex,
): Project {
  const pathKey = provenancePathKey(project.prdPath);
  const idKey = provenanceIdKey(project.id);
  const cloud =
    (pathKey ? index.byPath[pathKey] : undefined) ??
    (idKey && !index.ambiguousIds.has(idKey) ? index.byId[idKey] : undefined);
  const local = normalizeProvenance(project.provenance);
  const creatorFallback = project.creatorFallback?.trim() || null;
  const localWithoutHistory =
    creatorFallback && local.creator === creatorFallback
      ? { ...local, creator: null }
      : local;
  const normalizedLocalOrigin = normalizeProjectPath(localWithoutHistory.origin);
  const boardFallback = project.company.trim()
    ? `companies/${project.company.trim()}/board.json`
    : '';
  const derivedOrigins = new Set(
    [normalizeProjectPath(project.prdPath), boardFallback].filter(Boolean),
  );
  // Explicit local metadata wins cloud metadata, and explicit cloud metadata
  // wins only the board/prd file path we derived as a last-resort source.
  const localForMerge =
    cloud?.origin && derivedOrigins.has(normalizedLocalOrigin)
      ? { ...localWithoutHistory, origin: null }
      : localWithoutHistory;
  const explicit = mergeProvenance(localForMerge, cloud);
  const withCreatorFallback =
    creatorFallback &&
    !explicit.owner &&
    !explicit.assignee &&
    !explicit.creator
      ? { ...explicit, creator: creatorFallback }
      : explicit;
  const provenance = withOriginFallback(
    withCreatorFallback,
    localWithoutHistory.origin ?? projectSourceFallback(project),
  );
  return { ...project, provenance };
}

/** Load + normalise every local project across companies. */
export async function loadLocalProjects(): Promise<Project[]> {
  const response = await invoke<unknown>('get_local_projects');
  const wire = Array.isArray(response) ? (response as LocalProjectWire[]) : [];
  return dedupeProjects(wire.map(toProject));
}

// ---------------------------------------------------------------------------
// Company goals (objectives + initiatives) — get_local_company_goals
// ---------------------------------------------------------------------------

/**
 * One key result under an objective. The current board.json data carries
 * `keyResults: []`, so every field is optional (mirrors the permissive Rust
 * `KeyResult`). When populated, `target`/`current` are arbitrary JSON values, so
 * they stay loosely typed here — the card coerces them to numbers for the bar.
 */
export interface KeyResult {
  id?: string;
  title?: string;
  metric?: string;
  target?: number | string | null;
  current?: number | string | null;
  unit?: string;
  status?: string;
}

/** One objective from a company `board.json` `objectives[]` entry. */
export interface Objective {
  id: string;
  title: string;
  description: string;
  status: string;
  timeframe: string;
  owner?: string | null;
  keyResults: KeyResult[];
  initiativeIds: string[];
  linearInitiativeId?: string | null;
}

/** One initiative from a company `board.json` `initiatives[]` entry. */
export interface Initiative {
  id: string;
  title: string;
  description: string;
  status: string;
}

/** A company's GOALS surface, returned by `get_local_company_goals`. */
export interface CompanyGoals {
  objectives: Objective[];
  initiatives: Initiative[];
}

/** Raw wire shape from `get_local_company_goals` (camelCase from serde). */
interface CompanyGoalsWire {
  objectives?: Partial<Objective>[];
  initiatives?: Partial<Initiative>[];
}

/** Normalise one raw objective into the {@link Objective} shape. */
function toObjective(wire: Partial<Objective>): Objective {
  return {
    id: typeof wire.id === 'string' ? wire.id : '',
    title: typeof wire.title === 'string' ? wire.title : '',
    description: typeof wire.description === 'string' ? wire.description : '',
    status: typeof wire.status === 'string' ? wire.status : '',
    timeframe: typeof wire.timeframe === 'string' ? wire.timeframe : '',
    owner: typeof wire.owner === 'string' ? wire.owner : null,
    keyResults: Array.isArray(wire.keyResults) ? wire.keyResults : [],
    initiativeIds: Array.isArray(wire.initiativeIds) ? wire.initiativeIds : [],
    linearInitiativeId:
      typeof wire.linearInitiativeId === 'string' ? wire.linearInitiativeId : null,
  };
}

/** Normalise one raw initiative into the {@link Initiative} shape. */
function toInitiative(wire: Partial<Initiative>): Initiative {
  return {
    id: typeof wire.id === 'string' ? wire.id : '',
    title: typeof wire.title === 'string' ? wire.title : '',
    description: typeof wire.description === 'string' ? wire.description : '',
    status: typeof wire.status === 'string' ? wire.status : '',
  };
}

/**
 * Load + normalise a single company's goals (objectives + initiatives) from its
 * `board.json` via the US-011 Rust command. The command param is `company_slug`;
 * Tauri v2 exposes it camelCased. A company with no board (or an empty goals
 * block) resolves to empty arrays rather than throwing — the caller renders the
 * "No goals yet" empty state.
 */
export async function loadCompanyGoals(slug: string): Promise<CompanyGoals> {
  const wire = await invoke<CompanyGoalsWire>('get_local_company_goals', {
    companySlug: slug,
  });
  return {
    objectives: (wire?.objectives ?? []).map(toObjective),
    initiatives: (wire?.initiatives ?? []).map(toInitiative),
  };
}

/** Load + normalise the stories for a single project's prd.json. */
export async function loadLocalProjectStories(
  prdPath: string,
  projectProvenance?: WorkProvenance | null,
): Promise<Story[]> {
  // The Rust command param is `prd_path`; Tauri v2 exposes it camelCased.
  const prd = await invoke<LocalProjectPrdWire>('get_local_project_prd', { prdPath });
  const inherited = mergeProvenance(
    projectProvenance,
    normalizeProvenance(prd.provenance, prd, prd.metadata),
  );
  return (prd?.userStories ?? []).map((story) =>
    toStory(story, prdPath, inherited),
  );
}

/** Load PRD detail content with project-level provenance normalized. */
export async function loadLocalProjectPrd(prdPath: string): Promise<LocalProjectPrd> {
  const wire = await invoke<LocalProjectPrdWire>('get_local_project_prd', { prdPath });
  return {
    ...wire,
    provenance: withOriginFallback(
      normalizeProvenance(wire.provenance, wire, wire.metadata),
      prdPath,
    ),
  };
}

/**
 * Load a project's sibling README.md by its prd path (US-009). Returns `null`
 * when the project has no README — the Rust command returns `Option<String>`,
 * so a missing README is a normal `null`, not a thrown error.
 */
export async function loadLocalProjectReadme(prdPath: string): Promise<string | null> {
  const content = await invoke<string | null>('get_local_project_readme', { prdPath });
  return content ?? null;
}

/**
 * Persist a project's status to its company `board.json` (US-010). The Rust
 * command params are `board_path` / `project_id` / `prd_path` / `status`; Tauri
 * v2 exposes them camelCased. The PRD path disambiguates legacy same-ID board
 * entries. Rejects (throws) on a path escape, a non-board.json target, an
 * unknown/ambiguous project identity, or any write failure — the caller treats
 * a throw as the optimistic-update rollback signal.
 */
export async function saveLocalProjectStatus(
  boardPath: string,
  projectId: string,
  prdPath: string | null,
  status: string,
): Promise<void> {
  await invoke('set_local_project_status', { boardPath, projectId, prdPath, status });
}

/**
 * Create a minimal local project scaffold in-app (US-006 "New project"):
 * `companies/<slug>/projects/<name-slug>/prd.json` with an empty story list.
 * Resolves to the HQ-relative prd.json path of the new project; throws on an
 * empty/unusable name, an existing project folder, or any write failure.
 */
export async function createLocalProject(
  companySlug: string,
  name: string,
): Promise<string> {
  return invoke<string>('create_local_project', { companySlug, name });
}

/**
 * Persist a story's `passes` toggle to the project's prd.json (US-010). Same
 * throw-on-failure contract as {@link saveLocalProjectStatus}.
 */
export async function saveLocalStoryPasses(
  prdPath: string,
  storyId: string,
  passes: boolean,
): Promise<void> {
  await invoke('set_local_story_passes', { prdPath, storyId, passes });
}

/**
 * Persist a goal ↔ project association (US-005 "Link goal / Connect"). Writes
 * the project ref into the goal's own durable store — the objective's
 * `initiative_ids` in the company `board.json` (vault-synced) — via the Rust
 * `link_local_goal_project` command. Throws on failure (rollback signal).
 */
export async function saveGoalProjectLink(
  companySlug: string,
  goalId: string,
  projectRef: string,
): Promise<void> {
  await invoke('link_local_goal_project', { companySlug, goalId, projectRef });
}

/**
 * Create a new goal in-app (US-005 "New goal") — appends an objective with
 * title/description/target year to the company `board.json` (seeding the file
 * for a company with no goals yet). Resolves to the created goal's id.
 */
export async function createCompanyGoal(
  companySlug: string,
  title: string,
  description: string,
  timeframe: string,
): Promise<string> {
  return invoke<string>('create_local_company_goal', {
    companySlug,
    title,
    description,
    timeframe,
  });
}
