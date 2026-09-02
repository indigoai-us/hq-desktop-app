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

// ---------------------------------------------------------------------------
// Friendly names — the pill never shows a raw model id
// ---------------------------------------------------------------------------

/** Which agent CLI a session drives. Mirrors the store's `SessionTool`. */
export type SessionToolId = 'claude' | 'codex';

/** The tool pill's vocabulary. The glyphs are text, so there is no icon dep. */
export const TOOL_OPTIONS: ReadonlyArray<{
  value: SessionToolId;
  label: string;
  glyph: string;
}> = [
  { value: 'claude', label: 'Claude', glyph: '✳' },
  { value: 'codex', label: 'Codex', glyph: '⌁' },
];

export const LAST_TOOL_KEY = 'hq.sessions.lastTool';

/** The remembered tool, defended down to the only tool that always exists. */
export function readRememberedTool(): SessionToolId {
  return readRemembered(LAST_TOOL_KEY) === 'codex' ? 'codex' : 'claude';
}

/** Families whose name is an acronym rather than a word. */
const ACRONYM_FAMILIES = new Set(['gpt', 'o1', 'o3', 'o4']);

/** `claude-fable-5-1[1m]` → the `1m` is a context window, not part of the name. */
const CONTEXT_SUFFIX = /\[(\d+)m\]$/i;

function titleCaseFamily(word: string): string {
  const lower = word.toLowerCase();
  if (ACRONYM_FAMILIES.has(lower)) return lower === 'gpt' ? 'GPT' : lower;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Turn a model ID into something a person would say out loud.
 *
 *   claude-opus-4-8            → Opus 4.8
 *   claude-fable-5-1[1m]       → Fable 5.1
 *   claude-haiku-4-5-20260101  → Haiku 4.5      (the build date is not a version)
 *   opus[1m]                   → Opus (1M)
 *
 * The `[1m]` suffix is only spoken when the name carries no version, because
 * that is the only case where it is doing disambiguating work: `opus` and
 * `opus[1m]` are two rows in the same menu, while `claude-fable-5-1[1m]` has
 * no sibling it could be confused with.
 *
 * Anything unrecognisable returns `''` so the caller can fall back honestly
 * rather than render half a parse.
 */
export function friendlyModelName(value: string | null | undefined): string {
  if (!value) return '';
  let id = value.trim();
  if (id.length === 0) return '';

  let context = '';
  const suffix = CONTEXT_SUFFIX.exec(id);
  if (suffix && suffix.index > 0) {
    context = `${suffix[1]}M`.toUpperCase();
    id = id.slice(0, suffix.index);
  }

  id = id.replace(/^(?:us|eu|apac)\./i, '').replace(/^anthropic\./i, '');
  id = id.replace(/^claude[-.]/i, '');

  const parts = id.split(/[-_.]/).filter(Boolean);
  const family = parts[0];
  if (!family) return '';

  const version: string[] = [];
  for (const part of parts.slice(1)) {
    // A version segment is one or two digits. `20260101` is a build date, and
    // everything after it belongs to the same trailing stamp.
    if (!/^\d{1,2}$/.test(part)) break;
    version.push(part);
  }

  const name = titleCaseFamily(family);
  if (version.length > 0) return `${name} ${version.join('.')}`;
  return context ? `${name} (${context})` : name;
}

/**
 * The CLI names its own default inside the row's description:
 *   "Use the default model (currently Opus 5 (1M context))"
 * That parenthetical is the only pre-session evidence of what "Default" means,
 * so it is worth reading rather than showing the user the word "Default".
 */
export function defaultModelHint(description?: string | null): string {
  if (!description) return '';
  const match = /\bcurrently\s+(.+)$/i.exec(description);
  if (!match) return '';
  let text = match[1].trim();
  // Trim the closing parens that belonged to the sentence, not to the name.
  while (text.endsWith(')') && countChar(text, ')') > countChar(text, '(')) {
    text = text.slice(0, -1).trim();
  }
  return text.replace(/\s*\([^)]*context[^)]*\)\s*$/i, '').trim();
}

function countChar(text: string, char: string): number {
  let total = 0;
  for (const candidate of text) if (candidate === char) total += 1;
  return total;
}

/** The first sentence of a description — a menu subline, not a paragraph. */
export function firstSentence(text?: string | null): string {
  if (!text) return '';
  const trimmed = text.trim();
  const stop = trimmed.search(/[.!?](\s|$)/);
  return (stop === -1 ? trimmed : trimmed.slice(0, stop)).trim();
}

/**
 * The rows a user can actually pick. The CLI's "Default (recommended)" row is
 * not one of them: it names no model, so a menu that offers it is offering the
 * user a chance to un-choose rather than to choose.
 */
export function selectableModels(models: ReadonlyArray<SessionModel>): SessionModel[] {
  return models.filter((entry) => entry.value !== null);
}

/**
 * One menu row's label.
 *
 * For Claude the id IS the authoritative name — `claude-opus-4-8` reads as
 * "Opus 4.8" and the catalog's own label ("Opus") is the lossier of the two.
 *
 * For Codex it is the other way around. Codex ships several distinct models
 * per version — `gpt-5.6-sol`, `gpt-5.6-codex`, `gpt-5.6-codex-mini` — and the
 * friendly mapper collapses every one of them to "GPT 5.6", which put three
 * identical rows in the menu. Its `model/list` already carries the name a
 * person should read ("GPT-5.6-Sol", "GPT-5.6-Codex"), so that is used
 * VERBATIM, and the mapper is only the fallback for a row that carried no
 * `displayName` at all (which `readSessionModels` reports by falling the label
 * back to the id).
 */
export function modelRowLabel(
  entry: SessionModel,
  tool: SessionToolId = 'claude',
): string {
  if (tool === 'codex') {
    const display = shortenModelLabel(entry.label);
    if (display && display !== entry.value) return display;
  }
  return friendlyModelName(entry.value) || shortenModelLabel(entry.label);
}

/**
 * The rows the model menu renders: selectable, deduped by id, and never two
 * with the same words on them.
 *
 * The dedupe is by `value` because the id is what a choice sends — two rows
 * that send the same thing are one row. The label pass is the backstop for a
 * catalog that ships two DIFFERENT ids under one display name: rather than
 * offer a menu where the same words mean two things, the colliding rows carry
 * a short suffix taken from their own ids.
 */
export function modelMenuRows(
  models: ReadonlyArray<SessionModel>,
  tool: SessionToolId = 'claude',
): SessionModel[] {
  const rows: SessionModel[] = [];
  const seen = new Set<string>();
  for (const entry of selectableModels(models)) {
    const key = entry.value as string;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ ...entry, label: modelRowLabel(entry, tool) });
  }

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.label, (counts.get(row.label) ?? 0) + 1);
  return rows.map((row) =>
    (counts.get(row.label) ?? 0) > 1
      ? { ...row, label: `${row.label} (${idSuffix(row.value)})` }
      : row,
  );
}

/**
 * The part of a model id that distinguishes it from its siblings: everything
 * after the family, minus the version digits. `gpt-5.6-codex-mini` →
 * `codex-mini`. An id with nothing left to say falls back to itself, which is
 * ugly but never ambiguous.
 */
function idSuffix(value: string | null): string {
  if (!value) return '';
  const parts = value
    .split(/[-_.]/)
    .filter(Boolean)
    .filter((part) => !/^\d+$/.test(part));
  const tail = parts.slice(1);
  return tail.length > 0 ? tail.join('-') : value;
}

/**
 * What the model pill says. Never a raw id, never the word "Default".
 *
 * With an explicit choice it is that model's friendly name. With the implicit
 * default it is the model the CLI actually resolved (announced by `started`),
 * else the catalog's own hint about what the default currently is, and only if
 * both are unknown the CLI's other word for the same row.
 */
export function modelPillLabel(
  models: ReadonlyArray<SessionModel>,
  model: string | null,
  resolvedModel: string | null = null,
  tool: SessionToolId = 'claude',
): string {
  if (model !== null) {
    const hit = models.find((entry) => entry.value === model);
    if (hit) return modelRowLabel(hit, tool);
    return friendlyModelName(model) || model;
  }
  // The CLI resolved a model of its own. Name it the way the menu would, so a
  // Codex pill reads "GPT-5.6-Codex" rather than the mapper's "GPT 5.6".
  const resolvedHit =
    resolvedModel === null
      ? undefined
      : models.find((entry) => entry.value === resolvedModel);
  if (resolvedHit) return modelRowLabel(resolvedHit, tool);
  const resolved = friendlyModelName(resolvedModel);
  if (resolved) return resolved;
  if (resolvedModel) return resolvedModel;
  const hint = defaultModelHint(models.find((entry) => entry.value === null)?.description);
  if (hint) return hint;
  return 'Recommended';
}
