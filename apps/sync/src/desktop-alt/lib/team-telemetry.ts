/**
 * Team telemetry adapter — pure normalization for company Team surface.
 * Wire payload mirrors hq-console / hq-pro GET /v1/telemetry/company (+ optional outcomes).
 *
 * DESKTOP-009: mixed humans + agents in one scan-friendly list; kind labels are
 * honest type markers (Human / Agent). Never invent live status or activity.
 */

export type TeamMemberKind = 'human' | 'agent';

export interface TeamSkillUsage {
  skill: string;
  count: number;
}

export interface TeamMember {
  id: string;
  displayName: string;
  kind: TeamMemberKind;
  /** Company membership role when the payload provides it — never invented. */
  role?: string;
  topSkills: TeamSkillUsage[];
  /** Active project names when known (from outcomes / local board join). */
  activeProjects: string[];
  events?: number;
  sessions?: number;
}

export interface TeamTelemetryView {
  /** Unified scan list — humans and agents together, ranked. */
  members: TeamMember[];
  /** Partition of `members` for callers that still need kind splits. */
  humans: TeamMember[];
  agents: TeamMember[];
  /** Permission / network error message for the UI; empty when ok. */
  error: string | null;
  /** True when the payload loaded but both lists are empty. */
  empty: boolean;
}

export interface TeamMemberLabel {
  email?: string | null;
  displayName?: string | null;
}

export function memberKindFromUid(uid: string): TeamMemberKind {
  const id = uid.trim().toLowerCase();
  if (id.startsWith('agt_') || id.startsWith('agent_')) return 'agent';
  return 'human';
}

/** Honest type label for list/detail chips — not a live status indicator. */
export function memberKindLabel(kind: TeamMemberKind): string {
  return kind === 'agent' ? 'Agent' : 'Human';
}

/**
 * Role/type line for list meta. Prefer a real payload role when present;
 * otherwise fall back to the kind label only — never invent admin/owner/etc.
 */
export function memberTypeRoleLabel(member: Pick<TeamMember, 'kind' | 'role'>): string {
  const role = (member.role ?? '').trim();
  if (role) return role;
  return memberKindLabel(member.kind);
}

export function displayNameFromMember(raw: {
  personUid?: string;
  email?: string;
  displayName?: string;
  name?: string;
}, resolved?: TeamMemberLabel): string {
  const name = (raw.displayName || raw.name || resolved?.displayName || '').trim();
  if (name) return name;
  const email = (raw.email || resolved?.email || '').trim();
  if (email) return email;
  return 'Unknown member';
}

function skillListFromTotals(totals: unknown): TeamSkillUsage[] {
  if (!totals || typeof totals !== 'object') return [];
  const skills = (totals as { skills?: { bySkill?: unknown } }).skills;
  const bySkill = skills?.bySkill;
  if (!Array.isArray(bySkill)) return [];
  return bySkill
    .map((row) => {
      if (!row || typeof row !== 'object') return null;
      const r = row as { skill?: unknown; count?: unknown };
      const skill = typeof r.skill === 'string' ? r.skill : '';
      const count = typeof r.count === 'number' ? r.count : Number(r.count) || 0;
      if (!skill) return null;
      return { skill, count };
    })
    .filter((x): x is TeamSkillUsage => x !== null)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

function activeProjectList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (!item || typeof item !== 'object') return '';
      const row = item as { title?: unknown; name?: unknown };
      if (typeof row.title === 'string') return row.title.trim();
      if (typeof row.name === 'string') return row.name.trim();
      return '';
    })
    .filter((name): name is string => name.length > 0);
}

function memberRank(m: TeamMember): number {
  return (m.sessions ?? 0) * 1000 + (m.events ?? 0);
}

function sortMembers(list: TeamMember[]): TeamMember[] {
  return [...list].sort(
    (a, b) => memberRank(b) - memberRank(a) || a.displayName.localeCompare(b.displayName),
  );
}

/**
 * Normalize a company telemetry JSON body into a mixed member list with kind
 * labels and top skills. Accepts both `perMember` and `members` array keys
 * (console/hq-pro variants).
 */
export function normalizeCompanyTeamTelemetry(
  payload: unknown,
  options?: {
    activeProjectsByMemberId?: Record<string, string[]>;
    memberLabelsById?: Record<string, TeamMemberLabel>;
  },
): TeamTelemetryView {
  if (!payload || typeof payload !== 'object') {
    return { members: [], humans: [], agents: [], error: null, empty: true };
  }
  const o = payload as Record<string, unknown>;
  const rawMembers = o.perMember ?? o.members;
  if (!Array.isArray(rawMembers)) {
    return { members: [], humans: [], agents: [], error: null, empty: true };
  }

  const projectsMap = options?.activeProjectsByMemberId ?? {};
  const humans: TeamMember[] = [];
  const agents: TeamMember[] = [];

  for (const row of rawMembers) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const personUid =
      typeof r.personUid === 'string' ? r.personUid : typeof r.id === 'string' ? r.id : '';
    if (!personUid) continue;
    const kind =
      typeof r.kind === 'string' && (r.kind === 'agent' || r.kind === 'human')
        ? (r.kind as TeamMemberKind)
        : memberKindFromUid(personUid);
    const roleRaw =
      typeof r.role === 'string'
        ? r.role
        : typeof r.membershipRole === 'string'
          ? r.membershipRole
          : '';
    const role = roleRaw.trim() || undefined;
    const member: TeamMember = {
      id: personUid,
      displayName: displayNameFromMember(
        {
          personUid,
          email: typeof r.email === 'string' ? r.email : undefined,
          displayName: typeof r.displayName === 'string' ? r.displayName : undefined,
          name: typeof r.name === 'string' ? r.name : undefined,
        },
        options?.memberLabelsById?.[personUid],
      ),
      kind,
      role,
      topSkills: skillListFromTotals(r.totals),
      activeProjects: projectsMap[personUid] ?? activeProjectList(r.activeProjects),
      events:
        typeof (r.totals as { events?: number } | undefined)?.events === 'number'
          ? (r.totals as { events: number }).events
          : undefined,
      sessions:
        typeof (r.totals as { distinctSessions?: number } | undefined)?.distinctSessions ===
        'number'
          ? (r.totals as { distinctSessions: number }).distinctSessions
          : undefined,
    };
    if (kind === 'agent') agents.push(member);
    else humans.push(member);
  }

  const sortedHumans = sortMembers(humans);
  const sortedAgents = sortMembers(agents);
  // One ranked list — humans and agents interleaved by activity, not tabs.
  const members = sortMembers([...sortedHumans, ...sortedAgents]);

  return {
    members,
    humans: sortedHumans,
    agents: sortedAgents,
    error: null,
    empty: members.length === 0,
  };
}

/** Map HTTP-ish errors from the Tauri command into UI copy. */
export function teamTelemetryErrorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const lower = text.toLowerCase();
  if (lower.includes('403') || lower.includes('forbidden') || lower.includes('not permitted')) {
    return 'Team telemetry requires company owner or permitted admin access.';
  }
  if (lower.includes('401') || lower.includes('auth') || lower.includes('unauthorized')) {
    return 'Sign in again to load team telemetry.';
  }
  if (lower.includes('network') || lower.includes('fetch')) {
    return 'Could not reach telemetry service. Check your connection and retry.';
  }
  return text || 'Failed to load team telemetry.';
}

/** ISO date YYYY-MM-DD for range queries (UTC). */
export function isoDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function defaultTelemetryRange(days = 30): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: isoDay(from), to: isoDay(to) };
}
