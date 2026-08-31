/**
 * Fixture-driven render models for the channel Board + Files tabs.
 *
 * Ported from the hq-sync desktop `BoardTab` / `ChannelFilesTab` shapes, but
 * reduced to exactly what the MARKUP renders — no Tauri invoke, no board/files
 * polling data models. The shell injects these synchronously from authored
 * fixtures or a live work-mesh overlay. Board stages are To do / Doing /
 * Waiting / Done. See DesktopApp.svelte `boardByRow` / `filesByRow`.
 */

/** Official Board stages — one column each, even when empty. */
export const BOARD_STAGE_ORDER = [
  "queued",
  "in_progress",
  "review",
  "done",
] as const;

export type BoardStageId = (typeof BOARD_STAGE_ORDER)[number];

export const BOARD_STAGE_TITLES: Record<BoardStageId, string> = {
  queued: "To do",
  in_progress: "Doing",
  review: "Waiting",
  done: "Done",
};

/** Default visible columns: Waiting is opt-in. */
export const DEFAULT_VISIBLE_BOARD_STAGES: readonly BoardStageId[] = [
  "queued",
  "in_progress",
  "done",
];

export function isBoardStageId(id: string): id is BoardStageId {
  return (BOARD_STAGE_ORDER as readonly string[]).includes(id);
}

/** Fold injected columns onto the four stages, keeping empty ones. */
export function resolveBoardColumns(
  columns: BoardColumnModel[],
  visibleIds: readonly BoardStageId[],
): BoardColumnModel[] {
  const byId = new Map(columns.map((column) => [column.id, column]));
  return visibleIds.filter(isBoardStageId).map((id) => ({
    id,
    title: byId.get(id)?.title ?? BOARD_STAGE_TITLES[id],
    cards: byId.get(id)?.cards ?? [],
  }));
}

export function toggleBoardStage(
  current: readonly BoardStageId[],
  id: BoardStageId,
): BoardStageId[] {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return BOARD_STAGE_ORDER.filter((stage) => next.has(stage));
}

/** One board column (To do / Doing / Waiting / Done) with its task cards. */
export interface BoardColumnModel {
  id: string;
  title: string;
  cards: BoardCardModel[];
}

/** A task card on the board. `statusLine` drives the ok/warn colour. */
export interface BoardCardModel {
  storyId: string;
  label: string;
  statusLine: string;
}

/** Task side-panel detail, keyed by task id. */
export interface BoardStoryPanelModel {
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

/** Whole-tab board fixture: columns + a lookup of task-panel details. */
export interface BoardTabData {
  columns: BoardColumnModel[];
  stories: Record<string, BoardStoryPanelModel>;
}

export type ChannelFileIconKind =
  "image" | "pdf" | "markdown" | "text" | "file";

/** One row in the channel Files tab. */
export interface ChannelFileItemModel {
  key: string;
  vaultPath: string;
  /**
   * Optional HQ-relative local mirror path. It is never an absolute path and
   * native commands re-authorize it before acting on it.
   */
  localPath?: string;
  companyUid?: string;
  name: string;
  /** Uploader · date caption, e.g. "ADA · AUG 10". */
  caption: string;
  iconKind: ChannelFileIconKind;
  accessDenied?: boolean;
  /** Authored preview body (text/markdown) — no host fetch. */
  previewText?: string;
}

/** A bounded, passive preview resolved by the host-owned file seam. */
export type ChannelFilePreview =
  | { kind: "text"; text: string }
  | { kind: "image"; url: string }
  | { kind: "pdf"; url: string }
  | {
      kind: "unavailable";
      state:
        | "missing"
        | "denied"
        | "offline"
        | "too-large"
        | "binary"
        | "unsupported";
      message: string;
    };
