/**
 * Generated agent avatars.
 *
 * Agents without an assigned photo get a deterministic avatar from the
 * bundled set in `packages/ui/src/assets/agent-avatars/`. The set size is
 * discovered from the bundle at build time (Vite `import.meta.glob`), so
 * dropping more `agent-NN.png` files in widens the pool without code changes.
 *
 * Resolution order (applied inside IdentityMark):
 *   1. assigned photo (`avatarUrl` from the roster's avatarByUid map)
 *   2. generated avatar (`agentAvatarFor(agentUid)`)
 *   3. existing ✦ agent-glyph fallback
 */

// `import.meta.glob` is a Vite compile-time construct. It is typed by
// vite/client where those types are loaded (apps/sync); packages/ui's own
// tsconfig has `types: []`, so the call is ts-ignored rather than redeclared
// (a local ambient declaration would collide with vite/client downstream).
// Call it unconditionally: a `typeof import.meta.glob === "function"` guard
// survives Vite's rewrite (Vite only rewrites the *call*) and evaluates to
// false in the browser, so the production bundle would ship an empty set.
const modules: Record<string, unknown> =
  // @ts-ignore -- vite/client typing not loaded in @hq/ui's typecheck
  import.meta.glob("../../assets/agent-avatars/agent-*.{png,svg}", {
    eager: true,
    query: "?url",
    import: "default",
  });

/** Bundled generated-avatar URLs, sorted by filename for a stable order. */
export const agentAvatarAssets: string[] = Object.keys(modules)
  .sort()
  .map((key) => modules[key])
  .filter((url): url is string => typeof url === "string");

/** 32-bit FNV-1a — stable across sessions, machines, and JS engines. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministically pick a bundled generated avatar for an agent uid.
 * Returns null when the uid is blank or no assets are bundled (callers then
 * keep the existing glyph/initials fallback).
 */
export function agentAvatarFor(
  agentUid: string | null | undefined,
  assets: readonly string[] = agentAvatarAssets,
): string | null {
  const uid = (agentUid ?? "").trim();
  if (!uid || assets.length === 0) return null;
  return assets[fnv1a(uid) % assets.length] ?? null;
}
