/**
 * Parses one hq-pro `GET /v1/files/list` page. Lives outside atlas/ so pages
 * that only need the listing (Vault What's new) do not pull the Atlas chunk
 * into the initial bundle.
 */

export type AtlasListedObject = { key: string; lastModified?: string | null; size?: number };

/** One page of `GET /v1/files/list`. */
export type AtlasListPage = { objects: AtlasListedObject[]; cursor: string | null };

/** Parse one `/v1/files/list` body. Throws on a shape the builder cannot use. */
export function parseListPage(raw: unknown): AtlasListPage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("vault listing did not parse");
  }
  const row = raw as Record<string, unknown>;
  if (!Array.isArray(row.objects)) throw new Error("vault listing did not parse");
  const objects: AtlasListedObject[] = [];
  for (const item of row.objects) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.key !== "string" || !o.key) continue;
    objects.push({
      key: o.key,
      lastModified: typeof o.lastModified === "string" ? o.lastModified : null,
      size: typeof o.size === "number" ? o.size : undefined,
    });
  }
  const cursor = typeof row.cursor === "string" && row.cursor ? row.cursor : null;
  return { objects, cursor };
}
