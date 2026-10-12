/**
 * US-005: "Hidden from AI" redaction preset toggles for one connection.
 *
 * The page talks to the server only through `RedactionPresetsApi`. The US-004
 * hq-pro contract is not published yet, so the host wires an adapter that
 * implements this interface once it is; until then the row is not shown.
 * Everything here is pure so the parsing and the pending-state rules are
 * testable without the page.
 */

export interface RedactionPreset {
  id: RedactionPresetId;
  label: string;
  enabled: boolean;
}

export interface RedactionSettings {
  presets: RedactionPreset[];
}

/** What the page needs from the server. Implemented by the host adapter. */
export interface RedactionPresetsApi {
  /** Read the presets for one hq-pro connection. */
  load(companyUid: string, connectionId: string): Promise<RedactionSettings>;
  /** Turn one preset on or off (a PUT). Resolves with the saved settings. */
  set(companyUid: string, connectionId: string, presetId: RedactionPresetId, enabled: boolean): Promise<RedactionSettings>;
}

/** The four presets, in display order, with the ids and labels of hq-pro #4910. */
export const REDACTION_PRESETS = [
  { id: "personal-ids", label: "Personal IDs" },
  { id: "hr-pay", label: "Salary and HR" },
  { id: "legal", label: "Legal matters" },
  { id: "financial", label: "Bank and card numbers" },
] as const;

export type RedactionPresetId = (typeof REDACTION_PRESETS)[number]["id"];

const PRESET_IDS = new Set<string>(REDACTION_PRESETS.map((p) => p.id));

/** A connection with no setting hides all four. */
export function defaultRedactionSettings(): RedactionSettings {
  return { presets: REDACTION_PRESETS.map((p) => ({ id: p.id, label: p.label, enabled: true })) };
}

/**
 * Defensive parse of a server answer. Always returns the four presets in
 * order with the local labels. A preset the answer leaves out, or an answer
 * with no `presets` list at all (no setting yet), is on. Unknown ids are
 * ignored. Accepts `[{ id, enabled }]` or an `{ id: enabled }` map.
 */
export function parseRedactionSettings(body: unknown): RedactionSettings {
  const raw = (body as { presets?: unknown } | null)?.presets;
  const values = new Map<string, boolean>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      if (typeof r.id === "string" && PRESET_IDS.has(r.id) && typeof r.enabled === "boolean" && !values.has(r.id)) {
        values.set(r.id, r.enabled);
      }
    }
  } else if (raw && typeof raw === "object") {
    for (const [id, enabled] of Object.entries(raw as Record<string, unknown>)) {
      if (PRESET_IDS.has(id) && typeof enabled === "boolean") values.set(id, enabled);
    }
  }
  return {
    presets: REDACTION_PRESETS.map((p) => ({ id: p.id, label: p.label, enabled: values.get(p.id) ?? true })),
  };
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

export interface RedactionRowState {
  /** null = not loaded yet. */
  settings: RedactionSettings | null;
  /** Preset ids with a save in flight. */
  pending: ReadonlySet<string>;
  /** Plain line after a failed read or save; never server text. */
  error: string | null;
}

export const EMPTY_ROW_STATE: RedactionRowState = { settings: null, pending: new Set(), error: null };

/** The value a toggle shows: the requested value while its save is pending. */
export function withToggle(state: RedactionRowState, presetId: RedactionPresetId, enabled: boolean): RedactionRowState {
  if (!state.settings) return state;
  const pending = new Set(state.pending);
  pending.add(presetId);
  return {
    settings: {
      presets: state.settings.presets.map((p) => (p.id === presetId ? { ...p, enabled } : p)),
    },
    pending,
    error: null,
  };
}

/** A save finished: take the server's value for that preset, clear pending. */
export function withSaved(state: RedactionRowState, presetId: RedactionPresetId, saved: RedactionSettings): RedactionRowState {
  const pending = new Set(state.pending);
  pending.delete(presetId);
  const server = saved.presets.find((p) => p.id === presetId);
  if (!state.settings) return { settings: saved, pending, error: null };
  return {
    settings: {
      presets: state.settings.presets.map((p) => (p.id === presetId && server ? { ...p, enabled: server.enabled } : p)),
    },
    pending,
    error: state.error,
  };
}

/** A save failed: put the previous value back, clear pending, say so. */
export function withFailed(state: RedactionRowState, presetId: RedactionPresetId, previous: boolean): RedactionRowState {
  const pending = new Set(state.pending);
  pending.delete(presetId);
  if (!state.settings) return { ...state, pending };
  return {
    settings: {
      presets: state.settings.presets.map((p) => (p.id === presetId ? { ...p, enabled: previous } : p)),
    },
    pending,
    error: "Couldn't save that change. Try again.",
  };
}
