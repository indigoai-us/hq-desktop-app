// @ts-check
/**
 * The `hq-shared` chunk for the apps/sync build.
 *
 * Two HTML entries (main + desktop-alt) share the Svelte runtime and the
 * @hq/* workspace UI. An explicit chunk keeps one copy of that code for both
 * windows.
 *
 * Only code on the boot path goes into it. A workspace module that is reached
 * only through a dynamic `import()` inside the workspace (the shell's lazy
 * doors, Atlas, telemetry, the rail hosts) stays in its own chunk and loads
 * when that surface opens. Before this rule every workspace module was forced
 * into `hq-shared`, so those `import()` calls split nothing in the shipped app:
 * the whole UI was downloaded and parsed at startup.
 *
 * The boot path is the static import graph from:
 * - every HTML entry, and
 * - every module that app code outside the workspace loads with `import()`
 *   (for example `HqWorkWorkShell.svelte`, which the desktop window imports
 *   as soon as it boots).
 *
 * Stylesheets stay in `hq-shared` wherever their component lives. CSS is not
 * parsed as JS, and some workspace stylesheets carry global rules that boot
 * surfaces have always picked up from the shared stylesheet. Keeping them
 * there keeps the shipped styles exactly as they were.
 *
 * scripts/perf/harness-build.mjs uses the same function, so the perf harness
 * measures the chunk layout the app ships.
 */

/** Modules that belong to the shared UI layer. */
const SHARED =
  /[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?svelte[\\/]|[\\/]node_modules[\\/]@hq[\\/](?:ui|core|platform|work)[\\/]|[\\/]packages[\\/](?:ui|core|platform|work)[\\/]|[\\/]apps[\\/]work[\\/]/;

/** Workspace code: its own `import()` calls are lazy boundaries. */
const WORKSPACE =
  /[\\/]node_modules[\\/]@hq[\\/]|[\\/]packages[\\/](?:ui|core|platform|work)[\\/]|[\\/]apps[\\/]work[\\/]/;

/** Stylesheets: plain .css imports and Svelte component style modules. */
const STYLE = /\.css(?:$|\?)|[?&]type=style\b/;

/** Atlas and telemetry stay in their dynamic-import chunks (US-012, US-032). */
const ALWAYS_LAZY = /[\\/]packages[\\/]ui[\\/]src[\\/](?:atlas|telemetry)[\\/]/;

/**
 * @typedef {{
 *   isEntry: boolean,
 *   importedIds: readonly string[],
 *   dynamicImporters: readonly string[],
 * }} ChunkModuleInfo
 * @typedef {{
 *   getModuleIds: () => Iterable<string>,
 *   getModuleInfo: (id: string) => ChunkModuleInfo | null,
 * }} ChunkMeta
 */

/**
 * Static import closure of the boot roots.
 * @param {ChunkMeta} meta
 * @returns {Set<string>}
 */
export function bootGraph({ getModuleIds, getModuleInfo }) {
  const queue = [];
  for (const id of getModuleIds()) {
    const info = getModuleInfo(id);
    if (!info) continue;
    const appLoadsIt = info.dynamicImporters.some((by) => !WORKSPACE.test(by));
    if (info.isEntry || appLoadsIt) queue.push(id);
  }
  const seen = new Set();
  while (queue.length) {
    const id = /** @type {string} */ (queue.pop());
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of getModuleInfo(id)?.importedIds ?? []) queue.push(next);
  }
  return seen;
}

/**
 * Returns a Rollup `manualChunks` function. The boot graph is computed once
 * per build. The cache is keyed on Rollup's module info objects, which Rollup
 * creates once per module per build, not on the identity of the
 * `getModuleInfo` function: a host that passes a new function on every call
 * still computes the graph once, and a new build (new module objects)
 * recomputes it.
 */
export function createHqSharedChunks() {
  /** @type {WeakMap<object, boolean>} */
  let onBootPath = new WeakMap();
  /**
   * @param {string} id
   * @param {ChunkMeta} meta
   * @returns {string | undefined}
   */
  return function manualChunks(id, meta) {
    if (!SHARED.test(id) || ALWAYS_LAZY.test(id)) return undefined;
    if (STYLE.test(id)) return "hq-shared";
    const info = meta.getModuleInfo(id);
    if (!info) return undefined;
    if (!onBootPath.has(info)) {
      const boot = bootGraph(meta);
      onBootPath = new WeakMap();
      for (const moduleId of meta.getModuleIds()) {
        const moduleInfo = meta.getModuleInfo(moduleId);
        if (moduleInfo) onBootPath.set(moduleInfo, boot.has(moduleId));
      }
    }
    return onBootPath.get(info) ? "hq-shared" : undefined;
  };
}
