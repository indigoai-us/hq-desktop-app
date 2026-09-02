/**
 * Per-conversation composer drafts (Slack pattern).
 *
 * The shell remounts `ChannelConversation` on every conversation switch, so
 * the composer's text would otherwise be lost. Drafts live in ONE tenant-scoped
 * JSON blob keyed by sidebar row id (`ch:<id>` / `dm:<uid>`), survive restart,
 * and are pruned oldest-first past a cap. Pure storage helpers plus a window
 * event so the rail can show a "Draft" marker without a store dependency.
 */

export const COMPOSER_DRAFTS_STORAGE_KEY = "composer-drafts";
export const COMPOSER_DRAFT_CHANGED_EVENT = "hq:composer-draft-changed";
/** Most drafts kept at once; the oldest by `updatedAt` are pruned first. */
export const MAX_COMPOSER_DRAFTS = 200;
/** Longest single draft persisted (chars); longer text is truncated. */
export const MAX_COMPOSER_DRAFT_CHARS = 20_000;

export interface ComposerDraftEntry {
  text: string;
  updatedAt: number;
}

export type ComposerDraftMap = Record<string, ComposerDraftEntry>;

export interface ComposerDraftChangedDetail {
  rowId: string;
  hasDraft: boolean;
}

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function readMap(storage: DraftStorage | null | undefined): ComposerDraftMap {
  if (!storage) return {};
  try {
    const raw = storage.getItem(COMPOSER_DRAFTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: ComposerDraftMap = {};
    for (const [rowId, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<ComposerDraftEntry>;
      if (typeof entry.text !== "string" || entry.text.trim() === "") continue;
      out[rowId] = {
        text: entry.text,
        updatedAt:
          typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
            ? entry.updatedAt
            : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(
  storage: DraftStorage | null | undefined,
  map: ComposerDraftMap,
): void {
  if (!storage) return;
  try {
    if (Object.keys(map).length === 0) {
      storage.removeItem(COMPOSER_DRAFTS_STORAGE_KEY);
    } else {
      storage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, JSON.stringify(map));
    }
  } catch {
    // Quota / private mode — best-effort.
  }
}

function emitChanged(rowId: string, hasDraft: boolean): void {
  if (typeof window === "undefined" || typeof CustomEvent === "undefined") {
    return;
  }
  try {
    window.dispatchEvent(
      new CustomEvent<ComposerDraftChangedDetail>(
        COMPOSER_DRAFT_CHANGED_EVENT,
        { detail: { rowId, hasDraft } },
      ),
    );
  } catch {
    // Listener failures never break the composer.
  }
}

/** Drop the oldest entries until the map fits the cap. Mutates `map`. */
function prune(map: ComposerDraftMap, max = MAX_COMPOSER_DRAFTS): void {
  const ids = Object.keys(map);
  if (ids.length <= max) return;
  ids
    .sort((a, b) => map[a].updatedAt - map[b].updatedAt)
    .slice(0, ids.length - max)
    .forEach((id) => {
      delete map[id];
    });
}

/** Stored draft text for a row, or `""` when there is none. */
export function loadDraft(
  storage: DraftStorage | null | undefined,
  rowId: string,
): string {
  if (!rowId) return "";
  return readMap(storage)[rowId]?.text ?? "";
}

/**
 * Persist a draft. Empty / whitespace-only text REMOVES the entry (same as
 * `clearDraft`). Emits `hq:composer-draft-changed`.
 */
export function saveDraft(
  storage: DraftStorage | null | undefined,
  rowId: string,
  text: string,
  now: number = Date.now(),
): void {
  if (!rowId) return;
  if (text.trim() === "") {
    clearDraft(storage, rowId);
    return;
  }
  const map = readMap(storage);
  map[rowId] = {
    text: text.length > MAX_COMPOSER_DRAFT_CHARS
      ? text.slice(0, MAX_COMPOSER_DRAFT_CHARS)
      : text,
    updatedAt: now,
  };
  prune(map);
  writeMap(storage, map);
  emitChanged(rowId, true);
}

/** Remove a row's draft (no-op when absent). Emits the change event. */
export function clearDraft(
  storage: DraftStorage | null | undefined,
  rowId: string,
): void {
  if (!rowId) return;
  const map = readMap(storage);
  if (rowId in map) {
    delete map[rowId];
    writeMap(storage, map);
  }
  emitChanged(rowId, false);
}

/** Row ids that currently have a non-empty draft (for rail markers). */
export function listDraftRowIds(
  storage: DraftStorage | null | undefined,
): string[] {
  return Object.keys(readMap(storage));
}
