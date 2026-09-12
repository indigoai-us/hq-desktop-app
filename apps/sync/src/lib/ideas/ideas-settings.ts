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
   * Where new captures are written under the current sync preference — the
   * SYNCED vault path when sync is on, the local-only root when it is off.
   *
   * A statement about NEW captures only. Flipping the preference does not move
   * anything already on disk, so captures taken under the previous setting stay
   * where they were written.
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
 * Returned as data rather than markup so the board header can render it in its
 * own idiom. `null` means captures are syncing and no badge belongs on the
 * header.
 *
 * The wording is now present tense, and only as far as the code goes. The
 * capture write path resolves its root from this preference
 * (`ideas::settings::ideas_root`), so "new captures are not synced" is true.
 * What is NOT claimed: that turning sync off retroactively protects anything.
 * Captures taken while sync was on are still in the company vault and still
 * sync, and the title says so — a badge that implied otherwise would be a
 * privacy promise the code does not keep.
 *
 * FAILS CLOSED. The gate is `syncEnabled === false`, not `!syncEnabled`: a
 * truthy-but-malformed payload (an array, an error envelope, an older host
 * that never sent the field) leaves `syncEnabled` undefined, and `!undefined`
 * would render "not synced to your team" over captures that are, in fact,
 * being written to the vault and synced. Showing no badge when the posture is
 * unknown is the only safe direction — it understates, never overstates.
 */
export function localOnlyBadge(
  state: Pick<IdeasSettingsState, 'syncEnabled' | 'capturesRoot'> | null | undefined,
): LocalOnlyBadge | null {
  if (!state || typeof state !== 'object') return null;
  if (state.syncEnabled !== false) return null;
  const where = state.capturesRoot ? ` ${state.capturesRoot}` : ' a folder on this machine';
  return {
    label: 'local only',
    title:
      `New captures are saved to${where}, outside the company vault, and are not synced to your team.` +
      ' Captures taken before you turned sync off are still in the vault and still sync.',
  };
}
