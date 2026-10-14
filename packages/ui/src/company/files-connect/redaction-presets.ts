/**
 * US-005: "Hidden from AI" redaction preset toggles for one connection, on
 * the US-004 hq-pro contract (#4915):
 *
 *   GET /v1/integrations/admin/redaction?companyUid=…&connectionId=…
 *   PUT /v1/integrations/admin/redaction  { companyUid, connectionId, presets }
 *
 * `presets` is the whole list of presets that are on, in canonical order;
 * a PUT replaces it (`[]` = all off). Both answer `{ companyUid, connectionId,
 * presets, availablePresets, isDefault, updatedAt, updatedBy, canEdit }`.
 * Refusals are `{ error, code }`: 400 REDACTION_REQUEST_INVALID, 403
 * REDACTION_ADMIN_REQUIRED, 404 CONNECTION_NOT_FOUND.
 *
 * The row talks to the server only through `RedactionPresetsApi`; the
 * production one is built from the platform adapter by
 * `createRedactionPresetsApi`. Everything else here is pure.
 */
import type { AdapterResult, CompanyApi, Json } from "@hq/platform";

/** The four presets, in canonical order, with the ids and labels of hq-pro #4910. */
export const REDACTION_PRESETS = [
  { id: "personal-ids", label: "Personal IDs" },
  { id: "hr-pay", label: "Salary and HR" },
  { id: "legal", label: "Legal matters" },
  { id: "financial", label: "Bank and card numbers" },
] as const;

export type RedactionPresetId = (typeof REDACTION_PRESETS)[number]["id"];

const PRESET_IDS = new Set<string>(REDACTION_PRESETS.map((p) => p.id));

export interface RedactionPreset {
  id: RedactionPresetId;
  label: string;
  enabled: boolean;
}

export interface RedactionSettings {
  /** The presets this connection shows, in canonical order. */
  presets: RedactionPreset[];
  /** The server's `canEdit`; null when the answer did not say. */
  canEdit: boolean | null;
}

/** A refused read or save. `code` is the server code or `http-<status>`. */
export class RedactionError extends Error {
  readonly code: string;
  readonly status: number | null;
  constructor(code: string, status: number | null) {
    super(`redaction request refused: ${code}`);
    this.name = "RedactionError";
    this.code = code;
    this.status = status;
  }
}

/** What the row needs from the server. */
export interface RedactionPresetsApi {
  /** Read one connection's presets. Throws `RedactionError` on a refusal. */
  load(companyUid: string, connectionId: string): Promise<RedactionSettings>;
  /** Replace the list of presets that are on. Throws `RedactionError`. */
  save(companyUid: string, connectionId: string, enabled: readonly RedactionPresetId[]): Promise<RedactionSettings>;
}

function presetIdOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
    return (value as { id: string }).id;
  }
  return null;
}

/**
 * Read a US-004 answer. A missing `presets` list means no setting yet, which
 * is all off: redaction is opt-in (hq-pro #4978). `availablePresets` narrows which switches show (ids or `{ id }`);
 * when it is missing or names none of the four, all four show. Unknown ids
 * are ignored.
 */
export function parseRedactionAnswer(body: unknown): RedactionSettings {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const on = Array.isArray(rec.presets)
    ? new Set(rec.presets.map(presetIdOf).filter((id): id is string => id !== null && PRESET_IDS.has(id)))
    : null;
  const available = Array.isArray(rec.availablePresets)
    ? new Set(rec.availablePresets.map(presetIdOf).filter((id): id is string => id !== null && PRESET_IDS.has(id)))
    : null;
  const shown = REDACTION_PRESETS.filter((p) => !available || available.size === 0 || available.has(p.id));
  return {
    presets: shown.map((p) => ({ id: p.id, label: p.label, enabled: on ? on.has(p.id) : false })),
    canEdit: typeof rec.canEdit === "boolean" ? rec.canEdit : null,
  };
}

/** The PUT body's list: the presets that are on, in canonical order. */
export function enabledPresetIds(settings: RedactionSettings): RedactionPresetId[] {
  return settings.presets.filter((p) => p.enabled).map((p) => p.id);
}

function unwrap(result: AdapterResult<Json>): RedactionSettings {
  if (result.ok) return parseRedactionAnswer(result.value);
  throw new RedactionError(result.code ?? "error", result.status ?? null);
}

/**
 * The production API over the platform adapter's hq-pro client. Null when the
 * host has no redaction calls (web, older hosts); the row is then not shown.
 */
export function createRedactionPresetsApi(
  company: Pick<CompanyApi, "getRedaction" | "putRedaction"> | null | undefined,
): RedactionPresetsApi | null {
  const get = company?.getRedaction;
  const put = company?.putRedaction;
  if (!get || !put) return null;
  return {
    load: async (companyUid, connectionId) => unwrap(await get(companyUid, connectionId)),
    save: async (companyUid, connectionId, enabled) => unwrap(await put(companyUid, connectionId, [...enabled])),
  };
}

/** A read that found no redaction route at all (hq-pro without US-004). */
export function isRedactionUnsupported(err: unknown): boolean {
  return err instanceof RedactionError && err.status === 404 && err.code !== "CONNECTION_NOT_FOUND";
}

/** Plain line for a refused read. Never server text. */
export function loadFailureLine(err: unknown): string {
  if (err instanceof RedactionError && err.code === "CONNECTION_NOT_FOUND") {
    return "This connection is no longer connected.";
  }
  if (err instanceof RedactionError && (err.code === "REDACTION_ADMIN_REQUIRED" || err.status === 403)) {
    return "You don't have access to these settings.";
  }
  return "Couldn't load these settings.";
}

/** Plain line for a refused save. Never server text. */
export function saveFailureLine(err: unknown): string {
  if (err instanceof RedactionError && (err.code === "REDACTION_ADMIN_REQUIRED" || err.status === 403)) {
    return "Only owners and admins can change this.";
  }
  if (err instanceof RedactionError && err.code === "CONNECTION_NOT_FOUND") {
    return "This connection is no longer connected.";
  }
  return "Couldn't save that change. Try again.";
}

/** A refusal that means this viewer cannot edit, whatever the role said. */
export function isAdminRequired(err: unknown): boolean {
  return err instanceof RedactionError && (err.code === "REDACTION_ADMIN_REQUIRED" || err.status === 403);
}

/**
 * Owners and admins can change the toggles; members see them read-only.
 * Reads the hq-pro admin surface `viewer`: an explicit role decides, and the
 * `canManageIntegrations` flag is the fallback. Unknown stays read-only.
 */
export function viewerCanEditRedaction(body: unknown): boolean {
  const viewer = (body as { viewer?: unknown } | null)?.viewer;
  if (!viewer || typeof viewer !== "object") return false;
  const v = viewer as Record<string, unknown>;
  if (v.role === "owner" || v.role === "admin") return true;
  if (v.role === "member") return false;
  return v.canManageIntegrations === true;
}

/** Editable only when the role allows it and the server does not say no. */
export function rowCanEdit(roleCanEdit: boolean, settings: RedactionSettings | null): boolean {
  return roleCanEdit && settings?.canEdit !== false;
}

export interface RedactionRowState {
  /** null = not loaded yet. */
  settings: RedactionSettings | null;
  /** Preset ids with a save in flight. */
  pending: ReadonlySet<RedactionPresetId>;
  /** Plain line after a failed save; never server text. */
  error: string | null;
}

export const EMPTY_ROW_STATE: RedactionRowState = { settings: null, pending: new Set(), error: null };

function setPreset(settings: RedactionSettings, presetId: RedactionPresetId, enabled: boolean): RedactionSettings {
  return { ...settings, presets: settings.presets.map((p) => (p.id === presetId ? { ...p, enabled } : p)) };
}

/** The value a toggle shows: the requested value while its save is pending. */
export function withToggle(state: RedactionRowState, presetId: RedactionPresetId, enabled: boolean): RedactionRowState {
  if (!state.settings) return state;
  const pending = new Set(state.pending);
  pending.add(presetId);
  return { settings: setPreset(state.settings, presetId, enabled), pending, error: null };
}

/**
 * A save finished. The server's answer decides every preset that has no other
 * save in flight; a preset still pending keeps the value it shows.
 */
export function withSaved(state: RedactionRowState, presetId: RedactionPresetId, saved: RedactionSettings): RedactionRowState {
  const pending = new Set(state.pending);
  pending.delete(presetId);
  const current = new Map((state.settings?.presets ?? []).map((p) => [p.id, p.enabled]));
  return {
    settings: {
      canEdit: saved.canEdit,
      presets: saved.presets.map((p) => (pending.has(p.id) && current.has(p.id) ? { ...p, enabled: current.get(p.id)! } : p)),
    },
    pending,
    error: state.error,
  };
}

/** A save failed: put the previous value back, clear pending, say so. */
export function withFailed(
  state: RedactionRowState,
  presetId: RedactionPresetId,
  previous: boolean,
  err: unknown,
): RedactionRowState {
  const pending = new Set(state.pending);
  pending.delete(presetId);
  if (!state.settings) return { ...state, pending };
  const settings = setPreset(state.settings, presetId, previous);
  return {
    settings: isAdminRequired(err) ? { ...settings, canEdit: false } : settings,
    pending,
    error: saveFailureLine(err),
  };
}
