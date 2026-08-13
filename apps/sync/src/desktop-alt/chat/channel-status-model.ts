/**
 * Pure model for the project-channel members / status popover (US-005).
 *
 * Derives live agent rows, story rollup, project metadata, and member lists
 * from local PRD + agent sessions + channel roster — no Tauri, no DOM.
 */

import {
  isPortfolioLiveStatus,
  sessionMatchesProject,
  type PortfolioSessionRef,
} from '../lib/projects-model';

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface StatusStoryInput {
  id: string;
  title?: string;
  passes?: boolean;
}

export interface StatusPrdInput {
  name?: string;
  branchName?: string | null;
  /** Absolute or HQ-relative repo path when known. */
  repoPath?: string | null;
  /** Optional deploy/preview URL — only shown when present. */
  previewUrl?: string | null;
  userStories?: StatusStoryInput[];
  metadata?: unknown;
  /** Fallback prd path used to derive a repo directory. */
  prdPath?: string | null;
}

export interface StatusProjectInput {
  id: string;
  title?: string;
  name?: string;
  company?: string;
  prdPath?: string;
  storiesTotal?: number;
  storiesComplete?: number;
}

export interface StatusMemberInput {
  personUid: string;
  displayName?: string;
  email?: string;
  role?: string;
  /** When true (or personUid looks like an agent), row goes under AGENTS. */
  isAgent?: boolean;
}

export interface StatusSessionInput extends PortfolioSessionRef {
  /** Optional person identity when the agent is a channel participant. */
  personUid?: string;
  /** Optional progress 0–100 when the session reports it. */
  progressPercent?: number | null;
  /** Optional story id the session is working on (US-xxx). */
  storyId?: string | null;
}

export interface BuildChannelStatusInput {
  project: StatusProjectInput;
  prd?: StatusPrdInput | null;
  sessions?: readonly StatusSessionInput[];
  members?: readonly StatusMemberInput[];
  companyLabel?: string | null;
}

// ── Outputs ──────────────────────────────────────────────────────────────────

export type AgentLiveStatus = 'running' | 'awaiting_input' | 'idle' | 'ended';

export interface LiveAgentStatusRow {
  id: string;
  /** "Agent running · US-003 · 40%" */
  label: string;
  storyId: string | null;
  progressPercent: number;
  status: AgentLiveStatus;
  tool: string | null;
  displayName: string;
}

export interface StoryRollup {
  complete: number;
  total: number;
  /** "stories 3/8" */
  label: string;
  /** 0–100 integer. */
  percent: number;
}

export interface ProjectStatusBlock {
  branch: string | null;
  repo: string | null;
  previewUrl: string | null;
}

export interface StatusPersonRow {
  personUid: string;
  displayName: string;
  role: string | null;
  /** For AGENTS list: running | idle (collapsed from live taxonomy). */
  statusIcon: 'running' | 'idle';
}

export interface ChannelStatusModel {
  /** Live agent rows with progress bars. */
  liveAgents: LiveAgentStatusRow[];
  stories: StoryRollup;
  project: ProjectStatusBlock;
  members: StatusPersonRow[];
  agents: StatusPersonRow[];
  memberCount: number;
  /** Header subtitle helper: company display name. */
  companyLabel: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const STORY_ID_RE = /\b(US[-_]?\d+[a-z]?)\b/i;

export function extractStoryId(...parts: Array<string | null | undefined>): string | null {
  for (const part of parts) {
    if (!part) continue;
    const m = part.match(STORY_ID_RE);
    if (m?.[1]) {
      // Normalize US-003 style.
      const raw = m[1].toUpperCase().replace(/_/g, '-');
      return raw.startsWith('US') && !raw.startsWith('US-')
        ? raw.replace(/^US/, 'US-')
        : raw;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

/** Prefer explicit repoPath; else metadata; else directory of prdPath. */
export function resolveRepoPath(prd: StatusPrdInput | null | undefined): string | null {
  if (!prd) return null;
  const direct = optionalString(prd.repoPath);
  if (direct) return direct;
  const meta = asRecord(prd.metadata);
  if (meta) {
    const fromMeta =
      optionalString(meta.repoPath) ||
      optionalString(meta.repo_path) ||
      optionalString(meta.repo);
    if (fromMeta) return fromMeta;
  }
  const prdPath = optionalString(prd.prdPath);
  if (!prdPath) return null;
  const normalized = prdPath.replace(/\\/g, '/');
  if (/\/prd\.json$/i.test(normalized)) {
    return normalized.replace(/\/prd\.json$/i, '');
  }
  const idx = normalized.lastIndexOf('/');
  return idx > 0 ? normalized.slice(0, idx) : normalized;
}

/** Preview / deploy URL only when present (never invent). */
export function resolvePreviewUrl(prd: StatusPrdInput | null | undefined): string | null {
  if (!prd) return null;
  const direct = optionalString(prd.previewUrl);
  if (direct) return direct;
  const meta = asRecord(prd.metadata);
  if (!meta) return null;
  return (
    optionalString(meta.previewUrl) ||
    optionalString(meta.preview_url) ||
    optionalString(meta.deployUrl) ||
    optionalString(meta.deploy_url) ||
    optionalString(meta.url)
  );
}

export function computeStoryRollup(
  project: StatusProjectInput,
  prd: StatusPrdInput | null | undefined,
): StoryRollup {
  const stories = prd?.userStories ?? [];
  if (stories.length > 0) {
    const total = stories.length;
    const complete = stories.filter((s) => s.passes === true).length;
    const percent = total > 0 ? Math.round((complete / total) * 100) : 0;
    return {
      complete,
      total,
      label: `stories ${complete}/${total}`,
      percent,
    };
  }
  const total = Math.max(0, project.storiesTotal ?? 0);
  const complete = Math.max(0, Math.min(total, project.storiesComplete ?? 0));
  const percent = total > 0 ? Math.round((complete / total) * 100) : 0;
  return {
    complete,
    total,
    label: total > 0 ? `stories ${complete}/${total}` : 'stories 0/0',
    percent,
  };
}

function normalizeAgentStatus(status: string | null | undefined): AgentLiveStatus {
  const s = (status ?? '').toLowerCase();
  if (s === 'running') return 'running';
  if (s === 'awaiting_input') return 'awaiting_input';
  if (s === 'ended') return 'ended';
  return 'idle';
}

function isAgentMember(m: StatusMemberInput): boolean {
  if (m.isAgent === true) return true;
  const uid = (m.personUid ?? '').toLowerCase();
  if (uid.startsWith('agent:') || uid.startsWith('agt_')) return true;
  const role = (m.role ?? '').toLowerCase();
  return role === 'agent' || role === 'bot';
}

function memberDisplayName(m: StatusMemberInput): string {
  return (
    m.displayName?.trim() ||
    m.email?.trim() ||
    m.personUid.trim() ||
    'Unknown'
  );
}

/**
 * Build a live agent status row for one matched session.
 * Progress falls back to project story rollup when the session has no percent.
 */
export function liveAgentRowFromSession(
  session: StatusSessionInput,
  rollup: StoryRollup,
  firstOpenStoryId: string | null,
): LiveAgentStatusRow {
  const status = normalizeAgentStatus(session.status);
  const storyId =
    extractStoryId(session.storyId, session.project, session.cwd, session.source) ||
    firstOpenStoryId;
  const progress =
    typeof session.progressPercent === 'number' &&
    Number.isFinite(session.progressPercent)
      ? Math.max(0, Math.min(100, Math.round(session.progressPercent)))
      : rollup.percent;
  const verb =
    status === 'running'
      ? 'running'
      : status === 'awaiting_input'
        ? 'awaiting input'
        : status === 'ended'
          ? 'ended'
          : 'idle';
  const storyPart = storyId ? ` · ${storyId}` : '';
  const label = `Agent ${verb}${storyPart} · ${progress}%`;
  const displayName =
    [session.tool, session.model].filter(Boolean).join(' · ') ||
    session.project ||
    'Agent';
  return {
    id: `${session.tool || 'agent'}:${session.cwd || session.project || displayName}:${session.startedAt || ''}`,
    label,
    storyId,
    progressPercent: progress,
    status,
    tool: session.tool ?? null,
    displayName,
  };
}

/** First non-passing story id from the PRD (for labeling live agents). */
export function firstOpenStoryId(prd: StatusPrdInput | null | undefined): string | null {
  const stories = prd?.userStories ?? [];
  for (const s of stories) {
    if (s.passes === true) continue;
    const id = (s.id ?? '').trim();
    if (id) return id.toUpperCase().startsWith('US') ? id : id;
  }
  return stories[0]?.id?.trim() || null;
}

/**
 * Build the full status popover model.
 */
export function buildChannelStatusModel(input: BuildChannelStatusInput): ChannelStatusModel {
  const prd = input.prd ?? null;
  const rollup = computeStoryRollup(input.project, prd);
  const openStory = firstOpenStoryId(prd);

  const matchedSessions = (input.sessions ?? []).filter((session) =>
    sessionMatchesProject(session, {
      id: input.project.id,
      name: input.project.name ?? input.project.title ?? input.project.id,
      title: input.project.title ?? input.project.name ?? input.project.id,
      prdPath: input.project.prdPath ?? prd?.prdPath ?? '',
      company: input.project.company ?? '',
    }),
  );

  const liveAgents = matchedSessions
    .filter((s) => isPortfolioLiveStatus(s.status))
    .map((s) => liveAgentRowFromSession(s, rollup, openStory));

  // Status map for agent roster rows (running if any live session matches name/uid).
  const liveByKey = new Set<string>();
  for (const s of matchedSessions) {
    if (!isPortfolioLiveStatus(s.status)) continue;
    if (s.personUid) liveByKey.add(s.personUid);
    liveByKey.add((s.tool || '').toLowerCase());
    liveByKey.add((s.project || '').toLowerCase());
  }

  const humans: StatusPersonRow[] = [];
  const agents: StatusPersonRow[] = [];
  for (const m of input.members ?? []) {
    const row: StatusPersonRow = {
      personUid: m.personUid,
      displayName: memberDisplayName(m),
      role: m.role?.trim() || null,
      statusIcon: 'idle',
    };
    if (isAgentMember(m)) {
      const running =
        liveByKey.has(m.personUid) ||
        liveByKey.has(memberDisplayName(m).toLowerCase());
      row.statusIcon = running ? 'running' : 'idle';
      agents.push(row);
    } else {
      humans.push(row);
    }
  }

  // Agents present only as live sessions (not yet in roster) still appear under AGENTS.
  for (const live of liveAgents) {
    if (agents.some((a) => a.displayName === live.displayName)) continue;
    agents.push({
      personUid: live.id,
      displayName: live.displayName,
      role: 'agent',
      statusIcon: live.status === 'running' || live.status === 'awaiting_input' ? 'running' : 'idle',
    });
  }

  humans.sort((a, b) => a.displayName.localeCompare(b.displayName));
  agents.sort((a, b) => a.displayName.localeCompare(b.displayName));

  const memberCount =
    (input.members?.length ?? 0) > 0
      ? input.members!.length
      : humans.length + agents.length;

  return {
    liveAgents,
    stories: rollup,
    project: {
      branch: optionalString(prd?.branchName) || null,
      repo: resolveRepoPath(prd),
      previewUrl: resolvePreviewUrl(prd),
    },
    members: humans,
    agents,
    memberCount,
    companyLabel: input.companyLabel?.trim() || null,
  };
}

/**
 * Resolve the header member-pill count after a status refresh.
 *
 * Only a real roster fetch (fetchedMemberCount > 0) may update the pill; when
 * the roster call failed or returned empty the status model was built from
 * fixture members, and adopting its count would make the pill drift away from
 * the channel-metadata count (e.g. 6 → 5) just from opening the popover.
 */
export function resolveMemberPillCount(
  fetchedMemberCount: number,
  model: Pick<ChannelStatusModel, 'memberCount'>,
  previousCount: number | null,
): number | null {
  return fetchedMemberCount > 0 ? model.memberCount : previousCount;
}

/** Header title pieces for a project channel (Daybook: `# name` + dim subtitle). */
export function projectChannelHeaderParts(
  channelName: string,
  companyLabel: string | null | undefined,
): { title: string; subtitle: string } {
  const name = channelName.trim().replace(/^#+/, '') || 'channel';
  const company = companyLabel?.trim() || 'Company';
  return { title: `# ${name}`, subtitle: `${company} · project channel` };
}

/** Combined header string — kept for callers that still want one line. */
export function projectChannelHeaderTitle(
  channelName: string,
  companyLabel: string | null | undefined,
): string {
  const { title, subtitle } = projectChannelHeaderParts(channelName, companyLabel);
  return `${title} · ${subtitle}`;
}

/** Visual-QA fixture members + agents (D-06). */
export const CHANNEL_STATUS_FIXTURE_MEMBERS: StatusMemberInput[] = [
  { personUid: 'prs_ada', displayName: 'Ada Lovelace', role: 'owner' },
  { personUid: 'prs_marcus', displayName: 'Marcus Chen', role: 'member' },
  { personUid: 'prs_corey', displayName: 'Corey', role: 'member' },
  { personUid: 'agt_claude', displayName: 'Claude', role: 'agent', isAgent: true },
  { personUid: 'agt_codex', displayName: 'Codex', role: 'agent', isAgent: true },
];

export const CHANNEL_STATUS_FIXTURE_PRD: StatusPrdInput = {
  name: 'HQ Desktop',
  branchName: 'feat/v2-chat-shell',
  repoPath: 'companies/indigo/projects/hq-desktop-app',
  previewUrl: 'https://preview.example/hq-desktop',
  userStories: [
    { id: 'US-001', passes: true },
    { id: 'US-002', passes: true },
    { id: 'US-003', passes: false },
    { id: 'US-004', passes: false },
  ],
};
