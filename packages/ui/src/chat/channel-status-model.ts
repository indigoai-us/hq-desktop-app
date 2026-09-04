/**
 * Pure model for the project-channel members / status popover (US-005).
 *
 * Derives live agent rows, story rollup, project metadata, and member lists
 * from local PRD + agent sessions + channel roster — no Tauri, no DOM.
 */

import {
  isPortfolioLiveStatus,
  sessionHasServerBinding,
  type PortfolioSessionRef,
} from "./portfolio-session";

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface StatusStoryInput {
  id: string;
  title?: string;
  passes?: boolean;
}

export interface StatusRepoInput {
  path?: string | null;
  branch?: string | null;
}

export interface StatusPrdInput {
  name?: string;
  branchName?: string | null;
  /** Absolute or HQ-relative repo path when known. */
  repoPath?: string | null;
  /** Multi-repo coordinates from the mesh project view. */
  repos?: StatusRepoInput[] | null;
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
  /** PROJECT_VIEW / PRD blurb shown from the channel-header info control. */
  description?: string | null;
}

export interface StatusMemberInput {
  personUid: string;
  displayName?: string;
  email?: string;
  role?: string;
  /** Presigned avatar URL, when the roster carried one. */
  avatarUrl?: string;
  /** Profile "about" line, when the roster carried one. */
  description?: string;
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

/**
 * Presence snapshot entry for one actor (from PresenceStore / live read).
 * Online is never inferred from timestamps — only from this map.
 */
export interface StatusPresenceInput {
  actorUid: string;
  status: "online" | "offline";
  actorType?: "human" | "agent";
}

/**
 * One live-read session row (GET /v1/work-mesh/live) scoped to the channel's
 * project. Prefer this over local Sessions-app observations.
 */
export interface LiveReadSessionInput {
  sessionId: string;
  actorUid: string;
  actorType?: "human" | "agent" | string | null;
  displayName?: string | null;
  harness?: string | null;
  taskId?: string | null;
  turnCount?: number | null;
  status?: string | null;
  lastTurnAt?: string | null;
  startedAt?: string | null;
  progressPercent?: number | null;
  blockedReason?: string | null;
}

/**
 * One server work-session summary row (US-010), as returned by
 * `GET /v1/work-mesh/work-sessions?companyUid=&projectId=` (hq-pro US-006).
 * Sessions NEVER auto-expire server-side — `active` is the honest "who is (or
 * claims to be) working on this" list, so the last-activity timestamp is what
 * keeps a quiet open session reading honestly.
 */
export interface ServerWorkSessionInput {
  sessionId?: string | null;
  threadId?: string | null;
  status?: string | null;
  harness?: string | null;
  /** prs_* human or agt_* agent principal that owns the session. */
  ownerUid?: string | null;
  ownerType?: string | null;
  progressSummary?: string | null;
  /** 0–100 when the session reported progress. */
  progressPercent?: number | null;
  blockedReason?: string | null;
  lastActivityAt?: string | null;
  createdAt?: string | null;
}

export interface BuildChannelStatusInput {
  project: StatusProjectInput;
  prd?: StatusPrdInput | null;
  /**
   * Local Sessions-app observations. US-015: only rows with a server binding
   * (`serverSessionId`) are shown — never cwd-matched guesses.
   */
  sessions?: readonly StatusSessionInput[];
  members?: readonly StatusMemberInput[];
  companyLabel?: string | null;
  /** Presigned company icon, shown beside `companyLabel` in the popover. */
  companyIconUrl?: string | null;
  /** Server-truth active sessions for the popover (US-010 / legacy work-sessions). */
  serverSessions?: readonly ServerWorkSessionInput[];
  /**
   * Live-read sessions already filtered to this project's projectId (US-015).
   * Preferred source for active session cards and live participants.
   */
  liveSessions?: readonly LiveReadSessionInput[];
  /**
   * Presence store snapshot for the company (US-014/015). Drives online dots;
   * never invent presence from last-activity timestamps.
   */
  presence?: readonly StatusPresenceInput[];
  /** Clock for relative last-activity labels; injectable for tests. */
  nowMs?: number;
}

// ── Outputs ──────────────────────────────────────────────────────────────────

export type AgentLiveStatus = "running" | "awaiting_input" | "idle" | "ended";

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

export interface ProjectRepoRef {
  path: string;
  branch: string | null;
}

/** Unique repo path with every branch recorded for that path. */
export interface GroupedProjectRepo {
  path: string;
  branches: string[];
}

export interface ProjectStatusBlock {
  branch: string | null;
  repo: string | null;
  /** Full git coordinate list. Status UI renders this; `branch`/`repo` stay as the first entry. */
  repos: ProjectRepoRef[];
  previewUrl: string | null;
  /** PROJECT_VIEW description. Null/omitted when the project has none. */
  description?: string | null;
}

export interface StatusPersonRow {
  personUid: string;
  displayName: string;
  /** Account email, when the roster carried one — shown under the name. */
  email: string | null;
  /** Presigned avatar URL, when known — real photo instead of a monogram. */
  avatarUrl: string | null;
  /** Profile "about" line, when known — shown in the profile panel. */
  description: string | null;
  role: string | null;
  /** For AGENTS list: running | idle (collapsed from live taxonomy). */
  statusIcon: "running" | "idle";
  /**
   * Connection presence from the presence store only (US-015). Never derived
   * from last-activity timestamps.
   */
  online: boolean;
}

/**
 * One rendered active-session row for the status popover (US-010 / US-015):
 * principal, story/context, harness, turn count, and an honest relative
 * last-event timestamp ("last activity 42m ago").
 */
export interface ActiveSessionRow {
  id: string;
  /** Principal display: the owning prs_* / agt_* uid or display name. */
  principal: string;
  principalKind: "human" | "agent";
  /** Story/context: taskId / extracted US-xxx id, else harness, else summary. */
  context: string | null;
  /** Clamped integer 0–100, or null when the session reported none. */
  percent: number | null;
  /** "last activity 42m ago" — sessions never auto-expire, so this is the
   * signal that keeps a quiet open session reading honestly. */
  lastActivityLabel: string;
  blockedReason: string | null;
  harness: string | null;
  taskId: string | null;
  turnCount: number | null;
  /** Presence-store online flag for the owning actor (never from timestamps). */
  online: boolean;
}

export interface ChannelStatusModel {
  /** Live agent rows with progress bars. */
  liveAgents: LiveAgentStatusRow[];
  /** Server-truth active sessions (US-010); empty when none/unavailable. */
  activeSessions: ActiveSessionRow[];
  stories: StoryRollup;
  project: ProjectStatusBlock;
  members: StatusPersonRow[];
  agents: StatusPersonRow[];
  memberCount: number;
  /** Header subtitle helper: company display name. */
  companyLabel: string | null;
  /**
   * Presigned company icon for `companyLabel`. Null when the company has no
   * icon — the popover then draws the building glyph, so the company row looks
   * the same shape either way. Optional so existing model fixtures and
   * callers that never knew about icons stay valid.
   */
  companyIconUrl?: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const STORY_ID_RE = /\b(US[-_]?\d+[a-z]?)\b/i;

export function extractStoryId(
  ...parts: Array<string | null | undefined>
): string | null {
  for (const part of parts) {
    if (!part) continue;
    const m = part.match(STORY_ID_RE);
    if (m?.[1]) {
      // Normalize US-003 style.
      const raw = m[1].toUpperCase().replace(/_/g, "-");
      return raw.startsWith("US") && !raw.startsWith("US-")
        ? raw.replace(/^US/, "US-")
        : raw;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value == null || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

/** Normalize mesh `repos[]`, falling back to the legacy single pair. */
export function resolveProjectRepos(
  prd: StatusPrdInput | null | undefined,
): ProjectRepoRef[] {
  const fromArray: ProjectRepoRef[] = [];
  for (const raw of prd?.repos ?? []) {
    const path = optionalString(raw.path);
    if (!path) continue;
    fromArray.push({ path, branch: optionalString(raw.branch) });
  }
  if (fromArray.length > 0) return fromArray;
  const single = resolveRepoPath(prd);
  if (!single) return [];
  return [{ path: single, branch: optionalString(prd?.branchName) }];
}

/** Collapse `{path, branch}` pairs into unique paths with their branches. */
export function groupProjectRepos(
  repos: readonly ProjectRepoRef[],
): GroupedProjectRepo[] {
  const groups: GroupedProjectRepo[] = [];
  const indexByPath = new Map<string, number>();
  for (const repo of repos) {
    const path = repo.path.trim();
    if (!path) continue;
    let index = indexByPath.get(path);
    if (index === undefined) {
      index = groups.length;
      indexByPath.set(path, index);
      groups.push({ path, branches: [] });
    }
    const branch = repo.branch?.trim();
    if (branch && !groups[index].branches.includes(branch)) {
      groups[index].branches.push(branch);
    }
  }
  return groups;
}

/** Groups for the popover — `repos[]` first, then the legacy single pair. */
export function projectReposForDisplay(
  project: Pick<ProjectStatusBlock, "repos" | "repo" | "branch">,
): GroupedProjectRepo[] {
  const grouped = groupProjectRepos(project.repos);
  if (grouped.length > 0) return grouped;
  const path = project.repo?.trim();
  if (!path) return [];
  const branch = project.branch?.trim();
  return [{ path, branches: branch ? [branch] : [] }];
}

/** Prefer explicit repoPath; else metadata; else directory of prdPath. */
export function resolveRepoPath(
  prd: StatusPrdInput | null | undefined,
): string | null {
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
  const normalized = prdPath.replace(/\\/g, "/");
  if (/\/prd\.json$/i.test(normalized)) {
    return normalized.replace(/\/prd\.json$/i, "");
  }
  const idx = normalized.lastIndexOf("/");
  return idx > 0 ? normalized.slice(0, idx) : normalized;
}

/** Preview / deploy URL only when present (never invent). */
export function resolvePreviewUrl(
  prd: StatusPrdInput | null | undefined,
): string | null {
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
    label: total > 0 ? `stories ${complete}/${total}` : "stories 0/0",
    percent,
  };
}

function normalizeAgentStatus(
  status: string | null | undefined,
): AgentLiveStatus {
  const s = (status ?? "").toLowerCase();
  if (s === "running") return "running";
  if (s === "awaiting_input") return "awaiting_input";
  if (s === "ended") return "ended";
  return "idle";
}

function isAgentMember(m: StatusMemberInput): boolean {
  if (m.isAgent === true) return true;
  const uid = (m.personUid ?? "").toLowerCase();
  if (uid.startsWith("agent:") || uid.startsWith("agt_")) return true;
  const role = (m.role ?? "").toLowerCase();
  return role === "agent" || role === "bot";
}

function memberDisplayName(m: StatusMemberInput): string {
  return (
    m.displayName?.trim() || m.email?.trim() || m.personUid.trim() || "Unknown"
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
  // US-015: never grep cwd for US-\d+ — only explicit story/task ids + project.
  const storyId =
    extractStoryId(session.storyId, session.taskId, session.project) ||
    firstOpenStoryId;
  const progress =
    typeof session.progressPercent === "number" &&
    Number.isFinite(session.progressPercent)
      ? Math.max(0, Math.min(100, Math.round(session.progressPercent)))
      : rollup.percent;
  const verb =
    status === "running"
      ? "running"
      : status === "awaiting_input"
        ? "awaiting input"
        : status === "ended"
          ? "ended"
          : "idle";
  const storyPart = storyId ? ` · ${storyId}` : "";
  const label = `Agent ${verb}${storyPart} · ${progress}%`;
  const displayName =
    [session.tool, session.model].filter(Boolean).join(" · ") ||
    session.project ||
    "Agent";
  const boundId = (session.serverSessionId ?? "").trim();
  return {
    id:
      boundId ||
      `${session.tool || "agent"}:${session.project || displayName}:${session.startedAt || ""}`,
    label,
    storyId,
    progressPercent: progress,
    status,
    tool: session.tool ?? null,
    displayName,
  };
}

function liveAgentRowFromLiveSession(
  session: LiveReadSessionInput,
  rollup: StoryRollup,
  firstOpen: string | null,
): LiveAgentStatusRow {
  const raw = (session.status ?? "").toLowerCase();
  const status: AgentLiveStatus =
    raw === "active" || raw === "open" || raw === "running"
      ? "running"
      : raw === "idle"
        ? "idle"
        : raw === "ended" || raw === "done"
          ? "ended"
          : "awaiting_input";
  const storyId =
    extractStoryId(session.taskId) || firstOpen;
  const progress =
    typeof session.progressPercent === "number" &&
    Number.isFinite(session.progressPercent)
      ? Math.max(0, Math.min(100, Math.round(session.progressPercent)))
      : rollup.percent;
  const verb =
    status === "running"
      ? "running"
      : status === "awaiting_input"
        ? "awaiting input"
        : status === "ended"
          ? "ended"
          : "idle";
  const storyPart = storyId ? ` · ${storyId}` : "";
  const displayName =
    optionalString(session.displayName) ||
    optionalString(session.harness) ||
    optionalString(session.actorUid) ||
    "Agent";
  return {
    id: session.sessionId,
    label: `Agent ${verb}${storyPart} · ${progress}%`,
    storyId,
    progressPercent: progress,
    status,
    tool: optionalString(session.harness),
    displayName,
  };
}

/** Lookup presence status; absent actors are offline (fail closed). */
export function presenceOnlineFor(
  presence: readonly StatusPresenceInput[] | null | undefined,
  actorUid: string | null | undefined,
): boolean {
  const uid = (actorUid ?? "").trim();
  if (!uid || !presence?.length) return false;
  const hit = presence.find((p) => p.actorUid === uid);
  return hit?.status === "online";
}

/** True when any presence entry for the given actor set is online. */
export function anyParticipantOnline(
  presence: readonly StatusPresenceInput[] | null | undefined,
  actorUids: readonly string[],
): boolean {
  if (!presence?.length || actorUids.length === 0) return false;
  const wanted = new Set(actorUids.map((u) => u.trim()).filter(Boolean));
  for (const entry of presence) {
    if (wanted.has(entry.actorUid) && entry.status === "online") return true;
  }
  return false;
}

/** First non-passing story id from the PRD (for labeling live agents). */
export function firstOpenStoryId(
  prd: StatusPrdInput | null | undefined,
): string | null {
  const stories = prd?.userStories ?? [];
  for (const s of stories) {
    if (s.passes === true) continue;
    const id = (s.id ?? "").trim();
    if (id) return id.toUpperCase().startsWith("US") ? id : id;
  }
  return stories[0]?.id?.trim() || null;
}

/**
 * Relative last-event label for a session row (US-010).
 *
 * "last activity just now" (<60s) → "…42m ago" → "…3h ago" → "…5d ago".
 * A missing/unparseable timestamp reads "last activity unknown" — never a
 * fabricated time. Sessions never auto-expire, so this label is what keeps a
 * long-quiet open session honest instead of silently looking live.
 */
export function formatLastActivity(
  iso: string | null | undefined,
  nowMs: number = Date.now(),
): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "last activity unknown";
  const elapsed = Math.max(0, nowMs - t);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "last activity just now";
  if (minutes < 60) return `last activity ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `last activity ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `last activity ${days}d ago`;
}

function serverPrincipalKind(
  session: ServerWorkSessionInput,
): "human" | "agent" {
  const declared = (session.ownerType ?? "").trim().toLowerCase();
  if (declared === "agent") return "agent";
  if (declared === "human" || declared === "person") return "human";
  const uid = (session.ownerUid ?? "").trim().toLowerCase();
  return uid.startsWith("agt_") || uid.startsWith("agent:") ? "agent" : "human";
}

/**
 * Map server work-session summaries into popover rows (US-010). Pure — the
 * caller passes the already-server-filtered `active` list; percent is clamped
 * and context prefers a story id extracted from the progress summary.
 */
export function buildActiveSessionRows(
  sessions: readonly ServerWorkSessionInput[] | null | undefined,
  nowMs: number = Date.now(),
  presence?: readonly StatusPresenceInput[] | null,
): ActiveSessionRow[] {
  return (sessions ?? []).map((s, index) => {
    const principal = optionalString(s.ownerUid) ?? "Unknown";
    const summary = optionalString(s.progressSummary);
    const context =
      extractStoryId(summary, s.blockedReason) ??
      optionalString(s.harness) ??
      summary;
    const rawPercent = s.progressPercent;
    const percent =
      typeof rawPercent === "number" && Number.isFinite(rawPercent)
        ? Math.max(0, Math.min(100, Math.round(rawPercent)))
        : null;
    return {
      id:
        optionalString(s.sessionId) ??
        optionalString(s.threadId) ??
        `session-${index}`,
      principal,
      principalKind: serverPrincipalKind(s),
      context,
      percent,
      lastActivityLabel: formatLastActivity(s.lastActivityAt, nowMs),
      blockedReason: optionalString(s.blockedReason),
      harness: optionalString(s.harness),
      taskId: extractStoryId(summary),
      turnCount: null,
      online: presenceOnlineFor(presence, s.ownerUid),
    };
  });
}

function livePrincipalKind(
  session: LiveReadSessionInput,
): "human" | "agent" {
  const declared = (session.actorType ?? "").trim().toLowerCase();
  if (declared === "agent") return "agent";
  if (declared === "human" || declared === "person") return "human";
  const uid = (session.actorUid ?? "").trim().toLowerCase();
  return uid.startsWith("agt_") || uid.startsWith("agent:") ? "agent" : "human";
}

/**
 * Map live-read sessions into popover rows (US-015). Prefer these over legacy
 * work-sessions and local Sessions-app observations.
 */
export function buildLiveReadSessionRows(
  sessions: readonly LiveReadSessionInput[] | null | undefined,
  nowMs: number = Date.now(),
  presence?: readonly StatusPresenceInput[] | null,
): ActiveSessionRow[] {
  return (sessions ?? []).map((s, index) => {
    const principal =
      optionalString(s.displayName) ??
      optionalString(s.actorUid) ??
      "Unknown";
    const taskId = optionalString(s.taskId);
    const harness = optionalString(s.harness);
    const context = taskId ?? harness;
    const rawPercent = s.progressPercent;
    const percent =
      typeof rawPercent === "number" && Number.isFinite(rawPercent)
        ? Math.max(0, Math.min(100, Math.round(rawPercent)))
        : null;
    const turns =
      typeof s.turnCount === "number" && Number.isFinite(s.turnCount)
        ? Math.max(0, Math.floor(s.turnCount))
        : null;
    return {
      id: optionalString(s.sessionId) ?? `live-session-${index}`,
      principal,
      principalKind: livePrincipalKind(s),
      context,
      percent,
      lastActivityLabel: formatLastActivity(s.lastTurnAt ?? s.startedAt, nowMs),
      blockedReason: optionalString(s.blockedReason),
      harness,
      taskId,
      turnCount: turns,
      online: presenceOnlineFor(presence, s.actorUid),
    };
  });
}

/**
 * Build the full status popover model.
 *
 * US-015: live participants come from the presence store + live-read sessions
 * for the channel's project. Local Sessions-app rows appear only when they
 * carry a server binding. Cwd substring matching is gone.
 */
export function buildChannelStatusModel(
  input: BuildChannelStatusInput,
): ChannelStatusModel {
  const prd = input.prd ?? null;
  const rollup = computeStoryRollup(input.project, prd);
  const openStory = firstOpenStoryId(prd);
  const presence = input.presence ?? [];

  const liveReadSessions = input.liveSessions ?? [];
  const boundLocalSessions = (input.sessions ?? []).filter((session) =>
    sessionHasServerBinding(session),
  );

  const liveAgentsFromLive = liveReadSessions
    .filter((s) => {
      const st = (s.status ?? "").toLowerCase();
      return st === "active" || st === "open" || st === "running" || st === "idle";
    })
    .filter((s) => {
      const kind = livePrincipalKind(s);
      return kind === "agent";
    })
    .map((s) => liveAgentRowFromLiveSession(s, rollup, openStory));

  const liveAgentsFromLocal = boundLocalSessions
    .filter((s) => isPortfolioLiveStatus(s.status))
    .map((s) => liveAgentRowFromSession(s, rollup, openStory));

  // Prefer live-read agent cards; fall back to bound local sessions.
  const liveAgents =
    liveAgentsFromLive.length > 0 ? liveAgentsFromLive : liveAgentsFromLocal;

  const liveByKey = new Set<string>();
  for (const s of liveReadSessions) {
    if (s.actorUid) liveByKey.add(s.actorUid);
  }
  for (const s of boundLocalSessions) {
    if (!isPortfolioLiveStatus(s.status)) continue;
    if (s.personUid) liveByKey.add(s.personUid);
  }

  const humans: StatusPersonRow[] = [];
  const agents: StatusPersonRow[] = [];
  for (const m of input.members ?? []) {
    const online = presenceOnlineFor(presence, m.personUid);
    const row: StatusPersonRow = {
      personUid: m.personUid,
      displayName: memberDisplayName(m),
      email: m.email?.trim() || null,
      avatarUrl: m.avatarUrl?.trim() || null,
      description: m.description?.trim() || null,
      role: m.role?.trim() || null,
      statusIcon: "idle",
      online,
    };
    if (isAgentMember(m)) {
      const running = liveByKey.has(m.personUid);
      row.statusIcon = running ? "running" : "idle";
      agents.push(row);
    } else {
      humans.push(row);
    }
  }

  // Actors present only via live read (not yet in roster) still appear.
  for (const session of liveReadSessions) {
    const uid = (session.actorUid ?? "").trim();
    if (!uid) continue;
    const kind = livePrincipalKind(session);
    const list = kind === "agent" ? agents : humans;
    if (list.some((a) => a.personUid === uid)) continue;
    const online = presenceOnlineFor(presence, uid);
    list.push({
      personUid: uid,
      displayName:
        optionalString(session.displayName) ||
        optionalString(session.harness) ||
        uid,
      email: null,
      avatarUrl: null,
      description: null,
      role: kind === "agent" ? "agent" : "member",
      statusIcon:
        kind === "agent" &&
        ["active", "open", "running"].includes(
          (session.status ?? "").toLowerCase(),
        )
          ? "running"
          : "idle",
      online,
    });
  }

  for (const live of liveAgents) {
    if (agents.some((a) => a.displayName === live.displayName)) continue;
    if (agents.some((a) => a.personUid === live.id)) continue;
    agents.push({
      personUid: live.id,
      displayName: live.displayName,
      email: null,
      avatarUrl: null,
      description: null,
      role: "agent",
      statusIcon:
        live.status === "running" || live.status === "awaiting_input"
          ? "running"
          : "idle",
      online: false,
    });
  }

  humans.sort((a, b) => a.displayName.localeCompare(b.displayName));
  agents.sort((a, b) => a.displayName.localeCompare(b.displayName));

  const memberCount =
    (input.members?.length ?? 0) > 0
      ? input.members!.length
      : humans.length + agents.length;

  const activeFromLive = buildLiveReadSessionRows(
    liveReadSessions,
    input.nowMs,
    presence,
  );
  const activeSessions =
    activeFromLive.length > 0
      ? activeFromLive
      : buildActiveSessionRows(input.serverSessions, input.nowMs, presence);

  return {
    liveAgents,
    activeSessions,
    stories: rollup,
    project: (() => {
      const repos = resolveProjectRepos(prd);
      const first = repos[0];
      return {
        branch: first?.branch ?? optionalString(prd?.branchName) ?? null,
        repo: first?.path ?? resolveRepoPath(prd),
        repos,
        previewUrl: resolvePreviewUrl(prd),
        description: optionalString(input.project.description),
      };
    })(),
    members: humans,
    agents,
    memberCount,
    companyLabel: input.companyLabel?.trim() || null,
    companyIconUrl: input.companyIconUrl?.trim() || null,
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
  model: Pick<ChannelStatusModel, "memberCount">,
  previousCount: number | null,
): number | null {
  return fetchedMemberCount > 0 ? model.memberCount : previousCount;
}

/** Header title pieces for a project channel (Daybook: `# name` + dim subtitle). */
export function projectChannelHeaderParts(
  channelName: string,
  companyLabel: string | null | undefined,
): { title: string; subtitle: string } {
  const name = channelName.trim().replace(/^#+/, "") || "channel";
  const company = companyLabel?.trim() || "Company";
  return { title: `# ${name}`, subtitle: `${company} · project channel` };
}

/** Combined header string — kept for callers that still want one line. */
export function projectChannelHeaderTitle(
  channelName: string,
  companyLabel: string | null | undefined,
): string {
  const { title, subtitle } = projectChannelHeaderParts(
    channelName,
    companyLabel,
  );
  return `${title} · ${subtitle}`;
}

/** Body copy for the project-about dialog. */
export function projectAboutBody(
  description: string | null | undefined,
): string {
  const text = description?.trim() ?? "";
  return text || "No description for this project.";
}

/** Visual-QA fixture members + agents (D-06). */
export const CHANNEL_STATUS_FIXTURE_MEMBERS: StatusMemberInput[] = [
  { personUid: "prs_ada", displayName: "Ada Lovelace", role: "owner" },
  { personUid: "prs_marcus", displayName: "Marcus Chen", role: "member" },
  { personUid: "prs_corey", displayName: "Corey", role: "member" },
  {
    personUid: "agt_claude",
    displayName: "Claude",
    role: "agent",
    isAgent: true,
  },
  {
    personUid: "agt_codex",
    displayName: "Codex",
    role: "agent",
    isAgent: true,
  },
];

export const CHANNEL_STATUS_FIXTURE_PRD: StatusPrdInput = {
  name: "HQ Desktop",
  branchName: "feat/v2-chat-shell",
  repoPath: "companies/indigo/projects/hq-desktop-app",
  previewUrl: "https://preview.example/hq-desktop",
  userStories: [
    { id: "US-001", passes: true },
    { id: "US-002", passes: true },
    { id: "US-003", passes: false },
    { id: "US-004", passes: false },
  ],
};
