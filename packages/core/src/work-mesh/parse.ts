import type {
  MeshCachedChannel,
  MeshCachedMention,
  MeshCachedMessage,
  MeshCachedReaction,
  MeshDirectoryRow,
  MeshDirectoryScope,
  MeshDirectoryType,
  MeshGenesisLink,
  MeshProjectView,
  MeshProjectFile,
  MeshRepo,
  MeshStory,
  WorkMeshSnapshot,
} from "./types.js";
import { isProjectArtifactPath } from "./project-files.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function parseMeshStory(raw: unknown): MeshStory | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id).trim();
  const title = asString(raw.title).trim();
  if (!id) return null;
  return {
    id,
    title: title || id,
    description: asOptionalString(raw.description),
    acceptanceCriteria: Array.isArray(raw.acceptanceCriteria)
      ? (raw.acceptanceCriteria as MeshStory["acceptanceCriteria"])
      : [],
    status: asOptionalString(raw.status),
    passes: asBool(raw.passes),
    priority: asNumber(raw.priority),
  };
}

export function parseMeshProjectView(raw: unknown): MeshProjectView | null {
  if (!isRecord(raw)) return null;
  const companyUid = asString(raw.companyUid).trim();
  const projectId = asString(raw.projectId).trim();
  if (!companyUid || !projectId) return null;
  const storySource = Array.isArray(raw.stories)
    ? raw.stories
    : Array.isArray(raw.userStories)
      ? raw.userStories
      : [];
  const stories = storySource
    .map(parseMeshStory)
    .filter((s): s is MeshStory => s !== null);
  const repos: MeshRepo[] = Array.isArray(raw.repos)
    ? raw.repos.flatMap((item) => {
        if (!isRecord(item)) return [];
        const path = asString(item.path).trim();
        if (!path) return [];
        return [{ path, branch: asOptionalString(item.branch) }];
      })
    : [];
  const files: MeshProjectFile[] = Array.isArray(raw.files)
    ? raw.files.flatMap((item) => {
        if (!isRecord(item)) return [];
        const path = asString(item.path).trim();
        if (!path || !isProjectArtifactPath(path)) return [];
        const name =
          asString(item.name).trim() ||
          path.split("/").filter(Boolean).pop() ||
          path;
        return [
          {
            path,
            name,
            updatedAt: asOptionalString(item.updatedAt ?? item.lastModified),
            size: asNumber(item.size),
          },
        ];
      })
    : [];
  return {
    companyUid,
    projectId,
    name: asOptionalString(raw.name),
    description: asOptionalString(raw.description),
    stories,
    repos,
    ...(files.length > 0 ? { files } : {}),
    updatedAt: asOptionalString(raw.updatedAt),
    updatedBy: asOptionalString(raw.updatedBy),
    lastActivityAt: asOptionalString(raw.lastActivityAt),
    createdAt: asOptionalString(raw.createdAt),
    version: asNumber(raw.version),
  };
}

export function parseCachedMentions(raw: unknown): MeshCachedMention[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: MeshCachedMention[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const participantUid = asString(
      item.participantUid ?? item.participant_uid,
    ).trim();
    const displayName = asString(item.displayName ?? item.display_name).trim();
    if (!participantUid || !displayName) continue;
    const participantType = asOptionalString(
      item.participantType ?? item.participant_type,
    );
    out.push({
      participantUid,
      displayName,
      ...(participantType ? { participantType } : {}),
    });
  }
  return out;
}

export function parseCachedReactions(raw: unknown): MeshCachedReaction[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.reactions)
      ? raw.reactions
      : [];
  const out: MeshCachedReaction[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const emoji = asString(item.emoji).trim();
    if (!emoji) continue;
    out.push({
      emoji,
      count: asNumber(item.count) ?? 0,
      reactedByMe: Boolean(item.reactedByMe ?? item.reacted_by_me),
    });
  }
  return out;
}

export function parseMeshCachedMessage(raw: unknown): MeshCachedMessage | null {
  if (!isRecord(raw)) return null;
  const eventId = asString(raw.eventId).trim();
  const createdAt = asString(raw.createdAt).trim();
  if (!eventId || !createdAt) return null;
  const reactions = parseCachedReactions(raw.reactions);
  const mentions = parseCachedMentions(raw.mentions);
  return {
    eventId,
    fromPersonUid: asOptionalString(raw.fromPersonUid),
    fromEmail: asOptionalString(raw.fromEmail),
    fromDisplayName: asOptionalString(raw.fromDisplayName),
    body: typeof raw.body === "string" ? raw.body : undefined,
    details: typeof raw.details === "string" ? raw.details : undefined,
    prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
    createdAt,
    direction: asOptionalString(raw.direction),
    messageKind: asOptionalString(raw.messageKind),
    systemEvent: raw.systemEvent,
    ...(reactions.length > 0 ? { reactions } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
  };
}

export function parseMeshCachedChannel(
  channelId: string,
  raw: unknown,
): MeshCachedChannel | null {
  const id = channelId.trim();
  if (!id) return null;
  const body = isRecord(raw) ? raw : {};
  const list = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(raw)
      ? raw
      : [];
  return {
    channelId: id,
    messages: list
      .map(parseMeshCachedMessage)
      .filter((m): m is MeshCachedMessage => m !== null),
  };
}

export function parseMeshGenesis(raw: unknown): MeshGenesisLink | null {
  if (!isRecord(raw)) return null;
  const projectId = asString(raw.projectId).trim();
  const channelId = asString(raw.channelId).trim();
  if (!projectId || !channelId) return null;
  return {
    projectId,
    channelId,
    channelName: asOptionalString(raw.channelName),
    createdAt: asOptionalString(raw.createdAt) ?? asOptionalString(raw.at),
  };
}

export function parseMeshDirectoryType(value: unknown): MeshDirectoryType {
  const raw = asString(value).trim().toLowerCase();
  if (raw === "chat" || raw === "dm" || raw === "project") return raw;
  return "project";
}

export function parseMeshDirectoryScope(
  value: unknown,
  type: MeshDirectoryType,
): MeshDirectoryScope {
  const raw = asString(value).trim().toLowerCase();
  if (
    raw === "personal" ||
    raw === "company" ||
    raw === "project" ||
    raw === "group"
  ) {
    return raw;
  }
  if (type === "dm") return "group";
  if (type === "chat") return "company";
  return "project";
}

export function parseMeshDirectoryRow(raw: unknown): MeshDirectoryRow | null {
  if (!isRecord(raw)) return null;
  const channelId = asString(raw.channelId).trim();
  if (!channelId) return null;
  const type = parseMeshDirectoryType(raw.type);
  const scope = parseMeshDirectoryScope(raw.scope, type);
  const name =
    asString(raw.name).trim() ||
    asString(raw.subtitle).trim() ||
    (type === "dm" ? "Direct message" : type === "chat" ? "Chat" : channelId);
  const unread = asNumber(raw.unreadCount);
  const members = asNumber(raw.memberCount);
  const last = asString(raw.lastActivityAt).trim();
  return {
    channelId,
    type,
    scope,
    companyUid: asOptionalString(raw.companyUid) ?? null,
    projectId:
      asOptionalString(raw.projectId) ??
      asOptionalString(raw.project_id) ??
      null,
    name,
    subtitle: asOptionalString(raw.subtitle),
    lastActivityAt: last || null,
    unreadCount: unread ?? 0,
    memberCount: members ?? 0,
  };
}

function parseDirectoryList(raw: unknown): MeshDirectoryRow[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.channels)
      ? raw.channels
      : isRecord(raw) && Array.isArray(raw.rows)
        ? raw.rows
        : [];
  const out: MeshDirectoryRow[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const parsed = parseMeshDirectoryRow(item);
    if (!parsed || seen.has(parsed.channelId)) continue;
    seen.add(parsed.channelId);
    out.push(parsed);
  }
  return out;
}

export function parseWorkMeshSnapshot(raw: unknown): WorkMeshSnapshot {
  if (!isRecord(raw)) {
    return { projects: [], channels: [], genesis: [], directory: [] };
  }
  const projects = Array.isArray(raw.projects)
    ? raw.projects
        .map(parseMeshProjectView)
        .filter((p): p is MeshProjectView => p !== null)
    : [];
  const channels = Array.isArray(raw.channels)
    ? raw.channels.flatMap((item) => {
        if (!isRecord(item)) return [];
        const parsed = parseMeshCachedChannel(asString(item.channelId), item);
        return parsed ? [parsed] : [];
      })
    : [];
  const genesis = Array.isArray(raw.genesis)
    ? raw.genesis
        .map(parseMeshGenesis)
        .filter((g): g is MeshGenesisLink => g !== null)
    : [];
  const directory = parseDirectoryList(raw.directory);
  return { projects, channels, genesis, directory };
}
