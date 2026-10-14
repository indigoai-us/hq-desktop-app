/**
 * The only door into the Atlas chunk. Call when an Atlas route mounts; the
 * module promise is memoized so later mounts reuse the loaded chunk.
 */
type AtlasModule = typeof import("../atlas/index.js");

let pending: Promise<AtlasModule> | null = null;

export function loadAtlas(): Promise<AtlasModule> {
  pending ??= import("../atlas/index.js").catch((err) => {
    pending = null;
    throw err;
  });
  return pending;
}
