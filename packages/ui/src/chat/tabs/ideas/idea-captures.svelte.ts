/**
 * Idea Board capture store for the shell's Ideas tab.
 *
 * Owns the board's data lifecycle: the list load, the low-confidence verdict,
 * the detail-pane writes, and the authorized thumbnail fetch (packaged builds
 * refuse `file://`, so a thumbnail has to come back through the host as a data
 * URL).
 *
 * Every backend touch goes through the injected `PlatformAdapter` — this file
 * is the board's ONLY seam, and `packages/ui` never imports `@tauri-apps/api`.
 */

import type {
  IdeaBoardSettings,
  IdeaCapture,
  IdeaKind,
  IdeaStatus,
  PlatformAdapter,
} from "@hq/platform";
import { safeLocalImageSrc } from "../../../common/local-image-src.js";

export type IdeaBoardState = "idle" | "loading" | "ready" | "error";

/** Newest first; ULID ids break `created_at` ties in creation order. */
function byNewest(a: IdeaCapture, b: IdeaCapture): number {
  if (a.created_at === b.created_at) return b.id.localeCompare(a.id);
  return a.created_at < b.created_at ? 1 : -1;
}

function isCapture(value: unknown): value is IdeaCapture {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

/** Human text for a failed adapter call, never an empty string. */
function reasonText(
  result: { ok: false; code?: string; message?: string },
  fallback: string,
): string {
  return result.message?.trim() || result.code?.trim() || fallback;
}

export class IdeaCapturesStore {
  /** Board records, newest first. */
  records = $state<IdeaCapture[]>([]);
  state = $state<IdeaBoardState>("idle");
  error = $state<string | null>(null);
  /** Last detail-pane write failure. Separate from `error`, which blanks the board. */
  writeError = $state<string | null>(null);
  /** id -> data URL; `null` means "fetched and unusable", so we never refetch. */
  thumbnails = $state<Record<string, string | null>>({});
  /** Board-relevant settings, or null while unknown (drives the badge). */
  settings = $state<IdeaBoardSettings | null>(null);
  /** Company slugs a capture can be moved to. */
  companies = $state<string[]>([]);

  private readonly ideas: PlatformAdapter["ideas"];
  private readonly inFlightThumbnails = new Set<string>();

  constructor(adapter: PlatformAdapter) {
    this.ideas = adapter.ideas;
  }

  async load(): Promise<void> {
    this.state = "loading";
    this.error = null;
    const result = await this.ideas.listCaptures();
    if (!result.ok) {
      this.error = reasonText(result, "Could not read your captures.");
      this.state = "error";
      return;
    }
    // The adapter boundary is the only place that trusts the shape.
    const rows = Array.isArray(result.value)
      ? (result.value as IdeaCapture[]).filter(isCapture)
      : [];
    this.records = [...rows].sort(byNewest);
    this.state = "ready";
  }

  /**
   * Side data the board header and detail pane need. Deliberately separate
   * from `load`: a failed settings read must not blank the grid, it just
   * leaves the posture unknown (and the badge unrendered — see `localOnlyBadge`).
   */
  async loadSideData(): Promise<void> {
    const [settings, companies] = await Promise.all([
      this.ideas.getSettings(),
      this.ideas.listCompanies(),
    ]);
    this.settings = settings.ok ? (settings.value ?? null) : null;
    this.companies =
      companies.ok && Array.isArray(companies.value)
        ? companies.value.filter((s): s is string => typeof s === "string")
        : [];
  }

  /** Insert or replace one record, keeping newest-first order. */
  upsert(record: unknown): void {
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

  /**
   * Run a write, recording any failure on `writeError` rather than throwing.
   * Returns whether it succeeded, so a destructive caller can avoid acting as
   * if the record were gone.
   */
  private async write(
    run: () => Promise<{ ok: boolean; code?: string; message?: string }>,
    fallback: string,
  ): Promise<boolean> {
    this.writeError = null;
    const result = await run();
    if (!result.ok) {
      this.writeError = reasonText(
        result as { ok: false; code?: string; message?: string },
        fallback,
      );
      return false;
    }
    return true;
  }

  /** Persist the user's verdict on a low-confidence capture. */
  async setKind(id: string, kind: IdeaKind, status: IdeaStatus): Promise<boolean> {
    return this.write(async () => {
      const result = await this.ideas.setKind(id, kind, status);
      if (result.ok) this.upsert(result.value);
      return result;
    }, "That verdict didn't save.");
  }

  /** Authoritative kind correction from the detail pane. */
  async correctKind(id: string, kind: IdeaKind): Promise<boolean> {
    return this.write(async () => {
      const result = await this.ideas.correctKind(id, kind);
      if (result.ok) this.upsert(result.value);
      return result;
    }, "That correction didn't save.");
  }

  async setNote(id: string, note: string): Promise<boolean> {
    return this.write(async () => {
      const result = await this.ideas.setNote(id, note);
      if (result.ok) this.upsert(result.value);
      return result;
    }, "That note didn't save.");
  }

  async setTags(id: string, tags: string[]): Promise<boolean> {
    return this.write(async () => {
      const result = await this.ideas.setTags(id, tags);
      if (result.ok) this.upsert(result.value);
      return result;
    }, "Those tags didn't save.");
  }

  async moveCapture(id: string, toCompany: string): Promise<boolean> {
    return this.write(async () => {
      const result = await this.ideas.moveCapture(id, toCompany);
      if (result.ok) this.remove(id);
      return result;
    }, "That capture didn't move.");
  }

  async deleteCapture(id: string): Promise<boolean> {
    return this.write(async () => {
      const result = await this.ideas.deleteCapture(id);
      if (result.ok) this.remove(id);
      return result;
    }, "That capture wasn't deleted.");
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
      const result = await this.ideas.filePreview(record.image_path);
      const preview = result.ok ? result.value : null;
      const mime = preview?.mimeType ?? "";
      const data = preview?.dataBase64 ?? "";
      const src =
        mime && data
          ? safeLocalImageSrc(`data:${mime};base64,${data}`)
          : null;
      this.thumbnails = { ...this.thumbnails, [record.id]: src };
      return src;
    } finally {
      this.inFlightThumbnails.delete(record.id);
    }
  }
}

export function createIdeaCapturesStore(
  adapter: PlatformAdapter,
): IdeaCapturesStore {
  return new IdeaCapturesStore(adapter);
}
