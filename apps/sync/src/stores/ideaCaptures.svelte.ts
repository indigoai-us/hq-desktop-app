/**
 * Idea Board capture store (US-009).
 *
 * Owns the board's data lifecycle: the list load, live upserts from the capture
 * pipeline's Tauri events, the low-confidence kind/status write, and the
 * authorized thumbnail fetch (packaged builds refuse `file://`, so a thumbnail
 * has to come back through the native preview command as a data URL).
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { safeUnlisten } from '../lib/listener-registry';
import { safeLocalImageSrc } from '../desktop-alt/lib/local-image-src';

export type IdeaKind = 'unknown' | 'x_post' | 'article' | 'image' | 'quote' | 'product' | 'color';
export type IdeaStatus = 'pending' | 'extracted' | 'low_confidence' | 'plain';

export interface IdeaProvenance {
  app: string;
  window_title: string;
  url: string | null;
  captured_at: string;
  display_id: number;
}

/** Mirrors the Rust `CaptureRecord` (serde snake_case). */
export interface IdeaCapture {
  id: string;
  company_slug: string;
  kind: IdeaKind;
  status: IdeaStatus;
  confidence: number | null;
  image_path: string;
  ocr_text: string | null;
  extracted: Record<string, unknown> | null;
  tags: string[];
  extraction_source?: 'local' | 'model' | 'user';
  provenance: IdeaProvenance;
  note: string | null;
  cited_count: number;
  created_at: string;
  updated_at: string;
}

export type IdeaBoardState = 'idle' | 'loading' | 'ready' | 'error';

/** Newest first; ULID ids break `created_at` ties in creation order. */
function byNewest(a: IdeaCapture, b: IdeaCapture): number {
  if (a.created_at === b.created_at) return b.id.localeCompare(a.id);
  return a.created_at < b.created_at ? 1 : -1;
}

function isCapture(value: unknown): value is IdeaCapture {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}

class IdeaCapturesStore {
  /** Board records, newest first. */
  records = $state<IdeaCapture[]>([]);
  state = $state<IdeaBoardState>('idle');
  error = $state<string | null>(null);
  /** Last detail-pane write failure. Separate from `error`, which blanks the board. */
  writeError = $state<string | null>(null);
  /** id -> data URL; `null` means "fetched and unusable", so we never refetch. */
  thumbnails = $state<Record<string, string | null>>({});

  private inFlightThumbnails = new Set<string>();
  private unlisteners: UnlistenFn[] = [];

  async load(): Promise<void> {
    this.state = 'loading';
    this.error = null;
    try {
      const result = await invoke('ideas_list_captures');
      // The adapter boundary is the only place that trusts the shape.
      const rows = Array.isArray(result) ? (result as IdeaCapture[]).filter(isCapture) : [];
      this.records = [...rows].sort(byNewest);
      this.state = 'ready';
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.state = 'error';
    }
  }

  /** Insert or replace one record, keeping newest-first order. */
  upsert(record: IdeaCapture): void {
    if (!isCapture(record)) return;
    const next = this.records.filter((row) => row.id !== record.id);
    next.push(record);
    this.records = next.sort(byNewest);
  }

  /** Drop a record that was moved or deleted. */
  remove(id: string): void {
    this.records = this.records.filter((row) => row.id !== id);
    if (this.thumbnails[id] !== undefined) {
      const next = { ...this.thumbnails };
      delete next[id];
      this.thumbnails = next;
    }
  }

  /** Subscribe to the capture pipeline's live record events. */
  async subscribeToUpdates(): Promise<void> {
    const handle = (event: { payload: unknown }) => {
      if (isCapture(event.payload)) this.upsert(event.payload);
    };
    const completed = await listen('capture:completed', handle);
    const updated = await listen('capture:updated', handle);
    const removed = await listen('capture:removed', (event: { payload: unknown }) => {
      const payload = event.payload as { id?: unknown } | null;
      if (payload && typeof payload.id === 'string') this.remove(payload.id);
    });
    this.unlisteners.push(completed, updated, removed);
  }

  unsubscribe(): void {
    // `safeUnlisten` is the repo's throw-safe, idempotent teardown boundary —
    // Tauri's own unlisten throws on a stale handle.
    for (const off of this.unlisteners) safeUnlisten(off)();
    this.unlisteners = [];
  }

  /** Persist the user's verdict on a low-confidence capture. */
  async setKind(id: string, kind: IdeaKind, status: IdeaStatus): Promise<void> {
    const updated = await invoke('ideas_set_kind', { id, kind, status });
    if (isCapture(updated)) this.upsert(updated);
  }

  /**
   * Run a detail-pane write, recording any failure on `writeError` instead of
   * letting it become an unhandled rejection. Returns whether it succeeded, so
   * a destructive caller can avoid acting as if the record were gone.
   */
  private async write(run: () => Promise<void>): Promise<boolean> {
    this.writeError = null;
    try {
      await run();
      return true;
    } catch (err) {
      this.writeError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /** Authoritative kind correction from the card detail (confidence 1.0, source user). */
  async correctKind(id: string, kind: IdeaKind): Promise<boolean> {
    return this.write(async () => {
      const updated = await invoke('ideas_correct_kind', { id, kind });
      if (isCapture(updated)) this.upsert(updated);
    });
  }

  async setNote(id: string, note: string): Promise<boolean> {
    return this.write(async () => {
      const updated = await invoke('ideas_set_note', { id, note });
      if (isCapture(updated)) this.upsert(updated);
    });
  }

  async setTags(id: string, tags: string[]): Promise<boolean> {
    return this.write(async () => {
      const updated = await invoke('ideas_set_tags', { id, tags });
      if (isCapture(updated)) this.upsert(updated);
    });
  }

  async moveCapture(id: string, toCompany: string): Promise<boolean> {
    return this.write(async () => {
      await invoke('ideas_move_capture', { id, toCompany });
      this.remove(id);
    });
  }

  async deleteCapture(id: string): Promise<boolean> {
    return this.write(async () => {
      await invoke('ideas_delete_capture', { id });
      this.remove(id);
    });
  }

  async listCompanies(): Promise<string[]> {
    try {
      const result = await invoke('ideas_list_companies');
      return Array.isArray(result) ? result.filter((s): s is string => typeof s === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * Fetch (once) the authorized data-URL thumbnail for a record. Failures are
   * cached as `null`: the card already has a typed fallback, and retrying a
   * missing file on every re-render would be a loop.
   */
  async thumbnail(record: IdeaCapture): Promise<string | null> {
    const cached = this.thumbnails[record.id];
    if (cached !== undefined) return cached;
    if (this.inFlightThumbnails.has(record.id)) return null;
    this.inFlightThumbnails.add(record.id);
    try {
      const preview = (await invoke('get_authorized_file_preview', {
        path: record.image_path,
      })) as { mimeType?: string; dataBase64?: string } | null;
      const mime = preview?.mimeType ?? '';
      const data = preview?.dataBase64 ?? '';
      const src = mime && data ? safeLocalImageSrc(`data:${mime};base64,${data}`) : null;
      this.thumbnails = { ...this.thumbnails, [record.id]: src };
      return src;
    } catch {
      this.thumbnails = { ...this.thumbnails, [record.id]: null };
      return null;
    } finally {
      this.inFlightThumbnails.delete(record.id);
    }
  }

  /** Test-only reset. */
  _reset(): void {
    this.records = [];
    this.state = 'idle';
    this.error = null;
    this.thumbnails = {};
    this.inFlightThumbnails.clear();
    this.unsubscribe();
  }
}

export function createIdeaCapturesStore(): IdeaCapturesStore {
  return new IdeaCapturesStore();
}

export type { IdeaCapturesStore };

/** Shared board store. */
export const ideaCaptures = createIdeaCapturesStore();
