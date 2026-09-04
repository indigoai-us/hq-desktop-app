/**
 * Typed GET /v1/work-mesh/live client types + parser (US-015).
 *
 * Contract §4 — company-wide live read. Presence truth still flows through
 * PresenceStore (US-014); this module keeps the full session projection so
 * channel popovers, session cards, and Board activity can render without
 * cwd/substring matching.
 */

export type LiveActorType = "human" | "agent";
export type LivePresence = "online" | "offline";
export type LiveSessionStatus = "open" | "active" | "idle" | "ended";
export type LiveSessionSource = "hooks" | "transcript";
export type LiveContextStatus =
  | "unresolved"
  | "needs_company"
  | "company_conflict"
  | "needs_project"
  | "needs_task"
  | "bound"
  | "untracked"
  | "migration_pending";

export type LiveHarness =
  | "claude-code"
  | "claude-desktop"
  | "codex"
  | "grok"
  | "hq-sessions"
  | "agent-box"
  | string;

export interface LiveSession {
  sessionId: string;
  harness: LiveHarness;
  source: LiveSessionSource;
  contextStatus: LiveContextStatus | string;
  projectId?: string;
  taskId?: string;
  status: LiveSessionStatus | string;
  startedAt: string;
  lastTurnAt: string;
  turnCount: number;
}

export interface LiveParticipant {
  actorUid: string;
  actorType: LiveActorType;
  displayName: string;
  presence: LivePresence;
  lastSeenAt: string;
  sessions: LiveSession[];
}

export interface LiveReadResponse {
  contractVersion: 1;
  generatedAt: string;
  participants: LiveParticipant[];
  nextCursor?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalTrimmed(value: unknown): string | undefined {
  const t = trimmed(value);
  return t || undefined;
}

function finiteInt(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
  }
  return fallback;
}

function normalizeActorType(value: unknown): LiveActorType {
  return trimmed(value) === "agent" ? "agent" : "human";
}

function normalizePresence(value: unknown): LivePresence | null {
  const status = trimmed(value);
  if (status === "online" || status === "offline") return status;
  return null;
}

function normalizeSource(value: unknown): LiveSessionSource {
  return trimmed(value) === "transcript" ? "transcript" : "hooks";
}

function parseSession(raw: unknown): LiveSession | null {
  const row = asRecord(raw);
  if (!row) return null;
  const sessionId = trimmed(row.sessionId);
  if (!sessionId) return null;
  const harness = trimmed(row.harness) || "claude-code";
  const contextStatus = trimmed(row.contextStatus) || "unresolved";
  const status = trimmed(row.status) || "open";
  const startedAt = trimmed(row.startedAt) || new Date(0).toISOString();
  const lastTurnAt = trimmed(row.lastTurnAt) || startedAt;
  return {
    sessionId,
    harness,
    source: normalizeSource(row.source),
    contextStatus,
    ...(optionalTrimmed(row.projectId)
      ? { projectId: optionalTrimmed(row.projectId) }
      : {}),
    ...(optionalTrimmed(row.taskId) ? { taskId: optionalTrimmed(row.taskId) } : {}),
    status,
    startedAt,
    lastTurnAt,
    turnCount: finiteInt(row.turnCount, 0),
  };
}

function parseParticipant(raw: unknown): LiveParticipant | null {
  const row = asRecord(raw);
  if (!row) return null;
  const actorUid = trimmed(row.actorUid);
  if (!actorUid) return null;
  const presence = normalizePresence(row.presence);
  if (!presence) return null;
  const sessionsRaw = Array.isArray(row.sessions) ? row.sessions : [];
  const sessions: LiveSession[] = [];
  for (const entry of sessionsRaw) {
    const session = parseSession(entry);
    if (session) sessions.push(session);
  }
  return {
    actorUid,
    actorType: normalizeActorType(row.actorType),
    displayName: trimmed(row.displayName) || actorUid,
    presence,
    lastSeenAt: trimmed(row.lastSeenAt) || new Date(0).toISOString(),
    sessions,
  };
}

/**
 * Parse a GET /v1/work-mesh/live JSON body. Returns null when the payload is
 * unusable (not an object / missing participants array).
 */
export function parseLiveReadResponse(raw: unknown): LiveReadResponse | null {
  const body = asRecord(raw);
  if (!body) return null;
  if (!Array.isArray(body.participants)) return null;
  const participants: LiveParticipant[] = [];
  for (const row of body.participants) {
    const participant = parseParticipant(row);
    if (participant) participants.push(participant);
  }
  const contractVersion =
    body.contractVersion === 1 || body.contractVersion === "1" ? 1 : 1;
  return {
    contractVersion,
    generatedAt: trimmed(body.generatedAt) || new Date(0).toISOString(),
    participants,
    ...(optionalTrimmed(body.nextCursor)
      ? { nextCursor: optionalTrimmed(body.nextCursor) }
      : {}),
  };
}

/** Sessions bound to a project (explicit projectId match; case-insensitive). */
export function liveSessionsForProject(
  response: LiveReadResponse | null | undefined,
  projectId: string | null | undefined,
): Array<LiveSession & { actorUid: string; actorType: LiveActorType; displayName: string; presence: LivePresence }> {
  const slug = (projectId ?? "").trim().toLowerCase();
  if (!slug || !response) return [];
  const out: Array<
    LiveSession & {
      actorUid: string;
      actorType: LiveActorType;
      displayName: string;
      presence: LivePresence;
    }
  > = [];
  for (const participant of response.participants) {
    for (const session of participant.sessions) {
      const sid = (session.projectId ?? "").trim().toLowerCase();
      if (!sid || sid !== slug) continue;
      out.push({
        ...session,
        actorUid: participant.actorUid,
        actorType: participant.actorType,
        displayName: participant.displayName,
        presence: participant.presence,
      });
    }
  }
  return out;
}

/** Path helper for GET /v1/work-mesh/live (mirrors mesh/reconcile liveReadPath). */
export function workMeshLivePath(companyUid: string): string {
  return `/v1/work-mesh/live?companyUid=${encodeURIComponent(companyUid.trim())}`;
}

/**
 * Typed fetch for GET /v1/work-mesh/live. `getJson` is injected so tests stay
 * offline and hosts can reuse their existing hq-pro client.
 */
export async function fetchLiveRead(
  companyUid: string,
  getJson: (path: string) => Promise<unknown>,
): Promise<LiveReadResponse | null> {
  const uid = companyUid.trim();
  if (!uid) return null;
  const raw = await getJson(workMeshLivePath(uid));
  return parseLiveReadResponse(raw);
}

/**
 * Contract-shaped fixture for tests (US-015). Mixed online/offline actors,
 * human + agent, bound sessions on one project.
 */
export const LIVE_READ_FIXTURE: LiveReadResponse = {
  contractVersion: 1,
  generatedAt: "2026-09-04T12:00:00.000Z",
  participants: [
    {
      actorUid: "prs_corey",
      actorType: "human",
      displayName: "Corey",
      presence: "online",
      lastSeenAt: "2026-09-04T11:59:30.000Z",
      sessions: [
        {
          sessionId: "sess_corey_1",
          harness: "claude-code",
          source: "hooks",
          contextStatus: "bound",
          projectId: "work-mesh-live",
          taskId: "US-015",
          status: "active",
          startedAt: "2026-09-04T11:00:00.000Z",
          lastTurnAt: "2026-09-04T11:58:00.000Z",
          turnCount: 12,
        },
      ],
    },
    {
      actorUid: "agt_ralph",
      actorType: "agent",
      displayName: "Ralph",
      presence: "online",
      lastSeenAt: "2026-09-04T11:59:45.000Z",
      sessions: [
        {
          sessionId: "sess_ralph_1",
          harness: "agent-box",
          source: "hooks",
          contextStatus: "bound",
          projectId: "work-mesh-live",
          taskId: "US-015",
          status: "active",
          startedAt: "2026-09-04T11:10:00.000Z",
          lastTurnAt: "2026-09-04T11:59:00.000Z",
          turnCount: 7,
        },
      ],
    },
    {
      actorUid: "prs_stefan",
      actorType: "human",
      displayName: "Stefan",
      presence: "offline",
      lastSeenAt: "2026-09-04T10:00:00.000Z",
      sessions: [],
    },
  ],
};
