// Project channels ↔ sessions — the pure half of the host's sidebar decoration.
//
// The Rust command `session_project_links(company)` joins a company's projects
// with their channels and the sessions bound to them. This module turns that
// into what the HQ Work shell's `rowExtras` seam wants per sidebar row: a
// a compact count badge, a hover card, and a "New session" action — and it owns
// the two conventions both sides of the boundary rely on: the project
// directory slug (the binding key) and the `new?…` route param that pre-binds
// a fresh chat to a company + project.

import { invoke } from '@tauri-apps/api/core';
import type {
  ConversationRow,
  ConversationRowChild,
  ConversationRowExtras,
} from '@hq/ui';

import type { ProjectEntry } from '../../components/sessions/startwork';

/** One session bound to a project (Rust `LinkedSession`). */
export interface LinkedSession {
  /** Present only for someone else's shared, read-only conversation. */
  sharedChannelId?: string;
  sessionId: string;
  /** `claude` | `codex`. */
  tool: string;
  /** `starting` | `idle` | `working` | `needsYou` | `ended`. */
  phase: string;
  /** ISO-8601 UTC. */
  startedAt: string;
  title?: string;
}

/** One project with its channel and sessions (Rust `ProjectLink`). */
export interface ProjectLink {
  /** The project directory slug — the binding key. */
  project: string;
  projectName: string;
  projectPath: string;
  channelId?: string;
  channelName?: string;
  sessions: LinkedSession[];
}

/** Payload of `agent-session:project-created` (Rust `ProjectCreated`). */
export interface ProjectCreatedNotice {
  sessionId: string;
  company: string;
  project: string;
  projectPath: string;
}

export const PROJECT_CREATED_EVENT = 'agent-session:project-created';

/** Window event the Sessions page raises once a project channel is linked. */
export const PROJECT_CHANNEL_LINKED_EVENT = 'hq:project-channel-linked';

export interface ProjectChannelLinked {
  company: string;
  project: string;
  channelId: string;
  channelName: string;
}

/** `session_project_links` — read-only; cached 10 s on the Rust side. */
export function loadSessionProjectLinks(company: string, localOnly = false): Promise<ProjectLink[]> {
  return invoke<ProjectLink[]>('session_project_links', { company, ...(localOnly ? { localOnly: true } : {}) });
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** The project directory slug: the last non-empty path component. */
export function projectSlug(path: string): string {
  const parts = path.split(/[/\\]/).filter((part) => part.trim().length > 0);
  return (parts[parts.length - 1] ?? '').trim();
}

/** The slug for the composer's project pick (a prd NAME), when it is known. */
export function projectSlugFor(projects: ProjectEntry[], name: string | null): string | null {
  const wanted = name?.trim();
  if (!wanted) return null;
  const entry = projects.find((row) => row.name === wanted);
  return entry ? projectSlug(entry.path) || null : wanted;
}

/** The composer's pick (a prd NAME) for a slug, once the project list is in. */
export function projectNameFor(projects: ProjectEntry[], slug: string | null): string | null {
  const wanted = slug?.trim().toLowerCase();
  if (!wanted) return null;
  const bySlug = projects.find((row) => projectSlug(row.path).toLowerCase() === wanted);
  if (bySlug) return bySlug.name;
  const byName = projects.find((row) => row.name.trim().toLowerCase() === wanted);
  return byName?.name ?? null;
}

/** Same rule as Rust `slugify` + `project_channel_name`: `p-<slug>`. */
export function conventionalChannelName(slug: string): string {
  const cleaned = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned ? `p-${cleaned}` : '';
}

function normalizeChannelName(name: string): string {
  return name.trim().replace(/^#/, '').trim().toLowerCase();
}

/**
 * The project a sidebar row stands for. By channel id first (the join already
 * resolved the channel), then by hq-pro's `projectId`, then by the `p-<slug>`
 * naming convention on the row title.
 */
export function linkForRow(row: ConversationRow, links: ProjectLink[]): ProjectLink | null {
  if (row.kind !== 'channel') return null;
  if (row.channelId) {
    const byId = links.find((link) => link.channelId === row.channelId);
    if (byId) return byId;
  }
  const projectId = row.projectId?.trim().toLowerCase();
  if (projectId) {
    const byProject = links.find(
      (link) =>
        link.project.toLowerCase() === projectId ||
        link.projectName.trim().toLowerCase() === projectId,
    );
    // Project metadata may be shared by several channels. The selected row,
    // not a cached project's previous channel, owns the launch/read scope.
    if (byProject) return row.channelId
      ? { ...byProject, channelId: row.channelId, channelName: row.title }
      : byProject;
  }
  const title = normalizeChannelName(row.title);
  if (!title.startsWith('p-')) return null;
  return (
    links.find(
      (link) => normalizeChannelName(conventionalChannelName(link.project)) === title,
    ) ?? null
  );
}

/** The link for a session's own binding, for the strip's project pill. */
export function linkForProject(links: ProjectLink[], project: string | null): ProjectLink | null {
  const wanted = project?.trim().toLowerCase();
  if (!wanted) return null;
  return (
    links.find(
      (link) =>
        link.project.toLowerCase() === wanted || link.projectName.trim().toLowerCase() === wanted,
    ) ?? null
  );
}

/** Live first is the Rust ordering; this only counts. */
export function sessionsBadge(link: ProjectLink): string | null {
  const count = link.sessions.length;
  if (count === 0) return null;
  const live = link.sessions.filter((session) => session.phase !== 'ended').length;
  if (live > 0) return `${live} live`;
  return String(count);
}

const SESSION_PHASE_LABEL: Record<string, string> = {
  starting: 'Starting',
  idle: 'Idle',
  working: 'Working',
  needsYou: 'Needs you',
  ended: 'Ended',
};

function sessionStatus(phase: string): ConversationRowChild['status'] {
  if (
    phase === 'starting' ||
    phase === 'idle' ||
    phase === 'working' ||
    phase === 'needsYou' ||
    phase === 'ended'
  ) {
    return phase;
  }
  return undefined;
}

function sessionLabel(session: LinkedSession): string {
  const title = session.title?.trim();
  if (title) return title;
  return `${session.tool === 'codex' ? 'Codex' : 'Claude'} session`;
}

// ---------------------------------------------------------------------------
// The Sessions route params
// ---------------------------------------------------------------------------

/** The Sessions page param that pre-binds a fresh chat to a company + project. */
export function newSessionParam(company: string, project: string | null, channelId?: string): string {
  const query = new URLSearchParams();
  query.set('company', company);
  if (project?.trim()) query.set('project', project.trim());
  if (channelId && project?.trim()) query.set('channel', channelId);
  return `new?${query.toString()}`;
}

/**
 * A durable project-linked session carries enough metadata to open history
 * without depending on the separately-scanned provider catalog. That catalog
 * can lag a newly-ended Codex rollout; the project join is already holding the
 * authoritative provider id, tool and title.
 */
export function historySessionParam(
  company: string,
  project: string,
  session: LinkedSession,
): string {
  if (session.sharedChannelId) {
    return `shared?${new URLSearchParams({ channel: session.sharedChannelId, id: session.sessionId })}`;
  }
  // Live rows retain the app-owned id for replay and event subscriptions.
  // Passing it to the provider-history reader produces an empty transcript:
  // only ended rows have been canonicalized to provider-native ids.
  if (session.phase !== 'ended') return session.sessionId;
  const query = new URLSearchParams();
  query.set('id', session.sessionId);
  query.set('tool', session.tool);
  query.set('company', company);
  query.set('project', project);
  if (session.title?.trim()) query.set('title', session.title.trim());
  if (session.startedAt.trim()) query.set('startedAt', session.startedAt.trim());
  return `history?${query.toString()}`;
}

/** The chosen row extras for a project row, or null for any other row. */
export function rowExtrasFor(
  row: ConversationRow,
  links: ProjectLink[],
  hoverCard: ConversationRowExtras['hoverCard'],
  onnewsession: (link: ProjectLink) => void,
  onopensession: (link: ProjectLink, session: LinkedSession) => void,
  selectedSessionId: string | null = null,
  onvisibility?: (link: ProjectLink, visible: boolean) => void,
): ConversationRowExtras | null {
  const link = linkForRow(row, links);
  if (!link) return null;
  const badge = sessionsBadge(link);
  const children: ConversationRowChild[] = [
    ...link.sessions.map((session) => ({
      id: `session:${session.sessionId}`,
      label: sessionLabel(session),
      selected: session.sessionId === selectedSessionId,
      // Ended is the quiet/default state in history. Repeating it on every
      // child makes the compact project sublist read like a status table.
      meta:
        session.phase === 'ended'
          ? null
          : (SESSION_PHASE_LABEL[session.phase] ?? session.phase),
      status: sessionStatus(session.phase),
      kind: 'item' as const,
      onselect: () => onopensession(link, session),
    })),
    {
      id: 'new-session',
      label: 'New session',
      meta: null,
      kind: 'action' as const,
      onselect: () => onnewsession(link),
    },
  ];
  return {
    badge,
    hoverCard: badge ? hoverCard : null,
    actions: [{ id: 'new-session', label: 'New session', onselect: () => onnewsession(link) }],
    children,
    childrenLabel: `Sessions for ${link.projectName}`,
    // Keep populated associations visible, but do not turn every project in a
    // large company into an always-open one-row "New session" tree.
    childrenExpandedByDefault: link.sessions.length > 0,
    ...(onvisibility ? { onChildrenVisibilityChange: (visible: boolean) => onvisibility(link, visible) } : {}),
  };
}
