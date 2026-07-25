/**
 * Pure story/project classification logic for the desktop-alt projects view.
 *
 * Ported from hq-desktop's prd-utils.ts / board-utils.ts / kanban-board.tsx,
 * with the indigo Tailwind label palette replaced by HQ Sync's monochrome-glass
 * token system. These are pure functions — no Svelte runes, no Tauri imports —
 * so they are trivially unit-testable.
 */

// ---------------------------------------------------------------------------
// Types (match the US-003 Rust command output shape)
// ---------------------------------------------------------------------------

/** A single user story, as surfaced by the get_company_projects Rust command. */
export interface Story {
  /** Unique story identifier (e.g. "US-001"). */
  id: string;
  /** Short title describing the story. */
  title: string;
  /** Full description of the story. */
  description: string;
  /** List of acceptance criteria. */
  acceptanceCriteria: string[];
  /** Whether all acceptance criteria pass (story is complete). */
  passes: boolean;
  /** Priority level (1 = highest). Optional. */
  priority?: number;
  /** Labels for categorization. */
  labels: string[];
  /** IDs of stories this one depends on. */
  dependsOn: string[];
  /** Optional implementation notes from prd.json. */
  notes?: string | null;
  /** Optional declared files from prd.json. */
  files?: string[];
  /** Optional model hint from prd.json. */
  model_hint?: string | null;
}

/** A project, as surfaced by the get_company_projects Rust command. */
export interface Project {
  /** Unique project identifier (usually the directory name). */
  id: string;
  /** Display name. Either `name` or `title` may be populated upstream. */
  name?: string;
  /** Alternate display name field. */
  title?: string;
  /** Project description. */
  description: string;
  /** Owning company slug. */
  company: string;
  /** Raw status from board.json (e.g. "active", "archived", "planned"). */
  status: string;
  /** Absolute or HQ-relative path to the prd.json file. */
  prdPath: string;
  /** Project creation timestamp, when known. */
  createdAt?: string | null;
  /** Project update timestamp, when known. */
  updatedAt?: string | null;
  /** Total number of stories in the PRD. */
  storiesTotal: number;
  /** Number of stories that pass. */
  storiesComplete: number;
}

// ---------------------------------------------------------------------------
// Story state classification (mirrors prd-utils.classifyStories)
// ---------------------------------------------------------------------------

/** Kanban column state for a user story. */
export type StoryState = 'complete' | 'blocked' | 'in-progress' | 'pending';

/** A user story enriched with its derived kanban state. */
export interface ClassifiedStory {
  story: Story;
  state: StoryState;
}

/** All kanban states, in display order. */
export const STORY_STATES: StoryState[] = [
  'pending',
  'blocked',
  'in-progress',
  'complete',
];

/**
 * Classify all stories into kanban column states.
 *
 * Classification logic (matches hq-desktop's prd-utils):
 * - complete:    passes === true
 * - blocked:     passes === false AND at least one dependency is not complete
 * - in-progress: the FIRST eligible (deps met, not complete) story
 * - pending:     all remaining eligible stories
 */
export function classifyStories(stories: Story[]): ClassifiedStory[] {
  const completedIds = new Set(stories.filter((s) => s.passes).map((s) => s.id));

  const classified: ClassifiedStory[] = [];
  let inProgressAssigned = false;

  for (const story of stories) {
    if (story.passes) {
      classified.push({ story, state: 'complete' });
      continue;
    }

    const deps = story.dependsOn ?? [];
    const hasUnmetDeps = deps.some((depId) => !completedIds.has(depId));

    if (hasUnmetDeps) {
      classified.push({ story, state: 'blocked' });
      continue;
    }

    if (!inProgressAssigned) {
      classified.push({ story, state: 'in-progress' });
      inProgressAssigned = true;
    } else {
      classified.push({ story, state: 'pending' });
    }
  }

  return classified;
}

/**
 * Classify a single story against the full story set (needed for dependency
 * resolution). The `isFirstEligible` flag distinguishes in-progress from
 * pending — callers that don't care can pass `false` and treat any eligible
 * story as pending.
 */
export function classifyStory(
  story: Story,
  allStories: Story[],
  isFirstEligible = false,
): StoryState {
  if (story.passes) return 'complete';

  const completedIds = new Set(
    allStories.filter((s) => s.passes).map((s) => s.id),
  );
  const deps = story.dependsOn ?? [];
  const hasUnmetDeps = deps.some((depId) => !completedIds.has(depId));
  if (hasUnmetDeps) return 'blocked';

  return isFirstEligible ? 'in-progress' : 'pending';
}

/** Group classified stories by their kanban state. */
export function groupByState(
  classified: ClassifiedStory[],
): Record<StoryState, ClassifiedStory[]> {
  const groups: Record<StoryState, ClassifiedStory[]> = {
    pending: [],
    blocked: [],
    'in-progress': [],
    complete: [],
  };
  for (const item of classified) {
    groups[item.state].push(item);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Deterministic label color (monochrome-glass adaptation of kanban-board.tsx)
// ---------------------------------------------------------------------------

/**
 * A label chip's resolved color, expressed against HQ Sync's monochrome-glass
 * identity. Rather than the indigo Tailwind palette used in hq-desktop, we map
 * each label to one entry of a small neutral/translucent palette plus a stable
 * index. All values are CSS-var-friendly translucent monochrome tones with a
 * single controlled-saturation hue, preserving the monochrome look while still
 * giving each label a stable, distinguishable shade.
 */
export interface LabelColor {
  /** Stable palette index (0..LABEL_PALETTE_SIZE-1). */
  index: number;
  /** Translucent background fill (CSS color, monochrome with low saturation). */
  background: string;
  /** Border color (slightly stronger than the fill). */
  border: string;
  /** Foreground/text color. */
  foreground: string;
}

/** Number of distinct hues a label can resolve to. */
export const LABEL_PALETTE_SIZE = 8;

/**
 * The label palette — a low-saturation 8-hue set mirroring hq-desktop's
 * blue/purple/teal/pink/orange/cyan/lime/rose chips, tuned for the dark desktop
 * surface (translucent fill + matching border + a brighter readable foreground).
 * Hues are spaced around the wheel so adjacent labels stay distinguishable. The
 * deterministic hash (below) maps each label string to a stable entry.
 */
const LABEL_HUES = [217, 270, 173, 330, 25, 190, 84, 350];

export const LABEL_PALETTE: LabelColor[] = LABEL_HUES.map(
  (hue, i): LabelColor => ({
    index: i,
    background: `hsla(${hue}, 65%, 58%, 0.15)`,
    border: `hsla(${hue}, 65%, 60%, 0.30)`,
    foreground: `hsla(${hue}, 70%, 74%, 0.92)`,
  }),
);

/**
 * Deterministically hash a label string to a stable palette index.
 *
 * Uses the same `hash = (hash * 31 + charCode) | 0` rolling hash as
 * hq-desktop's kanban-board.tsx, so the mapping is stable and well-distributed.
 * Same input string always yields the same index.
 */
export function labelColorIndex(label: string): number {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % LABEL_PALETTE_SIZE;
}

/**
 * Resolve a label string to its deterministic monochrome-glass color.
 * Same string → identical LabelColor every time.
 */
export function labelColor(label: string): LabelColor {
  return LABEL_PALETTE[labelColorIndex(label)];
}

// ---------------------------------------------------------------------------
// Project progress + effective status (mirrors board-utils / prd-types)
// ---------------------------------------------------------------------------

/** Derived project-level rollup state. */
export type ProjectState = 'complete' | 'in-progress' | 'pending';

/** Project progress derived from prd.json story completion. */
export interface ProjectProgress {
  /** Number of complete stories. */
  complete: number;
  /** Total number of stories. */
  total: number;
  /** Completion percentage, 0–100 (0 when there are no stories). */
  percent: number;
  /** Rollup state derived from story completion. */
  state: ProjectState;
}

/**
 * Derive the project rollup state from story completion counts.
 *
 * - complete:    every story passes (and there is at least one)
 * - in-progress: some — but not all — stories pass
 * - pending:     no stories pass (or there are no stories)
 */
export function deriveProjectState(
  complete: number,
  total: number,
): ProjectState {
  if (total === 0) return 'pending';
  if (complete >= total) return 'complete';
  if (complete > 0) return 'in-progress';
  return 'pending';
}

/**
 * Compute project progress from explicit complete/total counts (as carried on
 * the Project shape from the US-003 Rust command).
 */
export function projectProgress(
  storiesComplete: number,
  storiesTotal: number,
): ProjectProgress {
  const total = Math.max(0, storiesTotal);
  const complete = Math.max(0, Math.min(storiesComplete, total));
  const percent = total === 0 ? 0 : Math.round((complete / total) * 100);
  return {
    complete,
    total,
    percent,
    state: deriveProjectState(complete, total),
  };
}

/**
 * Compute project progress directly from a story list (when the raw stories,
 * rather than precomputed counts, are available).
 */
export function projectProgressFromStories(stories: Story[]): ProjectProgress {
  const total = stories.length;
  const complete = stories.filter((s) => s.passes).length;
  return projectProgress(complete, total);
}

/**
 * Derive an effective, display-ready project status by combining the raw
 * board.json `status` with the prd.json story rollup.
 *
 * Rules (mirroring how board-utils treats archived projects as terminal):
 * - An "archived" board status is terminal and always wins.
 * - Otherwise the story rollup drives the effective status, so a board marked
 *   "active" but with every story passing reads as "complete", and one with no
 *   passing stories reads as "pending".
 */
export function effectiveProjectStatus(
  project: Pick<Project, 'status' | 'storiesComplete' | 'storiesTotal'>,
): ProjectState | 'archived' {
  if (project.status === 'archived') return 'archived';
  return deriveProjectState(project.storiesComplete, project.storiesTotal);
}

/** Best-effort display name for a project (`name` wins, then `title`, then id). */
export function projectDisplayName(project: Project): string {
  return project.name ?? project.title ?? project.id;
}

// ---------------------------------------------------------------------------
// Board list-surface helpers (US-007 — ported from hq-desktop project-types)
// ---------------------------------------------------------------------------

/**
 * The "effective" status a project resolves to for the Board list surface. This
 * is the union of {@link effectiveProjectStatus}'s output, plus the synthetic
 * `live` state used to give actively-running projects visual emphasis.
 *
 * - `live`        — board status is "active"/"live" AND there is in-flight work
 *                   (some but not all stories complete). Gets the glow + pulse.
 * - `in-progress` — story rollup says work is underway, but the board isn't live.
 * - `complete`    — every story passes.
 * - `pending`     — no stories pass yet (planned / not started).
 * - `archived`    — board status is archived (terminal).
 */
export type ProjectListStatus =
  | 'live'
  | 'in-progress'
  | 'complete'
  | 'pending'
  | 'archived';

/** The status-filter pills shown above the Board project list. */
export type StatusFilter = 'all' | 'active' | 'in-progress' | 'complete' | 'archived';

/** How the Board project list groups its rows. */
export type ProjectGroupMode = 'status' | 'company';

/** The status-filter pill options, in display order. */
export const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'in-progress', label: 'In Progress' },
  { value: 'complete', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
];

/** Raw board statuses that indicate a project is live/running (earns the
 * pulsing "live" emphasis). */
const LIVE_BOARD_STATUSES = new Set(['live', 'active', 'running']);

/**
 * Raw board statuses that mark a project as actively in progress. HQ's
 * `board.json` uses `in_progress` (snake_case) for projects under active work —
 * distinct from the `live`/`active`/`running` set above that earns the pulsing
 * "live" emphasis. A project carrying this status reads as In Progress even
 * before its first story completes, so a project the user has explicitly
 * started doesn't get mis-grouped under "Planned".
 */
const IN_PROGRESS_BOARD_STATUSES = new Set([
  'in_progress',
  'in-progress',
  'inprogress',
]);

/**
 * Resolve a project's effective Board-list status by combining its raw board
 * `status` with the prd.json story rollup. Mirrors hq-desktop's board scanner:
 * an archived board status is terminal; a live board status with in-flight work
 * surfaces as `live` (emphasised); otherwise the story rollup drives it.
 */
export function projectListStatus(
  project: Pick<Project, 'status' | 'storiesComplete' | 'storiesTotal'>,
): ProjectListStatus {
  const rollup = effectiveProjectStatus(project);
  if (rollup === 'archived') return 'archived';
  if (rollup === 'complete') return 'complete';

  const raw = (project.status ?? '').toLowerCase();
  const isLiveBoard = LIVE_BOARD_STATUSES.has(raw);
  const isInProgressBoard = IN_PROGRESS_BOARD_STATUSES.has(raw);
  if (rollup === 'in-progress') {
    return isLiveBoard ? 'live' : 'in-progress';
  }
  // pending rollup (no completed stories yet): a live board still earns `live`
  // emphasis; a board the user explicitly marked in-progress reads as
  // in-progress so it surfaces under "In Progress"; otherwise it's planned.
  if (isLiveBoard) return 'live';
  if (isInProgressBoard) return 'in-progress';
  return 'pending';
}

/** Whether a project's effective list status passes the given filter pill. */
export function matchesStatusFilter(
  status: ProjectListStatus,
  filter: StatusFilter,
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'active':
      // "Active" hides the terminal states (completed + archived).
      return status === 'live' || status === 'in-progress' || status === 'pending';
    case 'in-progress':
      return status === 'live' || status === 'in-progress';
    case 'complete':
      return status === 'complete';
    case 'archived':
      return status === 'archived';
    default:
      return true;
  }
}

/** Display order for the status-grouped Board sections (lower sorts first). */
export const PROJECT_LIST_STATUS_ORDER: Record<ProjectListStatus, number> = {
  live: 0,
  'in-progress': 1,
  pending: 2,
  complete: 3,
  archived: 4,
};

/** Human label for each effective list status (section headers + badges). */
export const PROJECT_LIST_STATUS_LABEL: Record<ProjectListStatus, string> = {
  live: 'Running',
  'in-progress': 'In Progress',
  pending: 'Planned',
  complete: 'Completed',
  archived: 'Archived',
};

function projectTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

/** Latest known project activity timestamp, preferring updatedAt over createdAt. */
export function projectRecencyTime(
  project: Pick<Project, 'createdAt' | 'updatedAt'>,
): number {
  return projectTimestamp(project.updatedAt) || projectTimestamp(project.createdAt);
}

/** Sort comparator: most recently updated first, then status, then name. */
export function compareProjectsByRecency(a: Project, b: Project): number {
  const recencyDelta = projectRecencyTime(b) - projectRecencyTime(a);
  if (recencyDelta !== 0) return recencyDelta;

  const aStatus = PROJECT_LIST_STATUS_ORDER[projectListStatus(a)] ?? 99;
  const bStatus = PROJECT_LIST_STATUS_ORDER[projectListStatus(b)] ?? 99;
  return (
    aStatus - bStatus ||
    projectDisplayName(a).localeCompare(projectDisplayName(b))
  );
}

/** Does a project's effective status text match a free-text query token? */
function projectStatusMatches(project: Project, query: string): boolean {
  return PROJECT_LIST_STATUS_LABEL[projectListStatus(project)]
    .toLowerCase()
    .includes(query);
}

/**
 * Filter a project list by a free-text query, matching the title, description,
 * id, and company slug (case-insensitive). An empty/whitespace query is a no-op.
 */
export function filterProjectsByQuery(projects: Project[], rawQuery: string): Project[] {
  const query = rawQuery.toLowerCase().trim();
  if (!query) return projects;
  return projects.filter((project) => {
    const name = projectDisplayName(project).toLowerCase();
    return (
      name.includes(query) ||
      (project.description ?? '').toLowerCase().includes(query) ||
      project.id.toLowerCase().includes(query) ||
      project.company.toLowerCase().includes(query) ||
      projectStatusMatches(project, query)
    );
  });
}

/** A grouped section of projects for the Board list (status- or company-keyed). */
export interface ProjectSection {
  /** Stable section key (status id or company slug). */
  key: string;
  /** Display label for the section header. */
  label: string;
  /** Projects in this section, pre-sorted for display. */
  projects: Project[];
}

/** Sort comparator: most recent first, then by status order, then by name. */
function compareProjects(a: Project, b: Project): number {
  return compareProjectsByRecency(a, b);
}

/**
 * Group + sort a project list into display sections.
 *
 * - `status`  — one section per effective list status, in status order, empty
 *               sections omitted.
 * - `company` — one section per company slug, alphabetical, projects within a
 *               section sorted newest-first.
 */
export function groupProjects(
  projects: Project[],
  mode: ProjectGroupMode,
): ProjectSection[] {
  if (mode === 'status') {
    const buckets = new Map<ProjectListStatus, Project[]>();
    for (const project of projects) {
      const status = projectListStatus(project);
      const list = buckets.get(status) ?? [];
      list.push(project);
      buckets.set(status, list);
    }
    return (Object.keys(PROJECT_LIST_STATUS_ORDER) as ProjectListStatus[])
      .sort(
        (a, b) => PROJECT_LIST_STATUS_ORDER[a] - PROJECT_LIST_STATUS_ORDER[b],
      )
      .filter((status) => (buckets.get(status)?.length ?? 0) > 0)
      .map((status) => ({
        key: status,
        label: PROJECT_LIST_STATUS_LABEL[status],
        projects: (buckets.get(status) ?? []).slice().sort(compareProjects),
      }));
  }

  const buckets = new Map<string, Project[]>();
  for (const project of projects) {
    const key = project.company || 'hq';
    const list = buckets.get(key) ?? [];
    list.push(project);
    buckets.set(key, list);
  }
  return [...buckets.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({
      key,
      label: key,
      projects: (buckets.get(key) ?? []).slice().sort(compareProjects),
    }));
}

// ---------------------------------------------------------------------------
// Editable project statuses (US-009 detail-view status control)
// ---------------------------------------------------------------------------

/**
 * The statuses a user may manually assign to a project, in display order
 * (ported from hq-desktop's EDITABLE_STATUSES). Excludes the synthetic `live`
 * state — that is set by the orchestrator, not the user. The detail-view status
 * control (US-009) renders these read-only for now; persisting a change is
 * wired in US-010.
 */
export const EDITABLE_PROJECT_STATUSES = [
  'planned',
  'prd_created',
  'in_progress',
  'completed',
  'archived',
] as const;

/** One of the user-assignable project statuses. */
export type EditableProjectStatus = (typeof EDITABLE_PROJECT_STATUSES)[number];

/** Human-readable label for each editable project status. */
export const EDITABLE_PROJECT_STATUS_LABEL: Record<EditableProjectStatus, string> = {
  planned: 'Planned',
  prd_created: 'PRD Created',
  in_progress: 'In Progress',
  completed: 'Completed',
  archived: 'Archived',
};

/**
 * Resolve a project's raw board `status` to the editable-status enum used by the
 * detail-view control. Raw board statuses are messy (`active`, `live`,
 * `running`, `complete`, …); this maps them onto the canonical editable set so
 * the control always has a defined current value. Unknown statuses fall back to
 * `planned`.
 */
export function toEditableStatus(rawStatus: string | undefined | null): EditableProjectStatus {
  const s = (rawStatus ?? '').toLowerCase().trim();
  switch (s) {
    case 'planned':
    case 'pending':
    case '':
      return 'planned';
    case 'prd_created':
    case 'prd':
      return 'prd_created';
    case 'in_progress':
    case 'in-progress':
    case 'active':
    case 'live':
    case 'running':
      return 'in_progress';
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed';
    case 'archived':
      return 'archived';
    default:
      return 'planned';
  }
}

/** Distinct company slugs present in a project list, alphabetical. */
export function projectCompanies(projects: Project[]): string[] {
  return [...new Set(projects.map((project) => project.company).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  );
}

// ---------------------------------------------------------------------------
// Project portfolio Kanban (DESKTOP-004)
// ---------------------------------------------------------------------------
//
// Company Projects defaults to a four-column operational board. Active is
// reserved for a *live execution signal* (running / awaiting_input sessions),
// not for a board.json status of "active"/"live"/"running". When that signal
// ends, unfinished work returns to In progress. Complete only follows true
// completion status / full story progress.

/**
 * Portfolio Kanban columns in display order. Exactly these four — no Planned /
 * Running / Archived labels at the portfolio level.
 */
export type PortfolioColumn = 'not-started' | 'in-progress' | 'active' | 'complete';

/** The four portfolio columns, in left-to-right board order. */
export const PORTFOLIO_COLUMNS: readonly PortfolioColumn[] = [
  'not-started',
  'in-progress',
  'active',
  'complete',
] as const;

/** Human labels for portfolio column headers. */
export const PORTFOLIO_COLUMN_LABEL: Record<PortfolioColumn, string> = {
  'not-started': 'Not started',
  'in-progress': 'In progress',
  active: 'Active',
  complete: 'Complete',
};

/** Short captions under each portfolio column header. */
export const PORTFOLIO_COLUMN_CAPTION: Record<PortfolioColumn, string> = {
  'not-started': 'Planned, no work begun',
  'in-progress': 'Started, no live run right now',
  active: 'Live execution signal present',
  complete: 'All tasks passed',
};

/** Board/List view mode for the company project portfolio. */
export type PortfolioViewMode = 'board' | 'list';

/**
 * State filter options for the portfolio toolbar (distinct from the Board list
 * STATUS_FILTER_OPTIONS which still includes Archived for the overview grid).
 */
export type PortfolioStateFilter = 'all' | PortfolioColumn;

export const PORTFOLIO_STATE_FILTER_OPTIONS: {
  value: PortfolioStateFilter;
  label: string;
}[] = [
  { value: 'all', label: 'All states' },
  { value: 'not-started', label: 'Not started' },
  { value: 'in-progress', label: 'In progress' },
  { value: 'active', label: 'Active' },
  { value: 'complete', label: 'Complete' },
];

/**
 * Minimal session slice the portfolio needs for live matching. Mirrors the
 * AgentSession fields used for Active placement — callers pass full sessions.
 */
export interface PortfolioSessionRef {
  project: string;
  company: string;
  cwd: string;
  status: string;
  startedAt?: string;
  lastActivityAt?: string;
  tool?: string;
  model?: string;
  source?: string;
}

/** Whether a session status counts as a live execution signal for Active. */
export function isPortfolioLiveStatus(status: string | null | undefined): boolean {
  const raw = (status ?? '').toLowerCase();
  return raw === 'running' || raw === 'awaiting_input';
}

function normalizePortfolioToken(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Project identity tokens used to match agent sessions (id, name, title, and
 * the parent directory of prdPath when present).
 */
export function projectMatchTokens(
  project: Pick<Project, 'id' | 'name' | 'title' | 'prdPath'>,
): string[] {
  const fromPath = project.prdPath
    ? project.prdPath.split('/').filter(Boolean).at(-2)
    : undefined;
  return [project.id, project.name, project.title, fromPath]
    .map(normalizePortfolioToken)
    .filter((token) => token.length >= 2);
}

/**
 * Whether a session belongs to a project. Matches when the session's project
 * field or cwd path contains a project identity token. Company is used as a
 * soft constraint when both sides carry one — empty company never excludes.
 */
export function sessionMatchesProject(
  session: PortfolioSessionRef,
  project: Pick<Project, 'id' | 'name' | 'title' | 'prdPath' | 'company'>,
): boolean {
  const sessionCompany = (session.company ?? '').trim().toLowerCase();
  const projectCompany = (project.company ?? '').trim().toLowerCase();
  if (sessionCompany && projectCompany && sessionCompany !== projectCompany) {
    return false;
  }

  const sessionProject = (session.project ?? '').trim().toLowerCase();
  const projectId = (project.id ?? '').trim().toLowerCase();
  // Exact id / display-name match first (handles short project slugs).
  if (sessionProject) {
    if (projectId && sessionProject === projectId) return true;
    const name = (project.name ?? project.title ?? '').trim().toLowerCase();
    if (name && sessionProject === name) return true;
  }

  const tokens = projectMatchTokens(project).filter((token) => token.length >= 2);
  if (tokens.length === 0) return false;

  const hay = normalizePortfolioToken(
    [session.project, session.cwd, session.source ?? ''].filter(Boolean).join(' '),
  );
  if (!hay) return false;
  return tokens.some((token) => hay.includes(token));
}

/**
 * Live sessions for a project — only `running` / `awaiting_input`. Idle and
 * ended sessions are not live signals (they move unfinished work to In progress).
 */
export function liveSessionsForProject(
  project: Pick<Project, 'id' | 'name' | 'title' | 'prdPath' | 'company'>,
  sessions: readonly PortfolioSessionRef[],
): PortfolioSessionRef[] {
  return sessions.filter(
    (session) =>
      isPortfolioLiveStatus(session.status) && sessionMatchesProject(session, project),
  );
}

/** True when at least one live execution signal is currently present. */
export function projectHasLiveSignal(
  project: Pick<Project, 'id' | 'name' | 'title' | 'prdPath' | 'company'>,
  sessions: readonly PortfolioSessionRef[],
): boolean {
  return liveSessionsForProject(project, sessions).length > 0;
}

/**
 * Resolve a project's portfolio column.
 *
 * - `complete`     — archived terminal OR every story passes (true completion)
 * - `active`       — live execution signal present NOW (and not complete)
 * - `in-progress`  — work has started (story rollup / explicit board status) without a live signal
 * - `not-started`  — planned / pending; no progress and no live signal
 *
 * Board statuses like `active`/`live`/`running` alone do **not** put a project in
 * Active — those mean the board thinks work is underway, which is In progress
 * unless a real session signal is present.
 */
export function portfolioColumn(
  project: Pick<Project, 'status' | 'storiesComplete' | 'storiesTotal'>,
  hasLiveSignal: boolean,
): PortfolioColumn {
  const raw = (project.status ?? '').toLowerCase().trim();
  if (raw === 'archived') {
    // Archived is terminal. If all stories pass, treat as Complete; otherwise
    // keep it out of Active and park unfinished archives under In progress so
    // they remain visible without a fifth column.
    const rollup = deriveProjectState(project.storiesComplete, project.storiesTotal);
    return rollup === 'complete' || project.storiesTotal === 0 ? 'complete' : 'in-progress';
  }

  if (
    raw === 'completed' ||
    raw === 'complete' ||
    raw === 'done' ||
    deriveProjectState(project.storiesComplete, project.storiesTotal) === 'complete'
  ) {
    return 'complete';
  }

  if (hasLiveSignal) return 'active';

  const rollup = deriveProjectState(project.storiesComplete, project.storiesTotal);
  if (rollup === 'in-progress') return 'in-progress';

  if (IN_PROGRESS_BOARD_STATUSES.has(raw) || LIVE_BOARD_STATUSES.has(raw)) {
    return 'in-progress';
  }

  return 'not-started';
}

/** Whether a portfolio column passes the toolbar state filter. */
export function matchesPortfolioStateFilter(
  column: PortfolioColumn,
  filter: PortfolioStateFilter,
): boolean {
  if (filter === 'all') return true;
  return column === filter;
}

/** Group projects into the four portfolio columns (empty columns kept). */
export function groupProjectsByPortfolioColumn(
  projects: Project[],
  sessions: readonly PortfolioSessionRef[],
): Record<PortfolioColumn, Project[]> {
  const groups: Record<PortfolioColumn, Project[]> = {
    'not-started': [],
    'in-progress': [],
    active: [],
    complete: [],
  };
  for (const project of projects) {
    const hasLive = projectHasLiveSignal(project, sessions);
    const column = portfolioColumn(project, hasLive);
    groups[column].push(project);
  }
  for (const column of PORTFOLIO_COLUMNS) {
    groups[column] = groups[column].slice().sort(compareProjectsByRecency);
  }
  return groups;
}

/**
 * Real live-run fields for an Active portfolio card. Only fields that exist on
 * the session/project contracts are populated; missing data stays null so the
 * UI can omit or label "unavailable" — never synthesize telemetry.
 */
export interface ProjectLiveRunView {
  /** Human label from the freshest live session status (e.g. "Running"). */
  phase: string | null;
  /** Elapsed since session startedAt when known (mm:ss or h:mm:ss). */
  elapsed: string | null;
  /** Count of live workers (matching sessions). Always a real count ≥ 0. */
  workers: number;
  /**
   * Subagent count when the session contract exposes one. Currently always
   * `null` — AgentSession has no subagent field — so callers must omit or say
   * unavailable rather than invent 0.
   */
  subagents: number | null;
  /** Project story progress percent when stories exist; null when total is 0. */
  progressPercent: number | null;
  /** Freshest lastActivityAt ISO, when any live session has one. */
  lastSignalAt: string | null;
}

const LIVE_PHASE_LABEL: Record<string, string> = {
  running: 'Running',
  awaiting_input: 'Awaiting input',
};

/**
 * Format elapsed wall time from an ISO start. Returns null when the timestamp
 * is missing or unparseable — never invents a duration.
 */
export function formatLiveElapsed(
  startedAt: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!startedAt) return null;
  const then = Date.parse(startedAt);
  if (!Number.isFinite(then) || then <= 0) return null;
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Build the Active-card live run view from real sessions + project progress.
 * Returns null when there is no live signal (caller should not show the block).
 */
export function projectLiveRunView(
  project: Pick<
    Project,
    'id' | 'name' | 'title' | 'prdPath' | 'company' | 'storiesComplete' | 'storiesTotal'
  >,
  sessions: readonly PortfolioSessionRef[],
  now: number = Date.now(),
): ProjectLiveRunView | null {
  const live = liveSessionsForProject(project, sessions);
  if (live.length === 0) return null;

  // Freshest by lastActivityAt, then startedAt.
  const sorted = live.slice().sort((a, b) => {
    const aT = Date.parse(a.lastActivityAt ?? '') || Date.parse(a.startedAt ?? '') || 0;
    const bT = Date.parse(b.lastActivityAt ?? '') || Date.parse(b.startedAt ?? '') || 0;
    return bT - aT;
  });
  const primary = sorted[0];
  const phase = LIVE_PHASE_LABEL[primary.status] ?? null;
  const started =
    sorted
      .map((s) => s.startedAt)
      .find((iso) => iso && Number.isFinite(Date.parse(iso))) ?? null;
  const lastSignalAt =
    sorted
      .map((s) => s.lastActivityAt)
      .find((iso) => iso && Number.isFinite(Date.parse(iso))) ?? null;

  const progress = projectProgress(project.storiesComplete, project.storiesTotal);

  return {
    phase,
    elapsed: formatLiveElapsed(started, now),
    workers: live.length,
    // AgentSession has no subagent count — honest null, never 0-as-real.
    subagents: null,
    progressPercent: progress.total > 0 ? progress.percent : null,
    lastSignalAt,
  };
}

/**
 * Calm state-context line for non-Active cards. Uses only real progress /
 * board status — no fabricated worker/run metadata.
 */
export function portfolioStateContext(
  column: PortfolioColumn,
  project: Pick<Project, 'storiesComplete' | 'storiesTotal' | 'status'>,
): string {
  const progress = projectProgress(project.storiesComplete, project.storiesTotal);
  switch (column) {
    case 'not-started':
      return 'No run expected before work begins';
    case 'in-progress':
      return progress.complete > 0
        ? 'Work remains underway · no active worker'
        : 'Started · no active worker';
    case 'active':
      return 'Live execution signal present';
    case 'complete':
      return progress.total > 0 && progress.complete >= progress.total
        ? 'All tasks passed'
        : 'Complete';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Project task Kanban (DESKTOP-005)
// ---------------------------------------------------------------------------
//
// Project Tasks uses the same four operational columns as the company portfolio.
// Active requires a live session signal matched to the *task* (story id token in
// session project/cwd/source) — not board status. When that signal ends,
// unfinished work returns to In progress. Complete still follows story.passes.

/**
 * Task Kanban columns in display order. Exactly these four — no Blocked /
 * Pending labels at the project-task level (blocked work parks under Not started).
 */
export type TaskColumn = PortfolioColumn;

/** The four task columns, in left-to-right board order (same ids as portfolio). */
export const TASK_COLUMNS: readonly TaskColumn[] = PORTFOLIO_COLUMNS;

/** Human labels for task column headers. */
export const TASK_COLUMN_LABEL: Record<TaskColumn, string> = {
  'not-started': 'Not started',
  'in-progress': 'In progress',
  active: 'Active',
  complete: 'Complete',
};

/** Short captions under each task column header. */
export const TASK_COLUMN_CAPTION: Record<TaskColumn, string> = {
  'not-started': 'Ready or waiting to begin',
  'in-progress': 'Started, no live run right now',
  active: 'Live worker signal present',
  complete: 'Task-level checks passed',
};

/** A story enriched with its derived task Kanban column. */
export interface ClassifiedTask {
  story: Story;
  column: TaskColumn;
}

/**
 * Whether a session belongs to a specific task. Matches when the story id
 * appears as a token in the session's project / cwd / source haystack. Does not
 * invent a storyId field — only uses real AgentSession strings. Short ids
 * under 3 characters are ignored to avoid accidental matches.
 */
export function sessionMatchesStory(
  session: PortfolioSessionRef,
  story: Pick<Story, 'id' | 'title'>,
): boolean {
  const storyId = (story.id ?? '').trim().toLowerCase();
  if (storyId.length < 3) return false;
  const hay = normalizePortfolioToken(
    [session.project, session.cwd, session.source ?? ''].filter(Boolean).join(' '),
  );
  if (!hay) return false;
  // Normalize story id the same way so "DESKTOP-005" matches desktop005 tokens
  // and the raw id form in paths like .../DESKTOP-005/...
  const idToken = normalizePortfolioToken(storyId);
  if (idToken.length >= 3 && hay.includes(idToken)) return true;
  // Also allow the raw lowercased id with separators stripped only (already in idToken).
  // Require word-ish boundaries via includes on the joined lowercased raw haystack.
  const rawHay = [session.project, session.cwd, session.source ?? '']
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return rawHay.includes(storyId);
}

/**
 * Live sessions matched to a story — only `running` / `awaiting_input`.
 * Idle and ended sessions are not live signals.
 */
export function liveSessionsForStory(
  story: Pick<Story, 'id' | 'title'>,
  sessions: readonly PortfolioSessionRef[],
): PortfolioSessionRef[] {
  return sessions.filter(
    (session) =>
      isPortfolioLiveStatus(session.status) && sessionMatchesStory(session, story),
  );
}

/** True when at least one live execution signal is currently matched to the task. */
export function storyHasLiveSignal(
  story: Pick<Story, 'id' | 'title'>,
  sessions: readonly PortfolioSessionRef[],
): boolean {
  return liveSessionsForStory(story, sessions).length > 0;
}

/**
 * Whether a story counts as "started" for In progress placement when there is
 * no live signal. Uses only existing story fields + the classic first-eligible
 * rule — never fabricates run history.
 *
 * Started when:
 * - non-empty notes, or
 * - classic classifier would place it in `in-progress` (first eligible).
 *
 * Blocked (unmet deps) and untouched pending stories are not started.
 */
export function taskIsStarted(story: Story, allStories: Story[]): boolean {
  if (story.passes) return false;
  const notes = (story.notes ?? '').trim();
  if (notes.length > 0) return true;
  const classified = classifyStories(allStories);
  const item = classified.find((entry) => entry.story.id === story.id);
  return item?.state === 'in-progress';
}

/**
 * Resolve a story's task column.
 *
 * - `complete`     — story.passes
 * - `active`       — live session signal matched to this task NOW
 * - `in-progress`  — started/unfinished with no live signal
 * - `not-started`  — not complete, not started, or waiting on deps
 *
 * When a live signal ends, unfinished work returns to In progress (if started)
 * or Not started (if never started). Board status is never consulted.
 */
export function taskColumn(
  story: Story,
  allStories: Story[],
  hasLiveSignal: boolean,
): TaskColumn {
  if (story.passes) return 'complete';
  if (hasLiveSignal) return 'active';
  if (taskIsStarted(story, allStories)) return 'in-progress';
  return 'not-started';
}

/** Classify all stories into task columns (empty columns kept by group helper). */
export function classifyTasks(
  stories: Story[],
  sessions: readonly PortfolioSessionRef[] = [],
): ClassifiedTask[] {
  return stories.map((story) => ({
    story,
    column: taskColumn(story, stories, storyHasLiveSignal(story, sessions)),
  }));
}

/** Group classified tasks by column (empty columns present). */
export function groupByTaskColumn(
  classified: ClassifiedTask[],
): Record<TaskColumn, ClassifiedTask[]> {
  const groups: Record<TaskColumn, ClassifiedTask[]> = {
    'not-started': [],
    'in-progress': [],
    active: [],
    complete: [],
  };
  for (const item of classified) {
    groups[item.column].push(item);
  }
  return groups;
}

/**
 * Real live-run fields for an Active task card. Only fields that exist on the
 * session/story contracts are populated; missing data stays null so the UI can
 * omit or label "unavailable" — never synthesize telemetry.
 */
export interface StoryLiveRunView {
  /** Human label from the freshest live session status (e.g. "Running"). */
  phase: string | null;
  /** Elapsed since session startedAt when known (mm:ss or h:mm:ss). */
  elapsed: string | null;
  /** Count of live workers (matching sessions). Always a real count ≥ 0. */
  workers: number;
  /**
   * Subagent count when the session contract exposes one. Currently always
   * `null` — AgentSession has no subagent field.
   */
  subagents: number | null;
  /** Story AC progress percent when criteria exist; null when total is 0. */
  progressPercent: number | null;
  /** Freshest lastActivityAt ISO, when any live session has one. */
  lastSignalAt: string | null;
}

/**
 * Build the Active-card live run view for a task from real sessions + story AC.
 * Returns null when there is no live signal (caller should not show the block).
 * Phase labels stay calm (Running / Awaiting input) — no alert thresholds.
 */
export function storyLiveRunView(
  story: Story,
  sessions: readonly PortfolioSessionRef[],
  now: number = Date.now(),
): StoryLiveRunView | null {
  const live = liveSessionsForStory(story, sessions);
  if (live.length === 0) return null;

  const sorted = live.slice().sort((a, b) => {
    const aT = Date.parse(a.lastActivityAt ?? '') || Date.parse(a.startedAt ?? '') || 0;
    const bT = Date.parse(b.lastActivityAt ?? '') || Date.parse(b.startedAt ?? '') || 0;
    return bT - aT;
  });
  const primary = sorted[0];
  const phase = LIVE_PHASE_LABEL[primary.status] ?? null;
  const started =
    sorted
      .map((s) => s.startedAt)
      .find((iso) => iso && Number.isFinite(Date.parse(iso))) ?? null;
  const lastSignalAt =
    sorted
      .map((s) => s.lastActivityAt)
      .find((iso) => iso && Number.isFinite(Date.parse(iso))) ?? null;

  const acTotal = story.acceptanceCriteria?.length ?? 0;
  const acComplete = story.passes ? acTotal : 0;
  const progressPercent =
    acTotal > 0 ? Math.round((acComplete / acTotal) * 100) : null;

  return {
    phase,
    elapsed: formatLiveElapsed(started, now),
    workers: live.length,
    subagents: null,
    progressPercent,
    lastSignalAt,
  };
}

/**
 * Calm state-context line for non-Active task cards. Uses only real start /
 * dependency state — no fabricated worker/run metadata.
 */
export function taskStateContext(
  column: TaskColumn,
  story: Story,
  allStories: Story[],
): string {
  switch (column) {
    case 'not-started': {
      const completedIds = new Set(allStories.filter((s) => s.passes).map((s) => s.id));
      const hasUnmet = (story.dependsOn ?? []).some((depId) => !completedIds.has(depId));
      return hasUnmet ? 'Waiting on dependencies' : 'No run expected before work begins';
    }
    case 'in-progress':
      return 'Started · no active worker';
    case 'active':
      return 'Live execution signal present';
    case 'complete':
      return 'Task-level checks passed';
    default:
      return '';
  }
}

/**
 * Derive an HQ-relative project directory from a prdPath for Files scoping.
 * Returns null when the path cannot be resolved to a companies/.../projects/...
 * prefix — callers must not invent a root.
 */
export function projectFilesRootFromPrdPath(prdPath: string | null | undefined): string | null {
  if (!prdPath) return null;
  const normalized = prdPath.replace(/\\/g, '/');
  const marker = '/companies/';
  const idx = normalized.indexOf(marker);
  const relative =
    idx >= 0
      ? normalized.slice(idx + 1) // drop leading slash → companies/...
      : normalized.startsWith('companies/')
        ? normalized
        : null;
  if (!relative) return null;
  // Drop trailing prd.json (or any filename) → project directory.
  const parts = relative.split('/').filter(Boolean);
  if (parts.length < 3) return null;
  if (parts[parts.length - 1]?.toLowerCase().endsWith('.json')) {
    parts.pop();
  }
  return parts.join('/');
}
