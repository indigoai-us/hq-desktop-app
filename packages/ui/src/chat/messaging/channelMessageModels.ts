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
  | "run_started"
  | "run_progress"
  | "run_complete"
  | "pr_opened"
  | "deploy"
  | "file_added"
  | "work_session"
  | "member_added"
  | "lifecycle_card";

const KNOWN_TYPES = new Set<string>([
  "run_started",
  "run_progress",
  "run_complete",
  "pr_opened",
  "deploy",
  "file_added",
  "work_session",
  "member_added",
  "lifecycle_card",
]);

/** US-001 lifecycle_card kinds, plus companies_summary (US-002). */
export const LIFECYCLE_CARD_KINDS = [
  "create_company",
  "activate_cloud",
  "upgrade_plan",
  "create_agent",
  "status",
  "companies_summary",
  "tab_row",
] as const;
export type LifecycleCardKind = (typeof LIFECYCLE_CARD_KINDS)[number];

export const LIFECYCLE_CARD_STATES = [
  "open",
  "pending",
  "done",
  "blocked",
  "skipped",
] as const;
export type LifecycleCardState = (typeof LIFECYCLE_CARD_STATES)[number];

export const LIFECYCLE_CARD_CONTROLS = [
  "text",
  "select",
  "radio",
  "readonly",
] as const;
export type LifecycleCardControl = (typeof LIFECYCLE_CARD_CONTROLS)[number];

export const LIFECYCLE_CARD_ACTION_STYLES = [
  "primary",
  "secondary",
  "link",
] as const;
export type LifecycleCardActionStyle =
  (typeof LIFECYCLE_CARD_ACTION_STYLES)[number];

const KINDS_ALLOWING_NULL_COMPANY = new Set<string>([
  "create_company",
  "companies_summary",
]);

const DEFAULT_LIFECYCLE_TITLES: Record<LifecycleCardKind, string> = {
  create_company: "Name your company",
  activate_cloud: "Turning on cloud sync",
  upgrade_plan: "Choose a plan",
  create_agent: "Create an agent",
  status: "Status",
  companies_summary: "Your companies",
  tab_row: "Row",
};

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

/** Muted one-line system event (everything except cards). */
export interface SystemEventLineModel {
  kind: "line";
  type: Exclude<KnownSystemEventType, "run_complete" | "lifecycle_card">;
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

export interface LifecycleCardFieldOption {
  id: string;
  label: string;
  description: string | null;
  price: string | null;
}

export interface LifecycleCardField {
  id: string;
  label: string;
  control: LifecycleCardControl;
  options: LifecycleCardFieldOption[];
  value: string;
  required: boolean;
  error: string | null;
  hint: string | null;
  description: string | null;
}

export interface LifecycleCardAction {
  id: string;
  label: string;
  style: LifecycleCardActionStyle;
  href: string | null;
}

export interface LifecycleCardViewer {
  canAct: boolean;
  actorName: string | null;
}

/** Server-stamped lifecycle card (US-008). Unknown version → not parsed. */
export interface LifecycleCardModel {
  kind: "lifecycle_card";
  cardId: string;
  cardKind: LifecycleCardKind;
  companyUid: string | null;
  state: LifecycleCardState;
  title: string;
  summary: string | null;
  stepLabel: string | null;
  help: string | null;
  reason: string | null;
  statusLabel: string | null;
  fields: LifecycleCardField[];
  actions: LifecycleCardAction[];
  viewer: LifecycleCardViewer;
}

/** Bubbled from LifecycleCard — host posts; this layer stays zero-network. */
export interface LifecycleCardActionEvent {
  channelId: string;
  cardId: string;
  actionId: string;
  values: Record<string, string>;
}

export type SystemEventModel =
  | SystemEventLineModel
  | RunCompleteCardModel
  | LifecycleCardModel;

const DEFAULT_TITLES: Record<
  Exclude<KnownSystemEventType, "run_complete" | "lifecycle_card">,
  string
> = {
  run_started: "Run started",
  run_progress: "Run progress",
  pr_opened: "PR opened",
  deploy: "Deployed",
  file_added: "File added",
  work_session: "Work session",
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

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function parseLifecycleField(raw: unknown): LifecycleCardField | null {
  if (!isRecord(raw)) return null;
  const id = asOptionalString(raw.id);
  const label = asOptionalString(raw.label);
  if (!id || !label) return null;
  if (!isOneOf(raw.control, LIFECYCLE_CARD_CONTROLS)) return null;
  const options: LifecycleCardFieldOption[] = [];
  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options)) return null;
    for (const option of raw.options) {
      if (!isRecord(option)) return null;
      const optionId = asOptionalString(option.id);
      const optionLabel = asOptionalString(option.label);
      if (!optionId || !optionLabel) return null;
      options.push({
        id: optionId,
        label: optionLabel,
        description: asOptionalString(option.description),
        price: asOptionalString(option.price),
      });
    }
  }
  if (raw.value !== undefined && typeof raw.value !== "string") return null;
  if (raw.required !== undefined && typeof raw.required !== "boolean") {
    return null;
  }
  return {
    id,
    label,
    control: raw.control,
    options,
    value: typeof raw.value === "string" ? raw.value : "",
    required: raw.required === true,
    error: asOptionalString(raw.error),
    hint: asOptionalString(raw.hint),
    description: asOptionalString(raw.description),
  };
}

function parseLifecycleAction(raw: unknown): LifecycleCardAction | null {
  if (!isRecord(raw)) return null;
  const id = asOptionalString(raw.id);
  const label = asOptionalString(raw.label);
  if (!id || !label) return null;
  if (!isOneOf(raw.style, LIFECYCLE_CARD_ACTION_STYLES)) return null;
  const href = asOptionalString(raw.href);
  if (raw.style === "link" && !href) return null;
  if (raw.href !== undefined && typeof raw.href !== "string") return null;
  return { id, label, style: raw.style, href };
}

function parseLifecycleViewer(raw: unknown): LifecycleCardViewer {
  if (!isRecord(raw)) return { canAct: true, actorName: null };
  return {
    canAct: raw.canAct !== false,
    actorName: asOptionalString(raw.actorName) ?? asOptionalString(raw.askName),
  };
}

/**
 * Parse a lifecycle_card v1 envelope. Unknown version is gated by
 * parseSystemEvent (returns null). Invalid shape → null (render nothing).
 */
export function parseLifecycleCard(raw: unknown): LifecycleCardModel | null {
  if (!isRecord(raw)) return null;
  if (asOptionalString(raw.type) !== "lifecycle_card") return null;
  if ("v" in raw && raw.v !== 1 && raw.v !== "1") return null;
  const cardId = asOptionalString(raw.cardId);
  if (!cardId) return null;
  if (!isOneOf(raw.kind, LIFECYCLE_CARD_KINDS)) return null;
  if (!isOneOf(raw.state, LIFECYCLE_CARD_STATES)) return null;

  let companyUid: string | null;
  if (raw.companyUid === null || raw.companyUid === undefined) {
    companyUid = null;
  } else if (typeof raw.companyUid === "string" && raw.companyUid.length > 0) {
    companyUid = raw.companyUid;
  } else {
    return null;
  }
  if (!KINDS_ALLOWING_NULL_COMPANY.has(raw.kind) && companyUid === null) {
    return null;
  }
  if (!Array.isArray(raw.fields) || !Array.isArray(raw.actions)) return null;

  const fields: LifecycleCardField[] = [];
  for (const field of raw.fields) {
    const parsed = parseLifecycleField(field);
    if (!parsed) return null;
    fields.push(parsed);
  }
  const actions: LifecycleCardAction[] = [];
  for (const action of raw.actions) {
    const parsed = parseLifecycleAction(action);
    if (!parsed) return null;
    actions.push(parsed);
  }

  const viewer = parseLifecycleViewer(raw.viewer);
  const actorName =
    viewer.actorName ??
    asOptionalString(raw.actorName) ??
    asOptionalString(raw.ownerName);
  return {
    kind: "lifecycle_card",
    cardId,
    cardKind: raw.kind,
    companyUid,
    state: raw.state,
    title:
      asOptionalString(raw.title) ?? DEFAULT_LIFECYCLE_TITLES[raw.kind],
    summary: asOptionalString(raw.summary),
    stepLabel: asOptionalString(raw.stepLabel),
    help: asOptionalString(raw.help),
    reason:
      asOptionalString(raw.reason) ??
      asOptionalString(raw.blockReason) ??
      asOptionalString(raw.message),
    statusLabel: asOptionalString(raw.statusLabel),
    fields,
    actions,
    viewer: { canAct: viewer.canAct, actorName },
  };
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

/**
 * Parse a systemEvent envelope into a render model.
 *
 * Absent-safe rules:
 * - null/undefined/non-object → null
 * - `v` present and not 1 → null (unknown version)
 * - unknown `type` → null
 * - known non-run_complete types → line model (title falls back to a default)
 * - run_complete → card; missing previewUrl/diffUrl leave those buttons hidden
 * - lifecycle_card → card; invalid shape or unknown version → null
 */
export function parseSystemEvent(raw: unknown): SystemEventModel | null {
  if (raw == null) return null;
  if (!isRecord(raw)) return null;

  // Version gate: absent v is treated as v1 (tolerant); present non-1 is unknown.
  if ("v" in raw && raw.v !== 1 && raw.v !== "1") return null;

  const type = asOptionalString(raw.type);
  if (!type || !KNOWN_TYPES.has(type)) return null;

  if (type === "lifecycle_card") return parseLifecycleCard(raw);

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

  const lineType = type as Exclude<
    KnownSystemEventType,
    "run_complete" | "lifecycle_card"
  >;
  const sessionTitle =
    type === "work_session"
      ? (note ?? title ?? (status ? `Work session · ${status}` : null))
      : title;
  return {
    kind: "line",
    type: lineType,
    title: sessionTitle ?? DEFAULT_TITLES[lineType],
    summary: summary ?? (type === "work_session" ? status : null),
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
