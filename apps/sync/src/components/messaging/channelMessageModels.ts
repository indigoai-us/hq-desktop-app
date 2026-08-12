/**
 * Channel chat-tab message models (US-004).
 *
 * Parses the optional hq-pro wire fields on channel message rows:
 * - `systemEvent` — versioned envelope; unknown type / wrong v → null (render nothing)
 * - `attachment`  — file card model; missing sizeBytes/kind are fine
 *
 * Pure + absent-safe. Components consume the render models; raw payloads never
 * throw.
 */

/** Known system-event types from the v1 envelope. */
export type KnownSystemEventType =
  | 'run_started'
  | 'run_progress'
  | 'run_complete'
  | 'pr_opened'
  | 'deploy'
  | 'file_added';

const KNOWN_TYPES = new Set<string>([
  'run_started',
  'run_progress',
  'run_complete',
  'pr_opened',
  'deploy',
  'file_added',
]);

/** Wire shape for a channel file attachment (camelCase). */
export interface MessageAttachmentWire {
  vaultPath: string;
  name: string;
  sizeBytes?: number | null;
  kind?: string | null;
}

/** Render model for a file attachment card. */
export interface FileAttachmentModel {
  vaultPath: string;
  name: string;
  /** Formatted size caption, or null when sizeBytes is missing. */
  sizeLabel: string | null;
  kind: string | null;
  /** Caption line: "FILES · 12 KB" or just "FILES". */
  caption: string;
}

/** Muted one-line system event (everything except run_complete). */
export interface SystemEventLineModel {
  kind: 'line';
  type: Exclude<KnownSystemEventType, 'run_complete'>;
  title: string;
  summary: string | null;
}

/** Run-complete card with optional preview/diff actions. */
export interface RunCompleteCardModel {
  kind: 'run_complete';
  title: string;
  summary: string | null;
  previewUrl: string | null;
  diffUrl: string | null;
}

export type SystemEventModel = SystemEventLineModel | RunCompleteCardModel;

const DEFAULT_TITLES: Record<Exclude<KnownSystemEventType, 'run_complete'>, string> = {
  run_started: 'Run started',
  run_progress: 'Run progress',
  pr_opened: 'PR opened',
  deploy: 'Deployed',
  file_added: 'File added',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Format a byte count for the file-card caption. Returns null when size is
 * missing/invalid so the caption can fall back to plain "FILES".
 */
export function formatAttachmentSize(sizeBytes: number | null | undefined): string | null {
  if (sizeBytes == null || !Number.isFinite(sizeBytes) || sizeBytes < 0) return null;
  if (sizeBytes < 1024) return `${Math.round(sizeBytes)} B`;
  const kb = sizeBytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

/**
 * Parse a wire attachment into a file-card model. Missing sizeBytes/kind are
 * fine. Returns null only when the payload is unusable (no name and no path).
 */
export function parseAttachment(raw: unknown): FileAttachmentModel | null {
  if (!isRecord(raw)) return null;
  const vaultPath = asOptionalString(raw.vaultPath) ?? '';
  const name = asOptionalString(raw.name) ?? (vaultPath ? vaultPath.split('/').pop() ?? vaultPath : '');
  if (!name && !vaultPath) return null;

  const sizeRaw = raw.sizeBytes;
  const sizeBytes =
    typeof sizeRaw === 'number'
      ? sizeRaw
      : typeof sizeRaw === 'string' && sizeRaw.trim() !== '' && Number.isFinite(Number(sizeRaw))
        ? Number(sizeRaw)
        : null;
  const sizeLabel = formatAttachmentSize(sizeBytes);
  const kind = asOptionalString(raw.kind);
  const caption = sizeLabel ? `FILES · ${sizeLabel}` : 'FILES';

  return {
    vaultPath,
    name: name || vaultPath,
    sizeLabel,
    kind,
    caption,
  };
}

/**
 * Parse a systemEvent envelope into a render model.
 *
 * Absent-safe rules:
 * - null/undefined/non-object → null
 * - `v` present and not 1 → null (unknown version)
 * - unknown `type` → null
 * - known non-run_complete types → line model (title falls back to a default)
 * - run_complete → card; missing previewUrl/diffUrl leave those buttons hidden
 */
export function parseSystemEvent(raw: unknown): SystemEventModel | null {
  if (raw == null) return null;
  if (!isRecord(raw)) return null;

  // Version gate: absent v is treated as v1 (tolerant); present non-1 is unknown.
  if ('v' in raw && raw.v !== 1 && raw.v !== '1') return null;

  const type = asOptionalString(raw.type);
  if (!type || !KNOWN_TYPES.has(type)) return null;

  const title = asOptionalString(raw.title);
  const summary = asOptionalString(raw.summary);

  if (type === 'run_complete') {
    return {
      kind: 'run_complete',
      title: title ?? 'Run complete',
      summary,
      previewUrl: asOptionalString(raw.previewUrl),
      diffUrl: asOptionalString(raw.diffUrl),
    };
  }

  const lineType = type as Exclude<KnownSystemEventType, 'run_complete'>;
  return {
    kind: 'line',
    type: lineType,
    title: title ?? DEFAULT_TITLES[lineType],
    summary,
  };
}

/**
 * Whether a channel message row should be suppressed entirely.
 * System-kind messages with an unparseable/unknown systemEvent render nothing.
 */
export function shouldHideSystemMessage(message: {
  messageKind?: string | null;
  systemEvent?: unknown;
}): boolean {
  const kind = message.messageKind?.trim().toLowerCase();
  if (kind !== 'system') return false;
  return parseSystemEvent(message.systemEvent) == null;
}
