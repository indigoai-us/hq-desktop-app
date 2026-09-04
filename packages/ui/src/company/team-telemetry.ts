/**
 * Team telemetry adapter — pure normalization for company Team surface.
 * Wire payload mirrors hq-console / hq-pro GET /v1/telemetry/company (+ optional outcomes).
 *
 * DESKTOP-009: mixed humans + agents in one scan-friendly list; kind labels are
 * honest type markers (Human / Agent). Never invent live status or activity.
 */

export type TeamMemberKind = "human" | "agent";

export interface TeamSkillUsage {
  skill: string;
  count: number;
}

export interface TeamMember {
  id: string;
  displayName: string;
  /** Resolved contact email when available. */
  email?: string;
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
  name?: string | null;
}

export function memberKindFromUid(uid: string): TeamMemberKind {
  const id = uid.trim().toLowerCase();
  if (id.startsWith("agt_") || id.startsWith("agent_")) return "agent";
  return "human";
}

/** Honest type label for list/detail chips — not a live status indicator. */
export function memberKindLabel(kind: TeamMemberKind): string {
  return kind === "agent" ? "Agent" : "Human";
}

/**
 * Role/type line for list meta. Prefer a real payload role when present;
 * otherwise fall back to the kind label only — never invent admin/owner/etc.
 */
export function memberTypeRoleLabel(
  member: Pick<TeamMember, "kind" | "role">,
): string {
  const role = (member.role ?? "").trim();
  if (role) return role;
  return memberKindLabel(member.kind);
}

export function displayNameFromMember(
  raw: {
    personUid?: string;
    email?: string;
    displayName?: string;
    name?: string;
  },
  resolved?: TeamMemberLabel,
): string {
  const name = (
    raw.displayName ||
    raw.name ||
    resolved?.displayName ||
    resolved?.name ||
    ""
  ).trim();
  if (name) return name;
  const email = (raw.email || resolved?.email || "").trim();
  if (email) return email;
  const sourceUid = (raw.personUid ?? "").trim();
  if (sourceUid) return sourceUid;
  return "Identity unavailable";
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * The production telemetry response already includes display-safe identities
 * keyed by source UID. Read that authoritative enrichment before consulting
 * the separate contacts response.
 */
function telemetryMemberLabel(
  value: unknown,
  personUid: string,
): TeamMemberLabel | undefined {
  if (!value || typeof value !== "object") return undefined;
  const identities = value as Record<string, unknown>;
  for (const groupName of ["persons", "agents"] as const) {
    const group = identities[groupName];
    if (!group || typeof group !== "object") continue;
    const row = (group as Record<string, unknown>)[personUid];
    if (!row || typeof row !== "object") continue;
    const identity = row as Record<string, unknown>;
    return {
      displayName:
        trimmedString(identity.displayName) ?? trimmedString(identity.name),
      email: trimmedString(identity.email),
    };
  }
  return undefined;
}

function mergedMemberLabel(
  primary: TeamMemberLabel | undefined,
  secondary: TeamMemberLabel | undefined,
): TeamMemberLabel | undefined {
  const displayName =
    trimmedString(primary?.displayName) ??
    trimmedString(primary?.name) ??
    trimmedString(secondary?.displayName) ??
    trimmedString(secondary?.name);
  const email =
    trimmedString(primary?.email) ?? trimmedString(secondary?.email);
  if (!displayName && !email) return undefined;
  return { displayName, email };
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Production company telemetry returns a raw skill-count record. Older
 * harnesses and console-shaped payloads used `{ bySkill: [{ skill, count }] }`.
 * Accept both at this boundary so the view model stays stable.
 */
function skillListFromValue(value: unknown): TeamSkillUsage[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const source = record.bySkill ?? value;
  let usages: TeamSkillUsage[] = [];

  if (Array.isArray(source)) {
    usages = source
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const r = row as { skill?: unknown; count?: unknown };
        const skill = typeof r.skill === "string" ? r.skill.trim() : "";
        const count = finiteNumber(r.count);
        if (!skill || count == null) return null;
        return { skill, count };
      })
      .filter((item): item is TeamSkillUsage => item !== null);
  } else if (source && typeof source === "object") {
    usages = Object.entries(source as Record<string, unknown>)
      .map(([skill, countValue]) => {
        const count = finiteNumber(countValue);
        if (!skill.trim() || count == null) return null;
        return { skill: skill.trim(), count };
      })
      .filter((item): item is TeamSkillUsage => item !== null);
  }

  return usages
    .sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill))
    .slice(0, 5);
}

function activeProjectList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (!item || typeof item !== "object") return "";
      const row = item as { title?: unknown; name?: unknown };
      if (typeof row.title === "string") return row.title.trim();
      if (typeof row.name === "string") return row.name.trim();
      return "";
    })
    .filter((name): name is string => name.length > 0);
}

function memberRank(m: TeamMember): number {
  return (m.sessions ?? 0) * 1000 + (m.events ?? 0);
}

function sortMembers(list: TeamMember[]): TeamMember[] {
  return [...list].sort(
    (a, b) =>
      memberRank(b) - memberRank(a) ||
      a.displayName.localeCompare(b.displayName),
  );
}

/**
 * Telemetry can repeat an exact person UID when a reporting window overlaps.
 * Collapse only that authoritative identity key — never display-name/email —
 * so two real people who share a name remain separate. Counts use the maximum
 * observed value rather than summing duplicate snapshots.
 */
function mergeDuplicateMember(
  existing: TeamMember,
  incoming: TeamMember,
): TeamMember {
  const skillCounts = new Map(
    existing.topSkills.map((skill) => [skill.skill, skill.count]),
  );
  for (const skill of incoming.topSkills) {
    skillCounts.set(
      skill.skill,
      Math.max(skillCounts.get(skill.skill) ?? 0, skill.count),
    );
  }

  const maxDefined = (
    a: number | undefined,
    b: number | undefined,
  ): number | undefined => {
    if (a == null) return b;
    if (b == null) return a;
    return Math.max(a, b);
  };

  return {
    ...existing,
    displayName:
      (existing.displayName === existing.id ||
        existing.displayName === "Identity unavailable") &&
      incoming.displayName !== incoming.id &&
      incoming.displayName !== "Identity unavailable"
        ? incoming.displayName
        : existing.displayName,
    email: existing.email ?? incoming.email,
    role: existing.role ?? incoming.role,
    topSkills: Array.from(skillCounts, ([skill, count]) => ({ skill, count }))
      .sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill))
      .slice(0, 5),
    activeProjects: Array.from(
      new Set([...existing.activeProjects, ...incoming.activeProjects]),
    ),
    events: maxDefined(existing.events, incoming.events),
    sessions: maxDefined(existing.sessions, incoming.sessions),
  };
}

/**
 * Normalize a company telemetry JSON body into a mixed member list with kind
 * labels and top skills. Production uses `members` with top-level `skills`,
 * `events`, and `distinctSessions`; the legacy console/harness shape used
 * `perMember` with a nested `totals` object.
 *
 * Presence is never derived here: `online` / `isOnline` / `lastSeen` / presence
 * from timestamps or event counts belong to the presence store (US-015), not
 * team telemetry.
 */
export function normalizeCompanyTeamTelemetry(
  payload: unknown,
  options?: {
    activeProjectsByMemberId?: Record<string, string[]>;
    memberLabelsById?: Record<string, TeamMemberLabel>;
  },
): TeamTelemetryView {
  if (!payload || typeof payload !== "object") {
    return { members: [], humans: [], agents: [], error: null, empty: true };
  }
  const o = payload as Record<string, unknown>;
  const rawMembers = o.perMember ?? o.members;
  if (!Array.isArray(rawMembers)) {
    return { members: [], humans: [], agents: [], error: null, empty: true };
  }

  const projectsMap = options?.activeProjectsByMemberId ?? {};
  const membersById = new Map<string, TeamMember>();

  for (const row of rawMembers) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const personUid =
      typeof r.personUid === "string"
        ? r.personUid
        : typeof r.id === "string"
          ? r.id
          : "";
    if (!personUid) continue;
    const kind =
      typeof r.kind === "string" && (r.kind === "agent" || r.kind === "human")
        ? (r.kind as TeamMemberKind)
        : memberKindFromUid(personUid);
    const roleRaw =
      typeof r.role === "string"
        ? r.role
        : typeof r.membershipRole === "string"
          ? r.membershipRole
          : "";
    const role = roleRaw.trim() || undefined;
    const resolvedLabel = mergedMemberLabel(
      telemetryMemberLabel(o.identities, personUid),
      options?.memberLabelsById?.[personUid],
    );
    const emailRaw =
      typeof r.email === "string"
        ? r.email
        : typeof resolvedLabel?.email === "string"
          ? resolvedLabel.email
          : "";
    const email = emailRaw.trim() || undefined;
    const totals =
      r.totals && typeof r.totals === "object"
        ? (r.totals as Record<string, unknown>)
        : undefined;
    const member: TeamMember = {
      id: personUid,
      displayName: displayNameFromMember(
        {
          personUid,
          email,
          displayName:
            typeof r.displayName === "string" ? r.displayName : undefined,
          name: typeof r.name === "string" ? r.name : undefined,
        },
        resolvedLabel,
      ),
      email,
      kind,
      role,
      topSkills: skillListFromValue(r.skills ?? totals?.skills),
      activeProjects:
        projectsMap[personUid] ?? activeProjectList(r.activeProjects),
      events: finiteNumber(r.events ?? totals?.events),
      sessions: finiteNumber(r.distinctSessions ?? totals?.distinctSessions),
    };
    const existing = membersById.get(personUid);
    membersById.set(
      personUid,
      existing ? mergeDuplicateMember(existing, member) : member,
    );
  }

  const normalizedMembers = Array.from(membersById.values());
  const humans = normalizedMembers.filter((member) => member.kind === "human");
  const agents = normalizedMembers.filter((member) => member.kind === "agent");
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
  if (
    lower.includes("403") ||
    lower.includes("forbidden") ||
    lower.includes("not permitted")
  ) {
    return "Team telemetry requires company owner or permitted admin access.";
  }
  if (
    lower.includes("401") ||
    lower.includes("auth") ||
    lower.includes("unauthorized")
  ) {
    return "Sign in again to load team telemetry.";
  }
  if (lower.includes("network") || lower.includes("fetch")) {
    return "Could not reach telemetry service. Check your connection and retry.";
  }
  return text || "Failed to load team telemetry.";
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
