/**
 * Channel chat-tab message models (US-004 / US-015).
 *
 * Parses the optional hq-pro wire fields on channel message rows:
 * - `systemEvent` — versioned envelope; unknown type / wrong v → null (render nothing)
 * - `attachment`  — file card model; missing sizeBytes/kind are fine
 *
 * Pure + absent-safe. Components consume the render models; raw payloads never
 * throw. Unknown keys on known envelopes are ignored (additive-safe).
 */

/** Known system-event types from the v1 envelope. */
export type KnownSystemEventType =
  | "run_started"
  | "run_progress"
  | "run_complete"
  | "pr_opened"
  | "deploy"
  | "file_added"
  | "work_session"
  | "work_session_blocked"
  | "work_session_task_status"
  | "work_session_finished"
  | "member_added";

const KNOWN_TYPES = new Set<string>([
  "run_started",
  "run_progress",
  "run_complete",
  "pr_opened",
  "deploy",
  "file_added",
  "work_session",
  "work_session_blocked",
  "work_session_task_status",
  "work_session_finished",
  "member_added",
]);

/** Wire shape for a channel file attachment (camelCase). */
export interface MessageAttachmentWire {
  id?: string | null;
  vaultPath: string;
  companyUid?: string | null;
  name: string;
  contentType?: string | null;
  sizeBytes?: number | null;
  kind?: string | null;
  previewUrl?: string | null;
}

/** Render model for a file attachment card or image thumb. */
export interface FileAttachmentModel {
  id: string;
  vaultPath: string;
  companyUid: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  /** Formatted size caption, or null when sizeBytes is missing. */
  sizeLabel: string | null;
  kind: "image" | "file";
  /** Caption line: "FILES · 12 KB" or just "FILES". */
  caption: string;
  previewUrl: string | null;
}

/** Line types — everything except run_complete cards and work_session cards. */
export type SystemEventLineType = Exclude<
  KnownSystemEventType,
  "run_complete" | "work_session"
>;

/** Muted one-line system event (everything except run_complete / work_session). */
export interface SystemEventLineModel {
  kind: "line";
  type: SystemEventLineType;
  title: string;
  summary: string | null;
}

/** Run-complete card with optional preview/diff actions. */
export interface RunCompleteCardModel {
  kind: "run_complete";
  title: string;
  summary: string | null;
  previewUrl: string | null;
  diffUrl: string | null;
}

/**
 * Coalesced work_session card (US-006 / US-015). Additive envelope fields are
 * optional so older payloads still parse; unknown keys are ignored.
 */
export interface WorkSessionCardModel {
  kind: "work_session_card";
  type: "work_session";
  title: string;
  summary: string | null;
  actorUid: string | null;
  actorType: "human" | "agent";
  harness: string | null;
  taskId: string | null;
  turnCount: number | null;
  lastTurnAt: string | null;
  status: string | null;
  /** Display name when the envelope carried one; otherwise null (resolve via roster). */
  principalDisplay: string | null;
  note: string | null;
}

export type SystemEventModel =
  | SystemEventLineModel
  | RunCompleteCardModel
  | WorkSessionCardModel;

const DEFAULT_TITLES: Record<SystemEventLineType | "work_session", string> = {
  run_started: "Run started",
  run_progress: "Run progress",
  pr_opened: "PR opened",
  deploy: "Deployed",
  file_added: "File added",
  work_session: "Work session",
  work_session_blocked: "Blocked",
  work_session_task_status: "Task moved",
  work_session_finished: "Finished",
  member_added: "Added to the channel",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asOptionalInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
  }
  return null;
}

function normalizeActorType(value: unknown): "human" | "agent" {
  const raw = asOptionalString(value)?.toLowerCase();
  return raw === "agent" ? "agent" : "human";
}

function parsePrincipal(raw: unknown): {
  uid: string | null;
  kind: "human" | "agent";
  display: string | null;
} | null {
  if (!isRecord(raw)) {
    const asName = asOptionalString(raw);
    return asName
      ? { uid: null, kind: "human", display: asName }
      : null;
  }
  const uid = asOptionalString(raw.uid);
  const kind = normalizeActorType(raw.kind ?? raw.actorType);
  const display =
    asOptionalString(raw.displayName) ?? asOptionalString(raw.name);
  return { uid, kind, display };
}

const IMAGE_NAME_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
  "bmp",
  "heic",
]);

/** Infer an image when the API omits kind/contentType (desktop catch-up). */
export function isImageFileName(name: string): boolean {
  const base = name.trim().split(/[?#]/)[0] ?? "";
  const ext = base.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_NAME_EXT.has(ext) && ext !== base.toLowerCase();
}

/**
 * Format a byte count for the file-card caption. Returns null when size is
 * missing/invalid so the caption can fall back to plain "FILES".
 */
export function formatAttachmentSize(
  sizeBytes: number | null | undefined,
): string | null {
  if (sizeBytes == null || !Number.isFinite(sizeBytes) || sizeBytes < 0)
    return null;
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
  const vaultPath = asOptionalString(raw.vaultPath) ?? "";
  const name =
    asOptionalString(raw.name) ??
    (vaultPath ? (vaultPath.split("/").pop() ?? vaultPath) : "");
  if (!name && !vaultPath) return null;

  const sizeRaw = raw.sizeBytes;
  const sizeBytes =
    typeof sizeRaw === "number"
      ? sizeRaw
      : typeof sizeRaw === "string" &&
          sizeRaw.trim() !== "" &&
          Number.isFinite(Number(sizeRaw))
        ? Number(sizeRaw)
        : null;
  const sizeLabel = formatAttachmentSize(sizeBytes);
  const contentType = asOptionalString(raw.contentType) ?? "";
  const kindRaw = asOptionalString(raw.kind);
  const kind: "image" | "file" =
    kindRaw === "image" ||
    contentType.startsWith("image/") ||
    isImageFileName(name || vaultPath)
      ? "image"
      : "file";
  const caption = sizeLabel ? `FILES · ${sizeLabel}` : "FILES";
  const id =
    asOptionalString(raw.id) ??
    (vaultPath ? (vaultPath.split("/").pop() ?? vaultPath) : name || "file");

  return {
    id,
    vaultPath,
    companyUid: asOptionalString(raw.companyUid) ?? "",
    name: name || vaultPath,
    contentType,
    sizeBytes: sizeBytes ?? 0,
    sizeLabel,
    kind,
    caption,
    previewUrl: asOptionalString(raw.previewUrl),
  };
}

/** Parse `attachments[]`, falling back to a legacy singular `attachment`. */
export function parseMessageAttachments(raw: {
  attachments?: unknown;
  attachment?: unknown;
}): FileAttachmentModel[] {
  const list = Array.isArray(raw.attachments)
    ? raw.attachments
    : raw.attachments != null
      ? [raw.attachments]
      : [];
  const fromList = list
    .map((entry) => parseAttachment(entry))
    .filter((entry): entry is FileAttachmentModel => entry != null);
  if (fromList.length > 0) return fromList;
  const one = parseAttachment(raw.attachment);
  return one ? [one] : [];
}

function discreteLineTitle(
  type: "work_session_blocked" | "work_session_task_status" | "work_session_finished",
  raw: Record<string, unknown>,
  title: string | null,
  note: string | null,
  summary: string | null,
): string {
  const body = asOptionalString(raw.body);
  const preferred = title ?? note ?? summary ?? body;
  if (preferred) return preferred;
  return DEFAULT_TITLES[type];
}

/**
 * Parse a systemEvent envelope into a render model.
 *
 * Absent-safe rules:
 * - null/undefined/non-object → null
 * - `v` present and not 1 → null (unknown version)
 * - unknown `type` → null
 * - work_session → card (additive fields optional; unknown keys ignored)
 * - discrete work_session_* → line (title prefers note/summary/body)
 * - known non-run_complete types → line model (title falls back to a default)
 * - run_complete → card; missing previewUrl/diffUrl leave those buttons hidden
 */
export function parseSystemEvent(raw: unknown): SystemEventModel | null {
  if (raw == null) return null;
  if (!isRecord(raw)) return null;

  // Version gate: absent v is treated as v1 (tolerant); present non-1 is unknown.
  if ("v" in raw && raw.v !== 1 && raw.v !== "1") return null;

  const type = asOptionalString(raw.type);
  if (!type || !KNOWN_TYPES.has(type)) return null;

  const title = asOptionalString(raw.title);
  const summary = asOptionalString(raw.summary);
  const note = asOptionalString(raw.note);
  const status = asOptionalString(raw.status);

  if (type === "run_complete") {
    return {
      kind: "run_complete",
      title: title ?? "Run complete",
      summary,
      previewUrl: asOptionalString(raw.previewUrl),
      diffUrl: asOptionalString(raw.diffUrl),
    };
  }

  if (type === "work_session") {
    const principal = parsePrincipal(raw.principal);
    const actorUid =
      asOptionalString(raw.actorUid) ?? principal?.uid ?? null;
    const actorType = normalizeActorType(
      raw.actorType ?? principal?.kind ?? (actorUid?.startsWith("agt_") ? "agent" : "human"),
    );
    const cardTitle =
      note ??
      title ??
      (status ? `Work session · ${status}` : null) ??
      DEFAULT_TITLES.work_session;
    return {
      kind: "work_session_card",
      type: "work_session",
      title: cardTitle,
      summary: summary ?? status,
      actorUid,
      actorType,
      harness: asOptionalString(raw.harness),
      taskId: asOptionalString(raw.taskId),
      turnCount: asOptionalInt(raw.turnCount),
      lastTurnAt: asOptionalString(raw.lastTurnAt),
      status,
      principalDisplay:
        asOptionalString(raw.displayName) ?? principal?.display ?? null,
      note,
    };
  }

  if (
    type === "work_session_blocked" ||
    type === "work_session_task_status" ||
    type === "work_session_finished"
  ) {
    return {
      kind: "line",
      type,
      title: discreteLineTitle(type, raw, title, note, summary),
      summary: null,
    };
  }

  const lineType = type as SystemEventLineType;
  return {
    kind: "line",
    type: lineType,
    title: title ?? DEFAULT_TITLES[lineType],
    summary,
  };
}

/** Render model for a timeline row — envelope first, then member_added posts. */
export function systemModelForMessage(message: {
  body?: string | null;
  messageKind?: string | null;
  systemEvent?: unknown;
  fromDisplayName?: string | null;
}): SystemEventModel | null {
  const fromEnvelope = parseSystemEvent(message.systemEvent ?? null);
  if (fromEnvelope) return fromEnvelope;
  const kind = message.messageKind?.trim().toLowerCase();
  if (kind !== "member_added") return null;
  const title =
    message.body?.trim() ||
    `${message.fromDisplayName?.trim() || "Someone"} added someone to the channel.`;
  return {
    kind: "line",
    type: "member_added",
    title,
    summary: null,
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
  if (kind !== "system") return false;
  return parseSystemEvent(message.systemEvent) == null;
}
