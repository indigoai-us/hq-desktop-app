/**
 * Atlas v0 projection (work-mesh-live US-016).
 *
 * Company roster × active projects from GET /v1/work-mesh/live, with presence
 * overridden by the in-memory PresenceStore (retained MQTT). Online/offline is
 * never derived from timestamps alone.
 */

import type {
  LiveParticipant,
  LivePresence,
  LiveReadResponse,
  LiveSession,
} from "@hq/core";

const UNASSIGNED_CONTEXT = new Set([
  "unresolved",
  "needs_project",
  "needs_task",
]);

export type AtlasActorType = "human" | "agent";

export interface AtlasOnlineActor {
  actorUid: string;
  actorType: AtlasActorType;
  displayName: string;
  taskId: string | null;
  harness: string;
  sessionId: string;
  contextStatus: string;
}

export interface AtlasProjectCard {
  projectId: string;
  label: string;
  onlineActors: AtlasOnlineActor[];
  /** Offline roster members associated with this project (collapsed count). */
  offlineCount: number;
}

export interface AtlasViewModel {
  projects: AtlasProjectCard[];
  /** Online actors whose live sessions lack a project (server-filtered). */
  unassigned: AtlasOnlineActor[];
  /** Company-wide offline actors collapsed into a count. */
  offlineCount: number;
  onlineCount: number;
  empty: boolean;
}

export interface BuildAtlasViewOptions {
  live: LiveReadResponse | null | undefined;
  /**
   * Authoritative presence from PresenceStore. When set for an actor, wins
   * over the live-read `presence` field.
   */
  presenceByActor?: ReadonlyMap<string, LivePresence> | null;
  /** Optional display labels for project ids. */
  projectLabels?: ReadonlyMap<string, string> | Readonly<Record<string, string>> | null;
  /**
   * When false, Unassigned is omitted. Default true — the server already
   * filters unresolved sessions to owners/admins and the session actor.
   */
  includeUnassigned?: boolean;
}

function labelForProject(
  projectId: string,
  labels: BuildAtlasViewOptions["projectLabels"],
): string {
  if (!labels) return projectId;
  if (labels instanceof Map) return labels.get(projectId) ?? projectId;
  const record = labels as Readonly<Record<string, string>>;
  return record[projectId] ?? projectId;
}

function resolvePresence(
  participant: LiveParticipant,
  presenceByActor: BuildAtlasViewOptions["presenceByActor"],
): LivePresence {
  const override = presenceByActor?.get(participant.actorUid);
  if (override === "online" || override === "offline") return override;
  return participant.presence;
}

function isUnassignedSession(session: LiveSession): boolean {
  const projectId = (session.projectId ?? "").trim();
  if (!projectId) return true;
  return UNASSIGNED_CONTEXT.has(
    String(session.contextStatus ?? "")
      .trim()
      .toLowerCase(),
  );
}

function toOnlineActor(
  participant: LiveParticipant,
  session: LiveSession,
): AtlasOnlineActor {
  return {
    actorUid: participant.actorUid,
    actorType: participant.actorType === "agent" ? "agent" : "human",
    displayName: participant.displayName || participant.actorUid,
    taskId: session.taskId?.trim() ? session.taskId.trim() : null,
    harness: String(session.harness || "claude-code"),
    sessionId: session.sessionId,
    contextStatus: String(session.contextStatus || "unresolved"),
  };
}

/**
 * Build the Atlas roster view. Presence overrides come from the store so a
 * retained offline payload removes an actor from online without timestamp math.
 */
export function buildAtlasView(options: BuildAtlasViewOptions): AtlasViewModel {
  const live = options.live;
  const includeUnassigned = options.includeUnassigned !== false;
  const participants = live?.participants ?? [];

  const projectMap = new Map<
    string,
    { online: AtlasOnlineActor[]; offlineActorUids: Set<string> }
  >();
  const unassigned: AtlasOnlineActor[] = [];
  const unassignedSeen = new Set<string>();
  const offlineActors = new Set<string>();
  const onlineActors = new Set<string>();

  for (const participant of participants) {
    const presence = resolvePresence(participant, options.presenceByActor);
    if (presence !== "online") {
      offlineActors.add(participant.actorUid);
      for (const session of participant.sessions) {
        const projectId = (session.projectId ?? "").trim();
        if (!projectId || isUnassignedSession(session)) continue;
        let card = projectMap.get(projectId);
        if (!card) {
          card = { online: [], offlineActorUids: new Set() };
          projectMap.set(projectId, card);
        }
        card.offlineActorUids.add(participant.actorUid);
      }
      continue;
    }

    onlineActors.add(participant.actorUid);
    const sessions = participant.sessions;
    if (sessions.length === 0) {
      // Online with no session — still company presence, not a project card.
      continue;
    }

    for (const session of sessions) {
      if (session.status === "ended") continue;
      if (isUnassignedSession(session)) {
        if (includeUnassigned && !unassignedSeen.has(session.sessionId)) {
          unassignedSeen.add(session.sessionId);
          unassigned.push(toOnlineActor(participant, session));
        }
        continue;
      }
      const projectId = (session.projectId ?? "").trim();
      let card = projectMap.get(projectId);
      if (!card) {
        card = { online: [], offlineActorUids: new Set() };
        projectMap.set(projectId, card);
      }
      // One row per actor per project (latest session wins).
      const existing = card.online.findIndex(
        (a) => a.actorUid === participant.actorUid,
      );
      const row = toOnlineActor(participant, session);
      if (existing >= 0) card.online[existing] = row;
      else card.online.push(row);
    }
  }

  const projects: AtlasProjectCard[] = [...projectMap.entries()]
    .map(([projectId, card]) => ({
      projectId,
      label: labelForProject(projectId, options.projectLabels),
      onlineActors: card.online.slice().sort((a, b) =>
        a.displayName.localeCompare(b.displayName),
      ),
      offlineCount: card.offlineActorUids.size,
    }))
    .filter((card) => card.onlineActors.length > 0 || card.offlineCount > 0)
    .sort((a, b) => a.label.localeCompare(b.label));

  unassigned.sort((a, b) => a.displayName.localeCompare(b.displayName));

  const empty =
    projects.length === 0 &&
    unassigned.length === 0 &&
    onlineActors.size === 0;

  return {
    projects,
    unassigned,
    offlineCount: offlineActors.size,
    onlineCount: onlineActors.size,
    empty,
  };
}

/** Fixtures for screenshot / mount tests (three Atlas states). */
export const ATLAS_EMPTY_LIVE: LiveReadResponse = {
  contractVersion: 1,
  generatedAt: "2026-09-04T12:00:00.000Z",
  participants: [],
};

export const ATLAS_ONE_ACTOR_LIVE: LiveReadResponse = {
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
          taskId: "US-016",
          status: "active",
          startedAt: "2026-09-04T11:00:00.000Z",
          lastTurnAt: "2026-09-04T11:58:00.000Z",
          turnCount: 4,
        },
      ],
    },
  ],
};

/** Three online actors across two projects + one offline (e2e fixture). */
export const ATLAS_MIXED_LIVE: LiveReadResponse = {
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
          taskId: "US-016",
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
      presence: "online",
      lastSeenAt: "2026-09-04T11:59:40.000Z",
      sessions: [
        {
          sessionId: "sess_stefan_1",
          harness: "codex",
          source: "hooks",
          contextStatus: "bound",
          projectId: "hq-desktop",
          taskId: "DESKTOP-001",
          status: "active",
          startedAt: "2026-09-04T11:20:00.000Z",
          lastTurnAt: "2026-09-04T11:55:00.000Z",
          turnCount: 3,
        },
      ],
    },
    {
      actorUid: "prs_offline",
      actorType: "human",
      displayName: "Maya",
      presence: "offline",
      lastSeenAt: "2026-09-04T10:00:00.000Z",
      sessions: [],
    },
    {
      actorUid: "prs_unassigned",
      actorType: "human",
      displayName: "Unbound",
      presence: "online",
      lastSeenAt: "2026-09-04T11:59:50.000Z",
      sessions: [
        {
          sessionId: "sess_unassigned_1",
          harness: "hq-sessions",
          source: "hooks",
          contextStatus: "unresolved",
          status: "active",
          startedAt: "2026-09-04T11:50:00.000Z",
          lastTurnAt: "2026-09-04T11:59:00.000Z",
          turnCount: 1,
        },
      ],
    },
  ],
};
