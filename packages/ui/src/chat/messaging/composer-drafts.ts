/**
 * Per-conversation composer drafts (Slack pattern).
 *
 * The shell remounts `ChannelConversation` on every conversation switch, so
 * the composer's text would otherwise be lost. Drafts live in ONE tenant-scoped
 * JSON blob keyed by sidebar row id (`ch:<id>` / `dm:<uid>`), survive restart,
 * and are pruned oldest-first past the entry / size caps. Pure storage helpers
 * plus a window event so the rail can show a "Draft" marker without a store
 * dependency.
 *
 * Durability contract:
 * - `saveDraft` / `clearDraft` return `true` only when storage really holds
 *   the new state. Callers must not treat a `false` as persisted.
 * - A blob that fails to parse is never silently overwritten: the raw text is
 *   copied to `COMPOSER_DRAFTS_CORRUPT_STORAGE_KEY` (once — an existing backup
 *   is kept) before a fresh map replaces it, so other rows' drafts remain
 *   recoverable by hand.
 */

export const COMPOSER_DRAFTS_STORAGE_KEY = "composer-drafts";
/** Where an unparseable `composer-drafts` blob is parked before reset. */
export const COMPOSER_DRAFTS_CORRUPT_STORAGE_KEY = "composer-drafts.corrupt";
export const COMPOSER_DRAFT_CHANGED_EVENT = "hq:composer-draft-changed";
/** Most drafts kept at once; the oldest by `updatedAt` are pruned first. */
export const MAX_COMPOSER_DRAFTS = 200;
/** Longest single draft persisted (chars); longer text is truncated. */
export const MAX_COMPOSER_DRAFT_CHARS = 20_000;
/**
 * Largest serialized blob (UTF-8 bytes). Past this the oldest drafts are
 * dropped until it fits; the newest entry is always kept.
 */
export const MAX_COMPOSER_DRAFTS_BYTES = 512 * 1024;

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

interface ReadResult {
  map: ComposerDraftMap;
  /** Raw blob text when it could not be parsed into an object; else null. */
  corruptRaw: string | null;
}

function readState(storage: DraftStorage | null | undefined): ReadResult {
  if (!storage) return { map: {}, corruptRaw: null };
  let raw: string | null = null;
  try {
    raw = storage.getItem(COMPOSER_DRAFTS_STORAGE_KEY);
  } catch {
    return { map: {}, corruptRaw: null };
  }
  if (!raw) return { map: {}, corruptRaw: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { map: {}, corruptRaw: raw };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { map: {}, corruptRaw: raw };
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
  return { map: out, corruptRaw: null };
}

function readMap(storage: DraftStorage | null | undefined): ComposerDraftMap {
  return readState(storage).map;
}

/**
 * Park an unparseable blob under the sibling key so a reset does not destroy
 * it. Keeps an existing backup (first corruption wins). Returns `false` when
 * the backup could not be written — callers must then refuse to overwrite.
 */
function preserveCorrupt(storage: DraftStorage, raw: string): boolean {
  try {
    if (storage.getItem(COMPOSER_DRAFTS_CORRUPT_STORAGE_KEY) == null) {
      storage.setItem(COMPOSER_DRAFTS_CORRUPT_STORAGE_KEY, raw);
    }
    return true;
  } catch {
    return false;
  }
}

/** Write (or remove, when empty) the blob. `true` only when storage took it. */
function writeMap(
  storage: DraftStorage | null | undefined,
  map: ComposerDraftMap,
): boolean {
  if (!storage) return false;
  try {
    if (Object.keys(map).length === 0) {
      storage.removeItem(COMPOSER_DRAFTS_STORAGE_KEY);
    } else {
      storage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, JSON.stringify(map));
    }
    return true;
  } catch {
    // Quota / private mode — report so the caller can retry later.
    return false;
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

function serializedBytes(map: ComposerDraftMap): number {
  const json = JSON.stringify(map);
  return typeof TextEncoder !== "undefined"
    ? new TextEncoder().encode(json).length
    : json.length;
}

/**
 * Drop the oldest entries (by `updatedAt`) until the map fits both the entry
 * cap and the serialized-size cap. The newest entry always survives. Mutates
 * `map`.
 */
function prune(
  map: ComposerDraftMap,
  max = MAX_COMPOSER_DRAFTS,
  maxBytes = MAX_COMPOSER_DRAFTS_BYTES,
): void {
  const oldestFirst = Object.keys(map).sort(
    (a, b) => map[a].updatedAt - map[b].updatedAt,
  );
  let dropUntil = Math.max(0, oldestFirst.length - max);
  for (let i = 0; i < dropUntil; i += 1) delete map[oldestFirst[i]];
  while (oldestFirst.length - dropUntil > 1 && serializedBytes(map) > maxBytes) {
    delete map[oldestFirst[dropUntil]];
    dropUntil += 1;
  }
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
 * `clearDraft`). Emits `hq:composer-draft-changed` on success. Returns `false`
 * when storage rejected the write (quota, private mode, unrecoverable corrupt
 * blob) — the caller should keep its pending state and retry later.
 */
export function saveDraft(
  storage: DraftStorage | null | undefined,
  rowId: string,
  text: string,
  now: number = Date.now(),
): boolean {
  if (!rowId) return false;
  if (text.trim() === "") {
    return clearDraft(storage, rowId);
  }
  if (!storage) return false;
  const { map, corruptRaw } = readState(storage);
  if (corruptRaw != null && !preserveCorrupt(storage, corruptRaw)) {
    return false;
  }
  map[rowId] = {
    text: text.length > MAX_COMPOSER_DRAFT_CHARS
      ? text.slice(0, MAX_COMPOSER_DRAFT_CHARS)
      : text,
    updatedAt: now,
  };
  prune(map);
  if (!writeMap(storage, map)) return false;
  emitChanged(rowId, true);
  return true;
}

/**
 * Remove a row's draft (no-op when absent). Emits the change event and returns
 * `true` once storage no longer holds the row; `false` if the removal failed.
 */
export function clearDraft(
  storage: DraftStorage | null | undefined,
  rowId: string,
): boolean {
  if (!rowId) return false;
  const map = readMap(storage);
  if (rowId in map && !writeMap(storage, (delete map[rowId], map))) {
    return false;
  }
  emitChanged(rowId, false);
  return true;
}

/** Row ids that currently have a non-empty draft (for rail markers). */
export function listDraftRowIds(
  storage: DraftStorage | null | undefined,
): string[] {
  return Object.keys(readMap(storage));
}
