import type {
  MeshBoardStoryPanel,
  MeshBoardTab,
  MeshCachedChannel,
  MeshCachedMessage,
  MeshChannelStatus,
  MeshDirectoryRow,
  MeshFileItem,
  MeshGenesisLink,
  MeshProjectView,
  MeshRepo,
  MeshShellOverlay,
  MeshStory,
  MeshStoryStatus,
  WorkMeshSnapshot,
} from "./types.js";
import { iconKindForPath } from "./project-files.js";

/** Official work-mesh task stages — one Board column each. */
export const MESH_STORY_STAGES = [
  "queued",
  "in_progress",
  "review",
  "done",
] as const;

export type MeshStoryStage = (typeof MESH_STORY_STAGES)[number];

const COLUMN_TITLES: Record<MeshStoryStage, string> = {
  queued: "To do",
  in_progress: "Doing",
  review: "Waiting",
  done: "Done",
};

const STATUS_LINE: Record<string, string> = {
  queued: "TO DO",
  todo: "TO DO",
  in_progress: "DOING",
  review: "WAITING",
  blocked: "BLOCKED",
  done: "DONE",
};

const STATUS_BADGE: Record<string, string> = {
  queued: "To do",
  todo: "To do",
  in_progress: "Doing",
  review: "Waiting",
  blocked: "Blocked",
  done: "Done",
};

/**
 * Map a PROJECT_VIEW task onto one of the four Board stages.
 * Explicit `status` wins; `passes` only fills in when status is missing.
 * Unknown / unset statuses are To do — never Doing.
 */
export function normalizeStoryStage(story: MeshStory): MeshStoryStage {
  const raw = (story.status ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (raw === "queued" || raw === "todo" || raw === "backlog") return "queued";
  if (
    raw === "in_progress" ||
    raw === "inprogress" ||
    raw === "doing" ||
    raw === "wip" ||
    raw === "progress"
  ) {
    return "in_progress";
  }
  if (
    raw === "review" ||
    raw === "in_review" ||
    raw === "inreview" ||
    raw === "waiting"
  ) {
    return "review";
  }
  if (
    raw === "done" ||
    raw === "shipped" ||
    raw === "complete" ||
    raw === "completed"
  ) {
    return "done";
  }
  if (raw === "blocked") return "review";
  if (story.passes) return "done";
  return "queued";
}

function criteriaOf(story: MeshStory): { text: string; done: boolean }[] {
  const items = story.acceptanceCriteria ?? [];
  return items.map((item) => {
    if (typeof item === "string") {
      return { text: item, done: Boolean(story.passes) };
    }
    return { text: item.text, done: Boolean(item.done ?? story.passes) };
  });
}

/** Live-read session row used when projecting Board activity (US-015). */
export interface BoardLiveSessionActivity {
  sessionId: string;
  actorUid?: string;
  displayName?: string;
  harness?: string | null;
  taskId?: string | null;
  turnCount?: number | null;
  lastTurnAt?: string | null;
  actorType?: string | null;
}

/** Pre-formatted task_status change for a story panel activity list. */
export interface BoardTaskStatusChange {
  id: string;
  taskId: string;
  at: string;
  /** Already formatted, e.g. "Corey moved US-015 to in_progress". */
  text: string;
}

export interface ProjectViewToBoardOptions {
  liveSessions?: BoardLiveSessionActivity[];
  taskStatusChanges?: BoardTaskStatusChange[];
  /** Injectable clock; reserved for relative formatting callers. */
  nowMs?: number;
}

function normalizeActivityTaskId(raw: string | null | undefined): string {
  return (raw ?? "").trim().toUpperCase();
}

/** HH:MM from an ISO timestamp, else the raw string, else "". */
function activityAtLabel(iso: string | null | undefined): string {
  const t = (iso ?? "").trim();
  if (!t) return "";
  if (t.includes("T") && t.length >= 16) {
    const slice = t.slice(11, 16);
    if (slice) return slice;
  }
  return t;
}

function formatLiveSessionActivityText(
  session: BoardLiveSessionActivity,
): string {
  const who =
    (session.displayName ?? "").trim() || (session.actorUid ?? "").trim();
  const harness = (session.harness ?? "").trim();
  const turns =
    typeof session.turnCount === "number" && Number.isFinite(session.turnCount)
      ? `${Math.max(0, Math.floor(session.turnCount))} turns`
      : "";
  return [who, harness, turns].filter(Boolean).join(" · ");
}

/**
 * Build story-panel activity from live-read sessions + task_status rows.
 * Falls back to a single "Updated" stub only when neither source has rows
 * for the story and `updatedAt` is present (preserves prior callers).
 */
export function boardActivityFromLive(
  storyId: string,
  options?: ProjectViewToBoardOptions | null,
  updatedAt?: string | null,
): MeshBoardStoryPanel["activity"] {
  const target = normalizeActivityTaskId(storyId);
  const rows: Array<
    MeshBoardStoryPanel["activity"][number] & { sortAt: number }
  > = [];

  for (const session of options?.liveSessions ?? []) {
    if (!target || normalizeActivityTaskId(session.taskId) !== target) {
      continue;
    }
    const text = formatLiveSessionActivityText(session);
    if (!text) continue;
    const atRaw = (session.lastTurnAt ?? "").trim();
    rows.push({
      id: session.sessionId,
      at: activityAtLabel(atRaw) || atRaw,
      text,
      sortAt: Date.parse(atRaw) || 0,
    });
  }

  for (const change of options?.taskStatusChanges ?? []) {
    if (!target || normalizeActivityTaskId(change.taskId) !== target) {
      continue;
    }
    const atRaw = (change.at ?? "").trim();
    rows.push({
      id: change.id,
      at: activityAtLabel(atRaw) || atRaw,
      text: change.text,
      sortAt: Date.parse(atRaw) || 0,
    });
  }

  if (rows.length === 0) {
    const stamp = (updatedAt ?? "").trim();
    if (!stamp) return [];
    return [
      {
        id: "updated",
        at: stamp.slice(11, 16) || stamp,
        text: "Updated",
      },
    ];
  }

  rows.sort((a, b) => a.sortAt - b.sortAt);
  return rows.map(({ id, at, text }) => ({ id, at, text }));
}

export function projectViewToBoard(
  project: MeshProjectView,
  options?: ProjectViewToBoardOptions,
): MeshBoardTab {
  const columns = MESH_STORY_STAGES.map((id) => ({
    id,
    title: COLUMN_TITLES[id],
    cards: [] as MeshBoardTab["columns"][number]["cards"],
  }));
  const stories: MeshBoardTab["stories"] = {};
  for (const story of project.stories) {
    const col = normalizeStoryStage(story);
    const statusLine = STATUS_LINE[col] ?? col.toUpperCase();
    columns
      .find((c) => c.id === col)!
      .cards.push({
        storyId: story.id,
        label: story.title || story.id,
        statusLine,
      });
    const ac = criteriaOf(story);
    const doneCount = ac.filter((a) => a.done).length;
    stories[story.id] = {
      id: story.id,
      title: story.title,
      statusBadge: STATUS_BADGE[col] ?? col,
      description: story.description ?? "",
      fields: {
        status: STATUS_BADGE[col] ?? col,
        assignee: project.updatedBy ?? "",
        project: project.name || project.projectId,
        branch: "",
      },
      acceptanceCriteria: ac,
      acCountLabel: ac.length ? `${doneCount} / ${ac.length}` : "",
      activity: boardActivityFromLive(
        story.id,
        options,
        project.updatedAt ?? null,
      ),
    };
  }

  return { columns, stories };
}

export function reposToFiles(repos: MeshRepo[]): MeshFileItem[] {
  return repos.map((repo) => {
    const name = repo.path.split("/").filter(Boolean).pop() ?? repo.path;
    return {
      key: repo.path,
      vaultPath: repo.path,
      name,
      caption: (repo.branch ?? "").toUpperCase() || "REPO",
      iconKind: "file",
    };
  });
}

export function projectFilesToItems(
  files: MeshProjectView["files"] | undefined,
  companyUid?: string,
): MeshFileItem[] {
  return (files ?? []).map((file) => ({
    key: file.path,
    vaultPath: file.path,
    name: file.name,
    caption: file.updatedAt ? file.updatedAt.slice(0, 10) : "PROJECT",
    iconKind: iconKindForPath(file.path),
    ...(companyUid ? { companyUid } : {}),
    ...(file.updatedAt ? { updatedAt: file.updatedAt } : {}),
  }));
}

export function projectToStatus(project: MeshProjectView): MeshChannelStatus {
  const total = project.stories.length;
  const complete = project.stories.filter(
    (s) => normalizeStoryStage(s) === "done",
  ).length;
  return {
    companyLabel: project.companyUid || null,
    projectId: project.projectId,
    updatedBy: project.updatedBy ?? null,
    description: project.description?.trim() || null,
    storiesTotal: total,
    storiesComplete: complete,
    repos: project.repos,
    // In-progress stories are board state, not a known running agent.
    // Live "Agent running" rows come from work-mesh threads (ownerUid).
    liveAgents: [],
  };
}

function sortOldestFirst(messages: MeshCachedMessage[]): MeshCachedMessage[] {
  return [...messages].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
}

function projectDisplayName(project: MeshProjectView): string {
  return (project.name && project.name.trim()) || project.projectId;
}

function latestMessageAt(
  channel: MeshCachedChannel | undefined,
): string | null {
  const times = (channel?.messages ?? [])
    .map((m) => m.createdAt)
    .filter((t): t is string => Boolean(t));
  if (times.length === 0) return null;
  return times.sort().at(-1) ?? null;
}

function maxIso(times: Array<string | null | undefined>): string | null {
  const ok = times.filter((t): t is string =>
    Boolean(t && Number.isFinite(Date.parse(t))),
  );
  if (ok.length === 0) return null;
  return ok.sort().at(-1) ?? null;
}

/** Ignore lastActivityAt when it is just a doctor PUT clone of updatedAt. */
function honestProjectActivity(project: MeshProjectView): string | null {
  const last = project.lastActivityAt?.trim();
  if (!last) return null;
  if (project.updatedAt && last === project.updatedAt) return null;
  return last;
}

function projectCreatedAt(
  project: MeshProjectView | undefined,
  genesis: MeshGenesisLink | undefined,
): string | null {
  return project?.createdAt?.trim() || genesis?.createdAt?.trim() || null;
}

/**
 * Sidebar date: newest real signal (chat, status/lastActivity) then created.
 * Never chat-only, never doctor/ensure-project "now".
 */
function projectActivityAt(
  project: MeshProjectView | undefined,
  channel: MeshCachedChannel | undefined,
  genesis: MeshGenesisLink | undefined,
): string | null {
  const activity = maxIso([
    latestMessageAt(channel),
    project ? honestProjectActivity(project) : null,
  ]);
  if (activity) return activity;
  return projectCreatedAt(project, genesis);
}

function looksLikeUid(value: string): boolean {
  return /^(prs|agt|chn|cmp)_[a-z0-9]+$/i.test(value.trim());
}

function isPlaceholderDirectoryName(
  name: string,
  type: MeshDirectoryRow["type"],
): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (looksLikeUid(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  if (type === "dm" && (lower === "direct message" || lower === "group")) {
    return true;
  }
  return false;
}

function displayNameFromMessages(
  channel: MeshCachedChannel | undefined,
): string | null {
  const names = new Set<string>();
  for (const message of channel?.messages ?? []) {
    const name = (message.fromDisplayName ?? "").trim();
    if (name && !looksLikeUid(name)) names.add(name);
  }
  if (names.size === 0) return null;
  return [...names].join(", ");
}

function directoryActivityAt(
  row: MeshDirectoryRow,
  channel: MeshCachedChannel | undefined,
  project: MeshProjectView | undefined,
  genesis: MeshGenesisLink | undefined,
): string | null {
  if (row.type === "project") {
    return projectActivityAt(project, channel, genesis);
  }
  return latestMessageAt(channel) ?? row.lastActivityAt ?? null;
}

function bindProject(
  project: MeshProjectView,
  channelId: string,
  channel: MeshCachedChannel | undefined,
  genesis: MeshGenesisLink | undefined,
  rows: MeshDirectoryRow[],
  messagesByChannelId: Record<string, MeshCachedMessage[]>,
  boardByChannelId: Record<string, MeshBoardTab>,
  filesByChannelId: Record<string, MeshFileItem[]>,
  statusByChannelId: Record<string, MeshChannelStatus>,
  seen: Set<string>,
): void {
  if (!seen.has(channelId)) {
    rows.push({
      channelId,
      type: "project",
      scope: "project",
      companyUid: project.companyUid,
      name: projectDisplayName(project),
      subtitle: project.companyUid
        ? `${project.companyUid} · project`
        : "project",
      lastActivityAt: projectActivityAt(project, channel, genesis),
      unreadCount: 0,
      memberCount: 0,
    });
    seen.add(channelId);
  }
  messagesByChannelId[channelId] = sortOldestFirst(channel?.messages ?? []);
  boardByChannelId[channelId] = projectViewToBoard(project);
  filesByChannelId[channelId] = projectFilesToItems(
    project.files,
    project.companyUid,
  );
  statusByChannelId[channelId] = projectToStatus(project);
}

function matchProjectForDirectoryRow(
  row: MeshDirectoryRow,
  projects: MeshProjectView[],
  genesisByProject: Map<string, MeshGenesisLink>,
): MeshProjectView | undefined {
  const projectId = (row.projectId ?? "").trim();
  if (projectId) {
    const byProjectId = projects.find(
      (project) => project.projectId === projectId,
    );
    if (byProjectId) return byProjectId;
  }
  const byGenesis = projects.find(
    (project) =>
      genesisByProject.get(project.projectId)?.channelId === row.channelId,
  );
  if (byGenesis) return byGenesis;
  const byId = projects.find((project) => project.projectId === row.channelId);
  if (byId) return byId;
  if (row.type !== "project") return undefined;
  const name = row.name.toLowerCase();
  return projects.find((project) => {
    const slug = project.projectId.toLowerCase();
    return name.includes(slug);
  });
}

/**
 * Sidebar rows come from the server directory when present (project + chat +
 * dm). Project views still attach Board/Status onto matching project rows.
 * If the directory cache is empty, fall back to project views + unlinked
 * channel files (legacy).
 */
export function overlayFromSnapshot(
  snapshot: WorkMeshSnapshot,
): MeshShellOverlay {
  const channelById = new Map(
    snapshot.channels.map((c) => [c.channelId, c] as const),
  );
  const genesisByProject = new Map(
    snapshot.genesis.map((g) => [g.projectId, g] as const),
  );
  const rows: MeshDirectoryRow[] = [];
  const messagesByChannelId: Record<string, MeshCachedMessage[]> = {};
  const boardByChannelId: Record<string, MeshBoardTab> = {};
  const filesByChannelId: Record<string, MeshFileItem[]> = {};
  const statusByChannelId: Record<string, MeshChannelStatus> = {};
  const seen = new Set<string>();
  const boundProjects = new Set<string>();

  const genesisByChannel = new Map(
    snapshot.genesis.map((g) => [g.channelId, g] as const),
  );

  for (const row of snapshot.directory) {
    const channel = channelById.get(row.channelId);
    const project = matchProjectForDirectoryRow(
      row,
      snapshot.projects,
      genesisByProject,
    );
    const genesis =
      (project && genesisByProject.get(project.projectId)) ||
      genesisByChannel.get(row.channelId);
    const lastActivityAt = directoryActivityAt(row, channel, project, genesis);
    const named =
      (!isPlaceholderDirectoryName(row.name, row.type) && row.name.trim()) ||
      displayNameFromMessages(channel) ||
      row.subtitle ||
      row.name;
    rows.push({
      ...row,
      name: named,
      lastActivityAt,
    });
    seen.add(row.channelId);
    messagesByChannelId[row.channelId] = sortOldestFirst(
      channel?.messages ?? [],
    );
    if (project) {
      boundProjects.add(project.projectId);
      boardByChannelId[row.channelId] = projectViewToBoard(project);
      filesByChannelId[row.channelId] = projectFilesToItems(
        project.files,
        project.companyUid,
      );
      statusByChannelId[row.channelId] = projectToStatus(project);
    }
  }

  for (const project of snapshot.projects) {
    if (boundProjects.has(project.projectId)) continue;
    const genesis = genesisByProject.get(project.projectId);
    const channelId = genesis?.channelId ?? project.projectId;
    bindProject(
      project,
      channelId,
      channelById.get(channelId),
      genesis,
      rows,
      messagesByChannelId,
      boardByChannelId,
      filesByChannelId,
      statusByChannelId,
      seen,
    );
  }

  for (const channel of snapshot.channels) {
    if (seen.has(channel.channelId)) continue;
    const last =
      [...channel.messages.map((m) => m.createdAt)].sort().at(-1) ?? null;
    rows.push({
      channelId: channel.channelId,
      type: "chat",
      scope: "company",
      companyUid: null,
      name: channel.channelId,
      lastActivityAt: last,
      unreadCount: 0,
      memberCount: 0,
    });
    seen.add(channel.channelId);
    messagesByChannelId[channel.channelId] = sortOldestFirst(channel.messages);
  }

  rows.sort((a, b) => {
    const at = Date.parse(a.lastActivityAt ?? "") || 0;
    const bt = Date.parse(b.lastActivityAt ?? "") || 0;
    return bt - at;
  });

  return {
    rows,
    messagesByChannelId,
    boardByChannelId,
    filesByChannelId,
    statusByChannelId,
  };
}

export function statusLineFor(status: MeshStoryStatus): string {
  const key = status.toString().toLowerCase();
  return STATUS_LINE[key] ?? status.toString().toUpperCase();
}
