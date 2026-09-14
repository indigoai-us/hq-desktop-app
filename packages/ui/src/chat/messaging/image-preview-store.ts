/** Disposable, account-scoped raster previews; no signed URLs or originals. */
export interface StoredImagePreview {
  key: string;
  account: string;
  blob: Blob;
  width: number;
  height: number;
  usedAt: number;
}
export interface ImagePreviewStore {
  get(key: string): Promise<StoredImagePreview | null>;
  put(value: StoredImagePreview): Promise<void>;
  delete(key: string): Promise<void>;
  clearAccount(account: string): Promise<void>;
}
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

/** Metadata is separate so eviction doesn't read all image bytes into memory. */
export function createImagePreviewStore(
  factory: IDBFactory | undefined = globalThis.indexedDB,
  budget = 256 * 1024 * 1024,
): ImagePreviewStore | undefined {
  if (!factory) return undefined;
  let opening: Promise<IDBDatabase> | undefined;
  function open(): Promise<IDBDatabase> {
    return opening ??= new Promise((resolve, reject) => {
      const request = factory!.open("hq-chat-image-previews-v1", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("images", { keyPath: "key" });
        request.result.createObjectStore("metadata", { keyPath: "key" });
      };
      request.onerror = () => { opening = undefined; reject(request.error); };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); opening = undefined; };
        resolve(request.result);
      };
    });
  }
  async function mutate(run: (tx: IDBTransaction) => void): Promise<void> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["images", "metadata"], "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("Image cache transaction aborted"));
      tx.onerror = () => reject(tx.error);
      run(tx);
    });
  }
  return {
    async get(key) {
      const db = await open();
      const value = await new Promise<StoredImagePreview | undefined>((resolve, reject) => {
        const request = db.transaction("images").objectStore("images").get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (!value) return null;
      if (Date.now() - value.usedAt > MAX_AGE) { await this.delete(key); return null; }
      await mutate((tx) => {
        tx.objectStore("metadata").put({ key, account: value.account, size: value.blob.size, usedAt: Date.now() });
      });
      return value;
    },
    put(value) {
      if (value.blob.size > budget) return Promise.resolve();
      return mutate((tx) => {
        const images = tx.objectStore("images");
        const metadata = tx.objectStore("metadata");
        images.put(value);
        metadata.put({ key: value.key, account: value.account, size: value.blob.size, usedAt: value.usedAt });
        const request = metadata.getAll();
        request.onsuccess = () => {
          const rows = request.result as Array<{ key: string; size: number; usedAt: number }>;
          let total = rows.reduce((sum, row) => sum + row.size, 0);
          for (const row of rows.sort((a, b) => a.usedAt - b.usedAt)) {
            if (total <= budget && Date.now() - row.usedAt <= MAX_AGE) continue;
            images.delete(row.key);
            metadata.delete(row.key);
            total -= row.size;
          }
        };
      });
    },
    delete(key) {
      return mutate((tx) => {
        tx.objectStore("images").delete(key);
        tx.objectStore("metadata").delete(key);
      });
    },
    clearAccount(account) {
      return mutate((tx) => {
        const request = tx.objectStore("metadata").openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          if (cursor.value.account === account) {
            tx.objectStore("images").delete(cursor.primaryKey);
            cursor.delete();
          }
          cursor.continue();
        };
      });
    },
  };
}
