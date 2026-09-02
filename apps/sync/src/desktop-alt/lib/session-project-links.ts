// Project channels ↔ sessions — the pure half of the host's sidebar decoration.
//
// The Rust command `session_project_links(company)` joins a company's projects
// with their channels and the sessions bound to them. This module turns that
// into what the HQ Work shell's `rowExtras` seam wants per sidebar row: a
// "N sessions" badge, a hover card, and a "New session" action — and it owns
// the two conventions both sides of the boundary rely on: the project
// directory slug (the binding key) and the `new?…` route param that pre-binds
// a fresh chat to a company + project.

import { invoke } from '@tauri-apps/api/core';
import type { ConversationRow, ConversationRowExtras } from '@hq/ui';

import type { ProjectEntry } from '../../components/sessions/startwork';

/** One session bound to a project (Rust `LinkedSession`). */
export interface LinkedSession {
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
export function loadSessionProjectLinks(company: string): Promise<ProjectLink[]> {
  return invoke<ProjectLink[]>('session_project_links', { company });
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
    if (byProject) return byProject;
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
  return count === 1 ? '1 session' : `${count} sessions`;
}

// ---------------------------------------------------------------------------
// The `new?…` route param
// ---------------------------------------------------------------------------

/** The Sessions page param that pre-binds a fresh chat to a company + project. */
export function newSessionParam(company: string, project: string | null): string {
  const query = new URLSearchParams();
  query.set('company', company);
  if (project?.trim()) query.set('project', project.trim());
  return `new?${query.toString()}`;
}

/** The chosen row extras for a project row, or null for any other row. */
export function rowExtrasFor(
  row: ConversationRow,
  links: ProjectLink[],
  hoverCard: ConversationRowExtras['hoverCard'],
  onnewsession: (link: ProjectLink) => void,
): ConversationRowExtras | null {
  const link = linkForRow(row, links);
  if (!link) return null;
  const badge = sessionsBadge(link);
  return {
    badge,
    hoverCard: badge ? hoverCard : null,
    actions: [{ id: 'new-session', label: 'New session', onselect: () => onnewsession(link) }],
  };
}
