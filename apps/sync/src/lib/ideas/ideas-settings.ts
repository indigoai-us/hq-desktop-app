/**
 * Idea Board settings adapter (US-012).
 *
 * The single boundary between the Ideas settings panel and the host: typed
 * state, normalized company list, chord rebinding, and preference writes that
 * always go through the shared settings mutation queue so an Ideas toggle can
 * never clobber an unrelated Settings change.
 */
import { invoke } from '@tauri-apps/api/core';
import { updateSettings } from '../settings-mutations';

export type IdeasExtractionMode = 'local' | 'model';

/** Mirrors the Rust `IdeasSettingsState` wire shape (camelCase). */
export interface IdeasSettingsState {
  extractionMode: IdeasExtractionMode;
  syncEnabled: boolean;
  /** null = follow the active company. */
  defaultCompany: string | null;
  activeCompany: string;
  imageMaxEdge: number;
  imageMaxEdgeChoices: number[];
  captureChord: string;
  captureChordDisplay: string;
  modelDisclosure: string;
  localOnly: boolean;
  /**
   * Where captures would be written under the current sync preference — the
   * SYNCED vault path when sync is on, the local-only root when it is off.
   * Not a statement about where anything has actually been written: the
   * capture write path does not consult the sync preference yet.
   */
  capturesRoot: string;
}

export interface IdeaCompany {
  slug: string;
  name: string;
}

export interface ChordApplied {
  chord: string;
  display: string;
  /**
   * Non-fatal. The rebind succeeded, but the OS refused to release the
   * previous chord even on a retry, so that combination may stay reserved
   * system-wide until HQ restarts. The panel renders it inline.
   */
  staleChordWarning?: string | null;
}

/** The Ideas preference keys as they are stored in menubar.json. */
export interface IdeasPrefsPatch {
  ideasExtractionMode?: IdeasExtractionMode;
  ideasSyncEnabled?: boolean;
  ideasDefaultCompany?: string | null;
  ideasImageMaxEdge?: number;
}

export function loadIdeasSettings(): Promise<IdeasSettingsState> {
  return invoke<IdeasSettingsState>('ideas_get_settings');
}

/**
 * Pull the array out of whatever the command hands back.
 *
 * `ideas_list_companies` returns a bare `Vec<String>` today, but a Tauri
 * command's payload is object-wrapped by some hosts and serializers, and a
 * later revision could return richer rows. Normalizing here means the panel
 * never has to care, and an unexpected shape degrades to an empty list rather
 * than throwing inside a render.
 */
function unwrapList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.companies)) return obj.companies;
    if (Array.isArray(obj.items)) return obj.items;
  }
  return [];
}

/** Coerce one entry into a company row, or drop it when it carries no slug. */
function toCompany(entry: unknown): IdeaCompany | null {
  if (typeof entry === 'string') {
    const slug = entry.trim();
    return slug ? { slug, name: slug } : null;
  }
  if (entry && typeof entry === 'object') {
    const obj = entry as Record<string, unknown>;
    const slug = typeof obj.slug === 'string' ? obj.slug.trim() : '';
    if (!slug) return null;
    const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : slug;
    return { slug, name };
  }
  return null;
}

export function normalizeCompanies(raw: unknown): IdeaCompany[] {
  return unwrapList(raw)
    .map(toCompany)
    .filter((row): row is IdeaCompany => row !== null);
}

export async function listIdeaCompanies(): Promise<IdeaCompany[]> {
  return normalizeCompanies(await invoke('ideas_list_companies'));
}

export function setCaptureChord(chord: string): Promise<ChordApplied> {
  return invoke<ChordApplied>('ideas_set_capture_chord', { chord });
}

/**
 * Persist Ideas preferences. Always through `updateSettings` — the serializing
 * queue re-reads and merges the latest prefs, so this patch cannot wipe a
 * concurrent SettingsPage change.
 */
export function saveIdeasPrefs(patch: IdeasPrefsPatch): Promise<void> {
  return updateSettings(patch as Record<string, unknown>);
}

export interface LocalOnlyBadge {
  label: string;
  title: string;
}

/**
 * Board-header badge descriptor for the "sync off" posture (AC3).
 *
 * Returned as data rather than markup so the board header — owned elsewhere —
 * can render it in its own idiom. `null` means captures are syncing and no
 * badge belongs on the header.
 *
 * The wording is deliberately NOT a present-tense privacy promise. The sync
 * preference is stored and read back, but the capture write path still resolves
 * every capture through the vault, so a badge reading "captures stay on this
 * machine" would be false. Keep it conditional until the pipeline adopts
 * `ideas::settings::ideas_root`.
 */
export function localOnlyBadge(
  state: Pick<IdeasSettingsState, 'syncEnabled' | 'capturesRoot'> | null | undefined,
): LocalOnlyBadge | null {
  if (!state || state.syncEnabled) return null;
  const where = state.capturesRoot ? ` They will go to ${state.capturesRoot}.` : '';
  return {
    label: 'local only — not in effect yet',
    title:
      'You have asked for captures to be kept off the company vault. That preference is saved, but capture does not use it yet, so captures still go to the vault and still sync to your team.' +
      where,
  };
}
