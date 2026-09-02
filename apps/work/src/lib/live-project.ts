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
  loadVaultFilePreview,
  type BoardTabData,
  type ChannelFileItemModel,
  type ChannelFilePreview,
  type ChannelStatusModel,
  type ConversationRow,
  type ServerWorkSessionInput,
  type StatusMemberInput,
  type VaultFilePreviewRequest,
} from "@hq/ui";
import { hqProFetch, type HqProFetch } from "./hq-pro-client.js";

export interface LiveProjectMeta {
  board: BoardTabData | null;
  files: ChannelFileItemModel[];
  status: ChannelStatusModel | null;
}

export interface LiveProjectMetaLoad {
  meta: LiveProjectMeta | null;
  definitiveMiss: boolean;
}

export interface LiveProjectDeps {
  fetch?: HqProFetch;
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type JsonFetchResult =
  | { kind: "ok"; value: unknown }
  | { kind: "not-found"; value: null }
  | { kind: "error"; value: null };

async function fetchJson(
  path: string,
  fetchImpl: HqProFetch = hqProFetch,
): Promise<JsonFetchResult> {
  try {
    const res = await fetchImpl(path);
    if (res.status === 404) return { kind: "not-found", value: null };
    if (!res.ok) return { kind: "error", value: null };
    return { kind: "ok", value: await res.json() };
  } catch {
    return { kind: "error", value: null };
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
  deps: LiveProjectDeps = {},
): Promise<ChannelFileItemModel[]> {
  if (!companyUid || !projectId) return [];
  const prefix = `projects/${projectId}/`;
  const { value: raw } = await fetchJson(
    `/v1/files/list?company=${encodeURIComponent(companyUid)}&prefix=${encodeURIComponent(prefix)}`,
    deps.fetch ?? hqProFetch,
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

type WebVaultPresignResult = Awaited<
  ReturnType<VaultFilePreviewRequest["presign"]>
>;

async function presignWebVaultGet(
  companyUid: string,
  key: string,
  fetchImpl: HqProFetch = hqProFetch,
): Promise<WebVaultPresignResult> {
  try {
    const response = await fetchImpl("/v1/files/presign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ company: companyUid, op: "get", key }),
    });
    if (!response.ok) {
      return {
        ok: false,
        code: `http-${response.status}`,
        message: response.statusText,
      };
    }
    return { ok: true, value: await response.json() };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "network failure",
    };
  }
}

/** Web host transport for the shared, bounded Vault preview policy. */
export function loadWebVaultFilePreview(
  item: ChannelFileItemModel,
  selectedCompanyUid: string | null | undefined,
  deps: LiveProjectDeps = {},
): Promise<ChannelFilePreview> {
  return loadVaultFilePreview({
    item,
    selectedCompanyUid,
    presign: (companyUid, key) =>
      presignWebVaultGet(companyUid, key, deps.fetch ?? hqProFetch),
    get: (url, maxBytes) =>
      fetch("/api/chat-attachment-bytes", {
        headers: {
          "x-hq-source-url": url,
          "x-hq-max-bytes": String(maxBytes),
        },
      }),
  });
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
  deps: LiveProjectDeps = {},
): Promise<LiveProjectMetaLoad> {
  const projectId = (row.projectId ?? "").trim();
  const companyUid = (row.companyUid ?? "").trim();
  const channelId = (row.channelId ?? "").trim();
  if (!channelId.startsWith("chn_") && (!projectId || !companyUid)) {
    return { meta: null, definitiveMiss: true };
  }

  const fetchImpl = deps.fetch ?? hqProFetch;
  const [viewRaw, membersRaw, sessionsRaw] = await Promise.all([
    projectId && companyUid
      ? fetchJson(
          `/v1/work-mesh/projects/${encodeURIComponent(projectId)}?companyUid=${encodeURIComponent(companyUid)}`,
          fetchImpl,
        )
      : Promise.resolve({ kind: "not-found", value: null } as const),
    channelId.startsWith("chn_")
      ? fetchJson(
          `/v1/notify/channels/${encodeURIComponent(channelId)}/members`,
          fetchImpl,
        )
      : Promise.resolve({ kind: "not-found", value: null } as const),
    projectId && companyUid
      ? fetchJson(
          `/v1/work-mesh/work-sessions?companyUid=${encodeURIComponent(companyUid)}&projectId=${encodeURIComponent(projectId)}`,
          fetchImpl,
        )
      : Promise.resolve({ kind: "not-found", value: null } as const),
  ]);

  const view = parseMeshProjectView(viewRaw.value);
  const members = parseChannelMembers(membersRaw.value);
  const sessions = parseWorkSessions(sessionsRaw.value);
  if (view) {
    const meta = metaFromProjectView(view, members, sessions, companyLabel);
    if (meta.files.length > 0) return { meta, definitiveMiss: false };
    const vaultFiles = await listVaultProjectFiles(companyUid, projectId, {
      fetch: fetchImpl,
    });
    return { meta: { ...meta, files: vaultFiles }, definitiveMiss: false };
  }
  if (members.length === 0 && sessions.length === 0) {
    return {
      meta: null,
      definitiveMiss:
        viewRaw.kind === "not-found" &&
        membersRaw.kind === "not-found" &&
        sessionsRaw.kind === "not-found",
    };
  }
  return {
    meta: {
      board: null,
      files: [],
      status: buildChannelStatusModel({
        project: { id: projectId, title: row.title },
        members,
        serverSessions: sessions,
        companyLabel,
      }),
    },
    definitiveMiss: false,
  };
}

export { projectToStatus };
