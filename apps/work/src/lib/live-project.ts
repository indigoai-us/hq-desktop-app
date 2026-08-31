/**
 * Live PROJECT_VIEW + roster + work-sessions for the hosted web shell.
 * Desktop reads these from ~/.hq; web fetches the same shapes from hq-pro.
 */

import {
  isProjectArtifactPath,
  parseMeshProjectView,
  projectFilesToItems,
  projectToStatus,
  projectViewToBoard,
  type MeshProjectFile,
  type MeshProjectView,
} from "@hq/core";
import {
  buildChannelStatusModel,
  parseChannelMembers,
  type BoardTabData,
  type ChannelFileItemModel,
  type ChannelStatusModel,
  type ConversationRow,
  type ServerWorkSessionInput,
  type StatusMemberInput,
} from "@hq/ui";
import { hqProFetch } from "./hq-pro-client.js";

export interface LiveProjectMeta {
  board: BoardTabData | null;
  files: ChannelFileItemModel[];
  status: ChannelStatusModel | null;
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function fetchJson(path: string): Promise<unknown | null> {
  try {
    const res = await hqProFetch(path);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function vaultObjects(raw: unknown): Array<Record<string, unknown>> {
  const body = rec(raw);
  const list = Array.isArray(body?.objects)
    ? body.objects
    : Array.isArray(body?.entries)
      ? body.entries
      : [];
  return list.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

export async function listVaultProjectFiles(
  companyUid: string,
  projectId: string,
): Promise<ChannelFileItemModel[]> {
  if (!companyUid || !projectId) return [];
  const prefix = `projects/${projectId}/`;
  const raw = await fetchJson(
    `/v1/files/list?company=${encodeURIComponent(companyUid)}&prefix=${encodeURIComponent(prefix)}`,
  );
  const files: MeshProjectFile[] = [];
  for (const obj of vaultObjects(raw)) {
    const key = String(obj.key ?? obj.path ?? "").trim();
    if (!isProjectArtifactPath(key)) continue;
    const name = String(obj.name ?? "").trim() || key.split("/").pop() || key;
    files.push({
      path: key,
      name,
      updatedAt:
        typeof obj.lastModified === "string" ? obj.lastModified : undefined,
      size: typeof obj.size === "number" ? obj.size : undefined,
    });
  }
  return projectFilesToItems(files, companyUid) as ChannelFileItemModel[];
}

export async function loadVaultFilePreview(
  item: ChannelFileItemModel,
): Promise<string | null> {
  const companyUid = (item.companyUid ?? "").trim();
  const key = (item.vaultPath ?? "").trim();
  if (!companyUid || !key) return item.previewText ?? null;
  try {
    const res = await hqProFetch("/v1/files/presign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ company: companyUid, op: "get", key }),
    });
    if (!res.ok) return null;
    const body = rec(await res.json());
    const results = Array.isArray(body?.results) ? body.results : [];
    const first = rec(results[0]);
    const url = typeof first?.url === "string" ? first.url : "";
    if (!url) return null;
    const file = await fetch(url);
    if (!file.ok) return null;
    const text = await file.text();
    return text.length > 200_000 ? `${text.slice(0, 200_000)}\n…` : text;
  } catch {
    return null;
  }
}

export { parseChannelMembers } from "@hq/ui";

export function parseWorkSessions(raw: unknown): ServerWorkSessionInput[] {
  const body = rec(raw);
  const list = [
    ...(Array.isArray(body?.active) ? body.active : []),
    ...(Array.isArray(body?.recent) ? body.recent : []),
  ];
  const out: ServerWorkSessionInput[] = [];
  for (const item of list) {
    const row = rec(item);
    if (!row) continue;
    out.push({
      sessionId: typeof row.sessionId === "string" ? row.sessionId : null,
      threadId: typeof row.threadId === "string" ? row.threadId : null,
      status: typeof row.status === "string" ? row.status : null,
      harness: typeof row.harness === "string" ? row.harness : null,
      ownerUid: typeof row.ownerUid === "string" ? row.ownerUid : null,
      ownerType: typeof row.ownerType === "string" ? row.ownerType : null,
      progressSummary:
        typeof row.progressSummary === "string" ? row.progressSummary : null,
      progressPercent:
        typeof row.progressPercent === "number" ? row.progressPercent : null,
      blockedReason:
        typeof row.blockedReason === "string" ? row.blockedReason : null,
      lastActivityAt:
        typeof row.lastActivityAt === "string" ? row.lastActivityAt : null,
      createdAt: typeof row.createdAt === "string" ? row.createdAt : null,
    });
  }
  return out;
}

export function metaFromProjectView(
  view: MeshProjectView,
  members: StatusMemberInput[],
  sessions: ServerWorkSessionInput[],
  companyLabel?: string | null,
): LiveProjectMeta {
  const board = projectViewToBoard(view) as BoardTabData;
  const files = projectFilesToItems(
    view.files,
    view.companyUid,
  ) as ChannelFileItemModel[];
  const status = buildChannelStatusModel({
    project: {
      id: view.projectId,
      title: view.name || view.projectId,
      storiesTotal: view.stories.length,
      storiesComplete: view.stories.filter((story) => story.passes === true)
        .length,
      description: view.description ?? null,
    },
    prd: {
      name: view.name,
      repos: view.repos,
      userStories: view.stories.map((story) => ({
        id: story.id,
        title: story.title,
        passes: story.passes,
      })),
    },
    members,
    serverSessions: sessions,
    companyLabel,
  });
  return { board, files, status };
}

export async function loadLiveProjectMeta(
  row: ConversationRow,
  companyLabel?: string | null,
): Promise<LiveProjectMeta | null> {
  const projectId = (row.projectId ?? "").trim();
  const companyUid = (row.companyUid ?? "").trim();
  const channelId = (row.channelId ?? "").trim();
  if (!channelId.startsWith("chn_") && (!projectId || !companyUid)) {
    return null;
  }

  const [viewRaw, membersRaw, sessionsRaw] = await Promise.all([
    projectId && companyUid
      ? fetchJson(
          `/v1/work-mesh/projects/${encodeURIComponent(projectId)}?companyUid=${encodeURIComponent(companyUid)}`,
        )
      : Promise.resolve(null),
    channelId.startsWith("chn_")
      ? fetchJson(
          `/v1/notify/channels/${encodeURIComponent(channelId)}/members`,
        )
      : Promise.resolve(null),
    projectId && companyUid
      ? fetchJson(
          `/v1/work-mesh/work-sessions?companyUid=${encodeURIComponent(companyUid)}&projectId=${encodeURIComponent(projectId)}`,
        )
      : Promise.resolve(null),
  ]);

  const view = parseMeshProjectView(viewRaw);
  const members = parseChannelMembers(membersRaw);
  const sessions = parseWorkSessions(sessionsRaw);
  if (view) {
    const meta = metaFromProjectView(view, members, sessions, companyLabel);
    if (meta.files.length > 0) return meta;
    const vaultFiles = await listVaultProjectFiles(companyUid, projectId);
    return { ...meta, files: vaultFiles };
  }
  if (members.length === 0 && sessions.length === 0) return null;
  return {
    board: null,
    files: [],
    status: buildChannelStatusModel({
      project: { id: projectId, title: row.title },
      members,
      serverSessions: sessions,
      companyLabel,
    }),
  };
}

export { projectToStatus };
