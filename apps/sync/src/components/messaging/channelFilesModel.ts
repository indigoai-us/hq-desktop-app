/**
 * Channel Files tab model (US-008).
 *
 * Parses `fetch_channel_files` wire rows into a flat list view-model and
 * classifies list/preview failures for absent-safe UI:
 *   - missing endpoint (404 / not found / route) → 'unsupported' → empty state
 *   - ACL / membership / scope denial → 'denied' → clean denied copy
 *   - everything else → 'generic'
 *
 * Attachments are references only; content is loaded by FilePreviewPane via
 * the existing authorized file commands.
 */

import { filePreviewKind, type FilePreviewKind } from '../../desktop-alt/lib/file-preview-kind';

/** Wire attachment on a channel-files list row. */
export interface ChannelFileAttachmentWire {
  vaultPath?: unknown;
  name?: unknown;
  sizeBytes?: unknown;
  kind?: unknown;
}

/** Wire row from GET /v1/notify/channels/{id}/files. */
export interface ChannelFileWire {
  eventId?: unknown;
  messageEventId?: unknown;
  attachment?: unknown;
  fromUid?: unknown;
  fromDisplayName?: unknown;
  createdAt?: unknown;
}

/** Wire envelope. */
export interface ChannelFilesResponseWire {
  files?: unknown;
  nextCursor?: unknown;
}

/** List-row icon classification (reuses FilePreviewPane kinds). */
export type ChannelFileIconKind = FilePreviewKind | 'file';

/** View-model for one files-tab row. */
export interface ChannelFileItem {
  /** Stable list key — eventId when present, else vaultPath. */
  key: string;
  vaultPath: string;
  name: string;
  sizeBytes: number | null;
  kind: string | null;
  /** Display name of the uploader (humans + agents). */
  uploaderLabel: string;
  /** True when fromUid matches the agent identity convention. */
  isAgent: boolean;
  createdAt: string;
  /** Short date label for the right-aligned caption. */
  dateLabel: string;
  /** Upper-cased "UPLOADER · DATE" caption for the list row. */
  caption: string;
  /** Icon kind derived from vaultPath / name via file-preview-kind. */
  iconKind: ChannelFileIconKind;
}

export type AccessErrorKind = 'unsupported' | 'denied' | 'generic';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Detect fleet/agent uploaders the same way messaging does elsewhere:
 * `agt_`, `agent_`, and `agent:` person-uid prefixes.
 */
export function isAgentUploader(fromUid: string | null | undefined): boolean {
  const u = (fromUid ?? '').trim().toLowerCase();
  return u.startsWith('agt_') || u.startsWith('agent_') || u.startsWith('agent:');
}

/** Normalize a vault path for deep-link matching (trim, collapse slashes). */
export function normalizeVaultPath(path: string | null | undefined): string {
  return (path ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '');
}

/**
 * Short date for the files list caption. Falls back to empty when unparseable
 * so the caption can omit the date segment.
 */
export function formatFileDateLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      .toUpperCase();
  } catch {
    return '';
  }
}

/**
 * Upper-cased "UPLOADER · DATE" caption pieces. When date is missing, returns
 * just the uploader (still upper-cased).
 */
export function formatUploaderCaption(
  uploaderLabel: string,
  dateLabel: string,
): string {
  const who = (uploaderLabel || 'Unknown').trim().toUpperCase() || 'UNKNOWN';
  const when = (dateLabel || '').trim().toUpperCase();
  return when ? `${who} · ${when}` : who;
}

/** Map a path/name to the list icon kind (reuses file-preview-kind). */
export function classifyFileIcon(
  vaultPath: string,
  name?: string | null,
): ChannelFileIconKind {
  const path = vaultPath || name || '';
  if (!path) return 'file';
  const kind = filePreviewKind(path);
  return kind === 'unknown' ? 'file' : kind;
}

/**
 * Parse one wire file row into a view model. Malformed rows (no usable name
 * and no path) return null and are dropped by the list parser.
 */
export function mapChannelFileRow(raw: unknown): ChannelFileItem | null {
  if (!isRecord(raw)) return null;

  const eventId = asOptionalString(raw.eventId) ?? '';
  const attachmentRaw = raw.attachment;
  if (!isRecord(attachmentRaw)) return null;

  const vaultPath = asOptionalString(attachmentRaw.vaultPath) ?? '';
  const name =
    asOptionalString(attachmentRaw.name) ??
    (vaultPath ? vaultPath.split('/').pop() ?? vaultPath : '');
  if (!name && !vaultPath) return null;

  const fromUid = asOptionalString(raw.fromUid) ?? '';
  const uploaderLabel =
    asOptionalString(raw.fromDisplayName) ??
    (fromUid ? fromUid.replace(/^(agt_|agent_|agent:)/i, '') : null) ??
    'Unknown';
  const createdAt = asOptionalString(raw.createdAt) ?? '';
  const dateLabel = formatFileDateLabel(createdAt);
  const sizeBytes = asOptionalNumber(attachmentRaw.sizeBytes);
  const kind = asOptionalString(attachmentRaw.kind);
  const resolvedName = name || vaultPath;
  const resolvedPath = vaultPath || resolvedName;

  return {
    key: eventId || resolvedPath,
    vaultPath: resolvedPath,
    name: resolvedName,
    sizeBytes,
    kind,
    uploaderLabel,
    isAgent: isAgentUploader(fromUid),
    createdAt,
    dateLabel,
    caption: formatUploaderCaption(uploaderLabel, dateLabel),
    iconKind: classifyFileIcon(resolvedPath, resolvedName),
  };
}

/**
 * Defensively parse a fetch_channel_files response. null/undefined/missing
 * files → []. Malformed rows are dropped. nextCursor is optional.
 */
export function parseChannelFilesResponse(raw: unknown): {
  files: ChannelFileItem[];
  nextCursor: string | null;
} {
  if (raw == null) return { files: [], nextCursor: null };
  if (!isRecord(raw)) return { files: [], nextCursor: null };

  const list = Array.isArray(raw.files) ? raw.files : [];
  const files: ChannelFileItem[] = [];
  for (const row of list) {
    const item = mapChannelFileRow(row);
    if (item) files.push(item);
  }
  return {
    files,
    nextCursor: asOptionalString(raw.nextCursor),
  };
}

/**
 * Find the list index of a deep-linked vaultPath. Returns -1 when the file is
 * absent (no selection, no crash).
 */
export function findFileIndexByVaultPath(
  files: readonly ChannelFileItem[],
  vaultPath: string | null | undefined,
): number {
  const target = normalizeVaultPath(vaultPath);
  if (!target) return -1;
  return files.findIndex((f) => normalizeVaultPath(f.vaultPath) === target);
}

function errorText(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message ?? String(err);
  if (isRecord(err) && typeof err.message === 'string') return err.message;
  return String(err);
}

/**
 * Classify a list/preview failure for the Files tab shell.
 *
 * - 404 / not found / route / no such endpoint → 'unsupported' (empty state)
 * - 403 / forbidden / denied / membership / scope / not authorized → 'denied'
 * - else → 'generic'
 *
 * Tone for denied copy follows meetings-model 403 phrasing ("You don't have…").
 */
export function classifyAccessError(err: unknown): AccessErrorKind {
  const raw = errorText(err);
  if (!raw) return 'generic';
  const lower = raw.toLowerCase();

  // Endpoint missing on older servers — treat as empty, never crash.
  if (
    /\b404\b/.test(raw) ||
    lower.includes('not found') ||
    lower.includes('no such') ||
    lower.includes('unknown route') ||
    lower.includes('route not') ||
    lower.includes('cannot post') ||
    lower.includes('cannot get') ||
    (lower.includes('route') && lower.includes('error'))
  ) {
    return 'unsupported';
  }

  if (
    /\b403\b/.test(raw) ||
    lower.includes('forbidden') ||
    lower.includes('denied') ||
    lower.includes('not authorized') ||
    lower.includes('unauthorized') ||
    lower.includes('membership') ||
    lower.includes('not a member') ||
    lower.includes('scope')
  ) {
    return 'denied';
  }

  return 'generic';
}

/** Preview-path classifier — same rules as list, exported for the tab shell. */
export function classifyPreviewError(err: unknown): AccessErrorKind {
  return classifyAccessError(err);
}

/** User-facing denied copy (no raw error text). */
export const CHANNEL_FILES_DENIED_MESSAGE = "You don't have access to this file.";

/** Empty-state copy when the list is empty or the endpoint is unsupported. */
export const CHANNEL_FILES_EMPTY_MESSAGE = 'No files yet';
