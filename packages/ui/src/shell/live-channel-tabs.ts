/**
 * Live Board / Files / Status for a project channel.
 *
 * Overlay cache matching can miss (no genesis, no projectId on the row).
 * GET /v1/work-mesh/projects/{id} is company-membership gated — channel
 * members who belong to the company can read the same project view as the
 * creator. Vault list is a files fallback when PROJECT_VIEW.files is empty.
 */
import {
  isProjectArtifactPath,
  parseMeshProjectView,
  parseMeshStory,
  projectFilesToItems,
  projectToStatus,
  projectViewToBoard,
  type MeshProjectView,
  type MeshStory,
} from "@hq/core";
import {
  buildChannelStatusModel,
  type ChannelStatusModel,
  type LiveReadSessionInput,
  type StatusMemberInput,
  type StatusPresenceInput,
} from "../chat/channel-status-model.js";
import { liveInputsForCompanyProject } from "../chat/live-read-store.svelte.js";
import type {
  BoardTabData,
  ChannelFileItemModel,
} from "../chat/messaging/channelTabModels.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

export interface LiveChannelTabs {
  board: BoardTabData | null;
  files: ChannelFileItemModel[];
  status: ChannelStatusModel | null;
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function vaultObjects(raw: unknown): Array<Record<string, unknown>> {
  const body = rec(raw);
  const list = Array.isArray(body?.objects)
    ? body.objects
    : Array.isArray(body?.entries)
      ? body.entries
      : Array.isArray(raw)
        ? raw
        : [];
  return list.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

export function filesFromVaultList(
  raw: unknown,
  companyUid: string,
): ChannelFileItemModel[] {
  const files = [];
  for (const obj of vaultObjects(raw)) {
    const key = String(obj.key ?? obj.path ?? "").trim();
    if (!isProjectArtifactPath(key)) continue;
    const name = String(obj.name ?? "").trim() || key.split("/").pop() || key;
    files.push({
      path: key,
      name,
      updatedAt:
        typeof obj.lastModified === "string"
          ? obj.lastModified
          : typeof obj.updatedAt === "string"
            ? obj.updatedAt
            : undefined,
      size: typeof obj.size === "number" ? obj.size : undefined,
    });
  }
  return projectFilesToItems(files, companyUid) as ChannelFileItemModel[];
}

export function tabsFromProjectView(
  raw: unknown,
  members: StatusMemberInput[],
  companyLabel?: string | null,
  live?: {
    liveSessions?: LiveReadSessionInput[];
    presence?: StatusPresenceInput[];
  },
): LiveChannelTabs | null {
  const envelope = rec(raw);
  const view =
    parseMeshProjectView(raw) ??
    parseMeshProjectView(envelope?.project) ??
    parseMeshProjectView(envelope?.view);
  if (!view) return null;
  const liveSessions = live?.liveSessions ?? [];
  const board = projectViewToBoard(view, {
    liveSessions: liveSessions.map((s) => ({
      sessionId: s.sessionId,
      actorUid: s.actorUid,
      displayName: s.displayName ?? undefined,
      harness: s.harness,
      taskId: s.taskId,
      turnCount: s.turnCount,
      lastTurnAt: s.lastTurnAt,
      actorType: s.actorType,
    })),
  }) as BoardTabData;
  const files = projectFilesToItems(
    view.files,
    view.companyUid,
  ) as ChannelFileItemModel[];
  const mesh = projectToStatus(view);
  const status = buildChannelStatusModel({
    project: {
      id: view.projectId,
      title: view.name || view.projectId,
      storiesTotal: mesh.storiesTotal,
      storiesComplete: mesh.storiesComplete,
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
    liveSessions,
    presence: live?.presence,
    companyLabel: companyLabel ?? mesh.companyLabel,
  });
  return { board, files, status };
}

export function rosterStatusForRow(
  row: ConversationRow,
  members: StatusMemberInput[],
  companyLabel?: string | null,
  companyIconUrl?: string | null,
): ChannelStatusModel {
  return buildChannelStatusModel({
    project: {
      id: row.projectId || row.channelId || row.id,
      title: row.title,
    },
    members,
    companyLabel,
    // Prefer the row's server-stamped icon; the caller may pass the roster
    // lookup as a fallback for rows that only carry a companyUid.
    companyIconUrl: row.iconUrl ?? companyIconUrl ?? null,
  });
}

function slugFromTitle(title: string): string {
  return title.replace(/^#\s*/, "").trim();
}

function kebabSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function projectIdCandidates(row: ConversationRow | null): string[] {
  if (!row) return [];
  const out: string[] = [];
  const add = (value: string) => {
    const next = value.trim();
    if (next && !out.includes(next)) out.push(next);
  };
  add(row.projectId ?? "");
  if ((row.channelScope ?? "").trim() === "project") {
    const title = slugFromTitle(row.title ?? "");
    add(title);
    add(kebabSlug(title));
  }
  return out;
}

export function projectIdForRow(row: ConversationRow | null): string {
  return projectIdCandidates(row)[0] ?? "";
}

export function projectTabKey(row: ConversationRow | null): string {
  if (!row) return "";
  const projectId = projectIdForRow(row);
  const companyUid = (row.companyUid ?? "").trim();
  const channelId = (row.channelId ?? "").trim();
  return `${companyUid}:${projectId || channelId}`;
}

/** HQ vault PRD (`userStories`) → mesh stories when PROJECT_VIEW is empty. */
export function storiesFromPrd(raw: unknown): MeshStory[] {
  const body = rec(raw);
  const list = Array.isArray(body?.userStories)
    ? body.userStories
    : Array.isArray(body?.stories)
      ? body.stories
      : [];
  return list
    .map(parseMeshStory)
    .filter((story): story is MeshStory => story != null);
}

function viewWithStories(
  base: MeshProjectView,
  stories: MeshStory[],
): MeshProjectView {
  if ((base.stories?.length ?? 0) > 0 || stories.length === 0) return base;
  return { ...base, stories };
}

function parsePrdText(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function listedProjectId(listed: unknown, candidates: string[]): string | null {
  const wanted = new Set(candidates.map((id) => id.toLowerCase()));
  for (const obj of vaultObjects(listed)) {
    const key = String(obj.key ?? obj.path ?? "");
    const hit = key.match(/^projects\/([^/]+)\//);
    if (hit && wanted.has(hit[1].toLowerCase())) return hit[1];
  }
  return null;
}

export async function loadLiveChannelTabs(opts: {
  row: ConversationRow;
  members?: StatusMemberInput[];
  companyLabel?: string | null;
  companyUidFallback?: string | null;
  getProjectView: (
    projectId: string,
    companyUid: string,
  ) => Promise<unknown | null>;
  listVaultPrefix?: (
    companyUid: string,
    prefix: string,
  ) => Promise<unknown | null>;
  getVaultText?: (companyUid: string, key: string) => Promise<string | null>;
}): Promise<LiveChannelTabs | null> {
  const candidates = projectIdCandidates(opts.row);
  const companyUid =
    (opts.row.companyUid ?? "").trim() ||
    (opts.companyUidFallback ?? "").trim();
  if (candidates.length === 0 || !companyUid) return null;
  const members = opts.members ?? [];

  let tabs: LiveChannelTabs | null = null;
  let resolvedId = candidates[0] ?? "";
  for (const projectId of candidates) {
    let raw: unknown = null;
    try {
      raw = await opts.getProjectView(projectId, companyUid);
    } catch {
      raw = null;
    }
    const projectLive = liveInputsForCompanyProject(companyUid, projectId);
    tabs = tabsFromProjectView(raw, members, opts.companyLabel, projectLive);
    const boardEmpty = !tabs?.board?.columns.some(
      (column) => column.cards.length > 0,
    );
    if (boardEmpty && opts.getVaultText) {
      let text: string | null = null;
      try {
        text = await opts.getVaultText(
          companyUid,
          `projects/${projectId}/prd.json`,
        );
      } catch {
        text = null;
      }
      const stories = storiesFromPrd(parsePrdText(text));
      if (stories.length > 0) {
        const existing =
          parseMeshProjectView(raw) ??
          parseMeshProjectView(rec(raw)?.project) ??
          parseMeshProjectView(rec(raw)?.view);
        const view: MeshProjectView = viewWithStories(
          existing ?? {
            companyUid,
            projectId,
            name: opts.row.title || projectId,
            stories: [],
            repos: [],
          },
          stories,
        );
        tabs = tabsFromProjectView(
          view,
          members,
          opts.companyLabel,
          projectLive,
        );
      }
    }
    if (tabs?.board?.columns.some((column) => column.cards.length > 0)) {
      resolvedId = projectId;
      break;
    }
  }

  const hasCards = Boolean(
    tabs?.board?.columns.some((column) => column.cards.length > 0),
  );
  if (!hasCards && opts.listVaultPrefix) {
    let listed: unknown = null;
    try {
      listed = await opts.listVaultPrefix(companyUid, "projects/");
    } catch {
      listed = null;
    }
    const matched = listedProjectId(listed, candidates);
    if (matched && opts.getVaultText) {
      let text: string | null = null;
      try {
        text = await opts.getVaultText(
          companyUid,
          `projects/${matched}/prd.json`,
        );
      } catch {
        text = null;
      }
      const stories = storiesFromPrd(parsePrdText(text));
      if (stories.length > 0) {
        tabs = tabsFromProjectView(
          {
            companyUid,
            projectId: matched,
            name: opts.row.title || matched,
            stories,
            repos: [],
          },
          members,
          opts.companyLabel,
          liveInputsForCompanyProject(companyUid, matched),
        );
        resolvedId = matched;
      }
    }
  }

  if (!tabs) return null;
  if (tabs.files.length > 0 || !opts.listVaultPrefix) return tabs;
  let listed: unknown = null;
  try {
    listed = await opts.listVaultPrefix(companyUid, `projects/${resolvedId}/`);
  } catch {
    listed = null;
  }
  return {
    ...tabs,
    files: filesFromVaultList(listed, companyUid),
  };
}
