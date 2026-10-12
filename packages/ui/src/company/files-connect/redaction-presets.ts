/**
 * US-005: "Hidden from AI" redaction preset toggles for one connected app.
 *
 * The page talks to the server only through `RedactionPresetsApi`. The US-004
 * hq-pro contract is not published yet, so the host wires an adapter that
 * implements this interface once it is; until then the row is not shown.
 * Everything here is pure so the parsing and the pending-state rules are
 * testable without the page.
 */

export interface RedactionPreset {
  /** Stable server id, e.g. "emails". */
  id: string;
  /** Plain label the server sends; a known id gets a local fallback. */
  label: string;
  enabled: boolean;
}

export interface RedactionSettings {
  presets: RedactionPreset[];
}

/**
 * The app the row is about: the page's grouping key (the app's domain, e.g.
 * "slack.com") and the hq-pro connection ids under it. The adapter maps this
 * to whatever key US-004 settles on (per app or per connection).
 */
export interface RedactionAppRef {
  key: string;
  connectionIds: string[];
}

/** What the page needs from the server. Implemented by the host adapter. */
export interface RedactionPresetsApi {
  /** Read the presets for one connected app. */
  load(companyUid: string, app: RedactionAppRef): Promise<RedactionSettings>;
  /** Turn one preset on or off. Resolves with the saved settings. */
  set(companyUid: string, app: RedactionAppRef, presetId: string, enabled: boolean): Promise<RedactionSettings>;
}

/**
 * Local labels for the four presets this story ships with. Used only when the
 * server sends an id without a label. Ids are a proposal until US-004 lands.
 */
export const DEFAULT_PRESET_LABELS: Readonly<Record<string, string>> = {
  emails: "Email addresses",
  phone_numbers: "Phone numbers",
  payment_cards: "Payment card numbers",
  government_ids: "Government ID numbers",
};

/** Defensive parse of a server answer. Throws on a shape it cannot use. */
export function parseRedactionSettings(body: unknown): RedactionSettings {
  const list = (body as { presets?: unknown } | null)?.presets;
  if (!Array.isArray(list)) throw new Error("redaction settings: presets missing");
  const presets: RedactionPreset[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!id || seen.has(id) || typeof r.enabled !== "boolean") continue;
    const label =
      typeof r.label === "string" && r.label.trim() ? r.label.trim() : (DEFAULT_PRESET_LABELS[id] ?? id);
    seen.add(id);
    presets.push({ id, label, enabled: r.enabled });
  }
  return { presets };
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
export function withToggle(state: RedactionRowState, presetId: string, enabled: boolean): RedactionRowState {
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
export function withSaved(state: RedactionRowState, presetId: string, saved: RedactionSettings): RedactionRowState {
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
export function withFailed(state: RedactionRowState, presetId: string, previous: boolean): RedactionRowState {
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
