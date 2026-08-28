/**
 * Shared work-mesh cache + PROJECT_VIEW shapes.
 *
 * Desktop reads these from ~/.hq/work-mesh/cache (and fabric-genesis.json
 * sidecars). Web can feed the same JSON from hq-pro REST. MQTT is ids-only;
 * this module never treats a wake payload as state.
 */

export type MeshStoryStatus =
  "queued" | "in_progress" | "review" | "done" | "blocked" | "todo" | string;

export interface MeshStory {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria?: Array<string | { text: string; done?: boolean }>;
  status?: MeshStoryStatus;
  passes?: boolean;
  priority?: number;
}

export interface MeshRepo {
  path: string;
  branch?: string;
}

/** Project artifact in the HQ project directory (prd, brainstorm, runbook). */
export interface MeshProjectFile {
  path: string;
  name: string;
  updatedAt?: string;
  size?: number;
}

export interface MeshProjectView {
  companyUid: string;
  projectId: string;
  name?: string;
  description?: string;
  stories: MeshStory[];
  repos: MeshRepo[];
  files?: MeshProjectFile[];
  updatedAt?: string;
  updatedBy?: string;
  /** Honest last human/agent work, not a doctor/ensure-project stamp. */
  lastActivityAt?: string;
  /** Project created date — sidebar fallback when no activity signals exist. */
  createdAt?: string;
  version?: number;
}

export interface MeshCachedReaction {
  emoji: string;
  count: number;
  reactedByMe: boolean;
}

export interface MeshCachedMention {
  participantUid: string;
  participantType?: string;
  displayName: string;
}

export interface MeshCachedMessage {
  eventId: string;
  fromPersonUid?: string;
  fromEmail?: string;
  fromDisplayName?: string;
  body?: string;
  details?: string;
  prompt?: string;
  createdAt: string;
  direction?: string;
  messageKind?: string;
  systemEvent?: unknown;
  /** Emoji aggregates from GET /v1/notify/reactions — painted before live fetch. */
  reactions?: MeshCachedReaction[];
  /** Structured @-mentions from CHAN_MSG.mentions. */
  mentions?: MeshCachedMention[];
}

export interface MeshCachedChannel {
  channelId: string;
  messages: MeshCachedMessage[];
}

export interface MeshGenesisLink {
  projectId: string;
  channelId: string;
  channelName?: string;
  createdAt?: string;
}

/** One desktop (or test) snapshot of the local mesh resources. */
export interface WorkMeshSnapshot {
  projects: MeshProjectView[];
  channels: MeshCachedChannel[];
  genesis: MeshGenesisLink[];
  /** Server directory rows (project + chat + dm). Empty if the cache has none. */
  directory: MeshDirectoryRow[];
}

export type MeshDirectoryType = "project" | "chat" | "dm";
export type MeshDirectoryScope = "personal" | "company" | "project" | "group";

/** Sidebar row the host folds into ChatSidebarApi. */
export interface MeshDirectoryRow {
  channelId: string;
  type: MeshDirectoryType;
  scope: MeshDirectoryScope;
  companyUid: string | null;
  /** Bound work-mesh project when the directory/cache row carried one. */
  projectId?: string | null;
  name: string;
  subtitle?: string;
  lastActivityAt: string | null;
  unreadCount: number;
  memberCount: number;
}

export interface MeshBoardCard {
  storyId: string;
  label: string;
  statusLine: string;
}

export interface MeshBoardColumn {
  id: string;
  title: string;
  cards: MeshBoardCard[];
}

export interface MeshBoardStoryPanel {
  id: string;
  title: string;
  statusBadge: string;
  description: string;
  fields: {
    status: string;
    assignee: string;
    project: string;
    branch: string;
  };
  acceptanceCriteria: { text: string; done: boolean }[];
  acCountLabel: string;
  activity: { id: string; at: string; text: string }[];
}

export interface MeshBoardTab {
  columns: MeshBoardColumn[];
  stories: Record<string, MeshBoardStoryPanel>;
}

export type MeshFileIconKind = "image" | "pdf" | "markdown" | "text" | "file";

export interface MeshFileItem {
  key: string;
  vaultPath: string;
  name: string;
  caption: string;
  iconKind: MeshFileIconKind;
  companyUid?: string;
  updatedAt?: string;
}

export interface MeshChannelStatus {
  companyLabel: string | null;
  /** Project slug when this status came from a PROJECT_VIEW. */
  projectId?: string | null;
  /** Last mesh writer (prs_* / agt_*) when the view carries it. */
  updatedBy?: string | null;
  /** PROJECT_VIEW blurb — empty when genesis stubbed the view. */
  description?: string | null;
  storiesTotal: number;
  storiesComplete: number;
  repos: MeshRepo[];
  liveAgents: Array<{
    id: string;
    label: string;
    storyId?: string;
    progressPercent?: number;
    status: string;
    displayName: string;
  }>;
}

export interface MeshShellOverlay {
  rows: MeshDirectoryRow[];
  messagesByChannelId: Record<string, MeshCachedMessage[]>;
  boardByChannelId: Record<string, MeshBoardTab>;
  filesByChannelId: Record<string, MeshFileItem[]>;
  statusByChannelId: Record<string, MeshChannelStatus>;
}
