import type { ImagePreviewStore, StoredImagePreview } from "./image-preview-store";
export interface ImagePreview { url: string; width: number; height: number }
export interface ImagePreviewLease extends ImagePreview { release(): void }
type Prepared = { blob: Blob; width: number; height: number };
type Entry = ImagePreview & { cost: number; refs: number };

/** Keep a 2x raster thumbnail; clicking a preview still loads the original. */
export async function prepareImagePreview(blob: Blob): Promise<Prepared> {
  if (blob.size > 25 * 1024 * 1024) throw new Error("Image exceeds preview size limit");
  // Do not let SVG introduce external resources into cached previews.
  if (!/^image\/(png|jpeg|jpg|gif|webp|avif)$/i.test(blob.type)) throw new Error("Unsupported image preview type");
  const source = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) {
      throw new Error("Image exceeds preview pixel limit");
    }
    const scale = Math.min(1, 640 / image.naturalWidth, 440 / image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image preview canvas unavailable");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const thumbnail = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Image preview encoding failed")), "image/png");
    });
    return { blob: thumbnail, width: canvas.width, height: canvas.height };
  } finally { URL.revokeObjectURL(source); }
}

/** One shell/account owns previews; message components only borrow them. */
export class ImagePreviewCache {
  private static nextInstance = 0;
  readonly instanceId = ++ImagePreviewCache.nextInstance;
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<Entry>>();
  private disposed = false;
  private running = 0;
  private queue: Array<() => void> = [];
  private writes = new Set<Promise<void>>();
  constructor(private options: {
    account: string;
    load: (scope: string, path: string) => Promise<Blob>;
    store?: ImagePreviewStore;
    prepare?: (blob: Blob) => Promise<Prepared>;
    memoryBudget?: number;
    createUrl?: (blob: Blob) => string;
    revokeUrl?: (url: string) => void;
  }) {}
  private key(scope: string, path: string): string {
    // Chat upload paths contain a fresh attachment ID, not a reusable filename.
    return JSON.stringify([this.options.account, scope, path, "raster-640-v1"]);
  }
  private revoke(url: string): void { (this.options.revokeUrl ?? URL.revokeObjectURL)(url); }
  peek(scope: string, path: string): ImagePreview | null {
    return this.disposed ? null : this.entries.get(this.key(scope, path)) ?? null;
  }
  private trim(): void {
    let total = [...this.entries.values()].reduce((sum, entry) => sum + entry.cost, 0);
    for (const [key, entry] of this.entries) {
      if (total <= (this.options.memoryBudget ?? 64 * 1024 * 1024)) break;
      if (entry.refs) continue;
      this.entries.delete(key);
      this.revoke(entry.url);
      total -= entry.cost;
    }
  }
  private async limited<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= 2) await new Promise<void>((resolve) => this.queue.push(resolve));
    else this.running++;
    try {
      if (this.disposed) throw new Error("Image cache closed");
      return await work();
    } finally {
      const next = this.queue.shift();
      if (next) next(); else this.running--;
    }
  }
  private async load(scope: string, path: string, key: string, seed?: Blob): Promise<Entry> {
    return this.limited(async () => {
      const store = this.options.store;
      let saved: StoredImagePreview | null = null;
      try { saved = await store?.get(key) ?? null; }
      catch (error) { console.warn("[image-preview] Local cache read failed", error); }
      let preview: Prepared | undefined;
      if (saved?.account === this.options.account && saved.blob instanceof Blob &&
          saved.blob.type === "image/png" && saved.width > 0 && saved.height > 0 &&
          saved.width <= 640 && saved.height <= 440) preview = saved;
      if (!preview) {
        const blob = seed ?? await this.options.load(scope, path);
        if (this.disposed) throw new Error("Image cache closed");
        preview = await (this.options.prepare ?? prepareImagePreview)(blob);
        if (this.disposed) throw new Error("Image cache closed");
        if (store) {
          const write = store.put({ ...preview, key, account: this.options.account, usedAt: Date.now() })
            .catch((error) => { console.warn("[image-preview] Local cache write failed", error); });
          this.writes.add(write);
          void write.finally(() => this.writes.delete(write));
        }
      }
      if (this.disposed) throw new Error("Image cache closed");
      const url = (this.options.createUrl ?? URL.createObjectURL)(preview.blob);
      const entry = { url, width: preview.width, height: preview.height, cost: preview.blob.size + preview.width * preview.height * 4, refs: 0 };
      this.entries.set(key, entry);
      return entry;
    });
  }
  async acquire(scope: string, path: string, seed?: Blob): Promise<ImagePreviewLease> {
    if (this.disposed || !scope || !path) throw new Error("Image preview scope unavailable");
    const key = this.key(scope, path);
    let entry = this.entries.get(key);
    if (!entry) {
      let work = this.pending.get(key);
      if (!work) { work = this.load(scope, path, key, seed); this.pending.set(key, work); }
      try { entry = await work; }
      finally { if (this.pending.get(key) === work) this.pending.delete(key); }
    }
    if (this.disposed) throw new Error("Image cache closed");
    entry.refs++;
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.trim();
    let released = false;
    return { url: entry.url, width: entry.width, height: entry.height, release: () => {
      if (released) return;
      released = true;
      entry.refs--;
      this.trim();
    } };
  }
  async warm(scope: string, path: string, seed?: Blob): Promise<void> {
    const lease = await this.acquire(scope, path, seed);
    lease.release();
  }
  async invalidate(scope: string, path: string): Promise<void> {
    const key = this.key(scope, path);
    const entry = this.entries.get(key);
    if (entry) { this.entries.delete(key); this.revoke(entry.url); }
    await this.options.store?.delete(key);
  }
  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) this.revoke(entry.url);
    this.entries.clear();
  }
  async clearAccount(): Promise<void> {
    this.dispose();
    await Promise.allSettled([...this.pending.values(), ...this.writes]);
    await this.options.store?.clearAccount(this.options.account);
  }
}
