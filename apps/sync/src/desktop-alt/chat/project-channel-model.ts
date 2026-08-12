/**
 * Pure model for the project-channel create flow (US-005).
 *
 * No Svelte / Tauri — unit-tested. Builds default names, create payloads, and
 * merges human invites with agents assigned to a local project.
 */

import type { Project } from '../lib/projects-model';
import {
  sessionMatchesProject,
  type PortfolioSessionRef,
} from '../lib/projects-model';

/** Local project row as shown in the create-flow picker. */
export interface ProjectPickerRow {
  id: string;
  title: string;
  company: string;
  prdPath: string;
  /** Display subtitle: company slug. */
  subtitle: string;
}

/** Agent participant auto-seeded from project assignment / live sessions. */
export interface ProjectAgentInvite {
  /** Invite identity — personUid when known, else `agent:<sessionId>`. */
  personUid: string;
  displayName: string;
  /** `running` | `idle` | … — best-effort from sessions. */
  status: string;
  source: 'session' | 'assignment';
}

/** Inputs for building the create_channel invoke payload. */
export interface CreateProjectChannelInput {
  name: string;
  projectId: string;
  companyUid: string;
  /** Human personUids from RecipientPicker. */
  humanInviteUids: readonly string[];
  /** Agent personUids auto-included for the project. */
  agentInviteUids: readonly string[];
}

/** Wire payload for `invoke('create_channel', …)`. */
export interface CreateProjectChannelPayload {
  name: string;
  scope: 'project';
  companyUid: string;
  projectId: string;
  invite: string[];
}

/** Map a local Project into a picker row. */
export function toProjectPickerRow(
  project: Pick<Project, 'id' | 'title' | 'name' | 'company' | 'prdPath'>,
): ProjectPickerRow {
  const title = (project.title || project.name || project.id).trim() || project.id;
  const company = (project.company ?? '').trim() || 'company';
  return {
    id: project.id,
    title,
    company,
    prdPath: project.prdPath ?? '',
    subtitle: company,
  };
}

/** Default channel name from a local project (slug-friendly, no leading #). */
export function defaultChannelNameFromProject(
  project: Pick<Project, 'id' | 'title' | 'name'>,
): string {
  const raw = (project.title || project.name || project.id).trim();
  if (!raw) return 'project';
  return raw
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'project';
}

/**
 * Resolve companyUid for a local project slug against the caller's workspaces.
 * Returns null when the company is not cloud-linked (cannot create a project
 * channel without a companyUid).
 */
export function resolveCompanyUidForProject(
  companySlug: string,
  workspaces: ReadonlyArray<{ slug: string; cloudUid?: string | null; kind?: string }>,
): string | null {
  const slug = companySlug.trim().toLowerCase();
  if (!slug) return null;
  const match = workspaces.find(
    (w) =>
      (w.kind == null || w.kind === 'company') &&
      w.slug.trim().toLowerCase() === slug &&
      !!w.cloudUid?.trim(),
  );
  return match?.cloudUid?.trim() || null;
}

/**
 * Agents assigned to / running on a project. Prefer explicit assignment uids;
 * otherwise derive from live sessions matched to the project.
 */
export function agentsForProject(
  project: Pick<Project, 'id' | 'name' | 'title' | 'prdPath' | 'company'>,
  sessions: readonly PortfolioSessionRef[],
  assignedAgentUids: readonly string[] = [],
): ProjectAgentInvite[] {
  const byUid = new Map<string, ProjectAgentInvite>();

  for (const uid of assignedAgentUids) {
    const personUid = uid.trim();
    if (!personUid) continue;
    byUid.set(personUid, {
      personUid,
      displayName: personUid.startsWith('agent:')
        ? personUid.slice('agent:'.length)
        : personUid,
      status: 'idle',
      source: 'assignment',
    });
  }

  for (const session of sessions) {
    if (!sessionMatchesProject(session, project)) continue;
    const personUid =
      (typeof (session as { personUid?: string }).personUid === 'string' &&
        (session as { personUid?: string }).personUid?.trim()) ||
      `agent:${session.tool || 'agent'}:${session.cwd || session.project || 'session'}`
        .replace(/\s+/g, '-')
        .slice(0, 120);
    const status = (session.status ?? 'idle').toLowerCase();
    const displayName =
      [session.tool, session.model].filter(Boolean).join(' · ') ||
      session.project ||
      'Agent';
    const existing = byUid.get(personUid);
    if (existing) {
      // Prefer live status over assignment-idle.
      if (status === 'running' || status === 'awaiting_input') {
        byUid.set(personUid, {
          ...existing,
          status,
          displayName: existing.source === 'assignment' ? displayName : existing.displayName,
        });
      }
      continue;
    }
    byUid.set(personUid, {
      personUid,
      displayName,
      status,
      source: 'session',
    });
  }

  return [...byUid.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );
}

/** Deduped invite list: humans first, then agents. */
export function mergeInviteUids(
  humanUids: readonly string[],
  agentUids: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...humanUids, ...agentUids]) {
    const uid = raw.trim();
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    out.push(uid);
  }
  return out;
}

/** Build the create_channel payload. Throws-free: returns null when invalid. */
export function buildCreateProjectChannelPayload(
  input: CreateProjectChannelInput,
): CreateProjectChannelPayload | null {
  const name = input.name.trim().replace(/^#+/, '');
  const projectId = input.projectId.trim();
  const companyUid = input.companyUid.trim();
  if (!name || !projectId || !companyUid) return null;
  return {
    name,
    scope: 'project',
    companyUid,
    projectId,
    invite: mergeInviteUids(input.humanInviteUids, input.agentInviteUids),
  };
}

/** Case-insensitive filter for the project picker. */
export function filterProjectPickerRows(
  rows: readonly ProjectPickerRow[],
  query: string,
): ProjectPickerRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows.slice();
  return rows.filter(
    (row) =>
      row.title.toLowerCase().includes(q) ||
      row.company.toLowerCase().includes(q) ||
      row.id.toLowerCase().includes(q),
  );
}

/** True when the channel wire shape is a project channel. */
export function isProjectChannel(channel: {
  scope?: string | null;
  projectId?: string | null;
}): boolean {
  if ((channel.scope ?? '').toLowerCase() === 'project') return true;
  return !!channel.projectId?.trim();
}
