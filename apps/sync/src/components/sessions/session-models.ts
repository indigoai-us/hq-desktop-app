// The composer's model / effort / permission pills — pure vocabulary.
//
// The CLI announces its model catalog through `agent_session_slash_commands`
// as free-form JSON. The real handshake sends
//   { value, displayName, description }
// e.g. `{ value: 'claude-fable-5-1[1m]', displayName: 'Fable' }`, alongside a
// `{ value: 'default', displayName: 'Default (recommended)' }` row. This module
// is the ONE place that shape is read, defended, and given a fallback, so the
// composer never renders `[object Object]` into a pill and never sends a model
// id the CLI would reject.
//
// PURE: no runes, no Tauri, no DOM.

import type { ImageAttachment } from './session-events';

/**
 * An attachment as the COMPOSER holds it: the wire shape plus the file name,
 * which exists only so the chip can be labelled and removed.
 */
export interface ComposerImage extends ImageAttachment {
  name: string;
}

/** One model the composer can offer. */
export interface SessionModel {
  /** What `SessionSpec.model` carries. `null` means "omit `model` entirely". */
  value: string | null;
  /** The pill label. */
  label: string;
  description?: string;
}

/**
 * "Default (recommended)" is the CLI's own phrasing for a picker with room to
 * breathe; a pill has none, so the parenthetical is dropped.
 */
export function shortenModelLabel(label: string): string {
  return label.replace(/\s*\(recommended\)\s*$/i, '').trim();
}

/**
 * The catalog to offer when the probe fails or returns nothing recognisable.
 * Every id here is a real CLI alias, and "Default" omits `model` rather than
 * guessing one.
 */
export const FALLBACK_MODELS: SessionModel[] = [
  { value: null, label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

/**
 * Read the CLI's model catalog.
 *
 * `{ value: 'default' }` is translated to a `null` value — the spec's `model`
 * field is optional, and sending the literal string "default" would be sending
 * the CLI a model name rather than declining to choose one. Entries with no
 * usable id are dropped rather than rendered; an empty result falls back.
 */
export function readSessionModels(raw: ReadonlyArray<unknown>): SessionModel[] {
  const models: SessionModel[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (typeof entry === 'string') {
      if (entry.length === 0) continue;
      const value = entry === 'default' ? null : entry;
      const key = value ?? '@default';
      if (seen.has(key)) continue;
      seen.add(key);
      models.push({ value, label: shortenModelLabel(entry) });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    // `name` is BOTH a plausible id and a plausible label. Whichever role it
    // is not filling here, it is available for the other — so `{ id, name }`
    // reads as an id plus a label, while a lone `{ name }` is the id itself.
    const idKey = firstKey(record, ['value', 'id', 'model', 'name']);
    if (idKey === null) continue;
    const id = record[idKey] as string;
    const value = id === 'default' ? null : id;
    const key = value ?? '@default';
    if (seen.has(key)) continue;
    seen.add(key);
    const labelKeys =
      idKey === 'name'
        ? ['displayName', 'display_name', 'label']
        : ['displayName', 'display_name', 'label', 'name'];
    const label = firstString(record, labelKeys) ?? id;
    const description = firstString(record, ['description']) ?? undefined;
    models.push({ value, label: shortenModelLabel(label), description });
  }

  return models.length > 0 ? models : [...FALLBACK_MODELS];
}

function firstKey(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return key;
  }
  return null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  const key = firstKey(record, keys);
  return key === null ? null : (record[key] as string);
}

/** The reasoning-effort pill. `null` sends no `effort` at all. */
export interface EffortOption {
  value: string | null;
  label: string;
}

export const EFFORT_OPTIONS: EffortOption[] = [
  { value: null, label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

/** localStorage keys for the pills that should survive a restart. */
export const LAST_COMPANY_KEY = 'hq.sessions.lastCompany';
export const LAST_MODEL_KEY = 'hq.sessions.lastModel';
export const LAST_EFFORT_KEY = 'hq.sessions.lastEffort';

/**
 * Read a remembered pill choice. Storage can throw (private mode, a disabled
 * origin), and a lost preference must never be the thing that stops a session
 * from starting — so every failure reads as "nothing remembered".
 */
export function readRemembered(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Remember a pill choice, or forget it when the choice is the implicit one. */
export function remember(key: string, value: string | null): void {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // A preference that cannot be persisted is not worth failing a send over.
  }
}

/**
 * Pick the model to start with: the remembered one when the catalog still
 * offers it, else the catalog's own first entry.
 *
 * The remembered value is a model ID; `null` (the "Default" row) is remembered
 * as the absence of the key, which is also what an unset preference reads as —
 * so both land on the first entry, which the catalog puts Default at.
 */
export function pickModel(
  models: ReadonlyArray<SessionModel>,
  rememberedValue: string | null,
): SessionModel | null {
  if (models.length === 0) return null;
  if (rememberedValue !== null) {
    const hit = models.find((model) => model.value === rememberedValue);
    if (hit) return hit;
  }
  return models[0] ?? null;
}
