#!/usr/bin/env node
/**
 * Shipped boot JS: builds apps/sync with its real vite.config.ts and reports
 * the JS each window loads before its first frame.
 *
 * - desktop window: the static import graph of `desktop-alt.html` plus the
 *   static graph of `HqWorkWorkShell.svelte`, which the desktop window
 *   `import()`s as soon as it boots.
 * - main window: the static import graph of `index.html`.
 *
 * Usage: `pnpm perf:boot-js` (writes the build to a temporary directory and
 * deletes it afterwards; `--out <dir>` keeps it, `--no-build <dir>` reads an
 * existing build). The Sentry upload plugin is inert without
 * SENTRY_AUTH_TOKEN, which this script clears for the build.
 */
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const syncRoot = resolve(rootDir, "apps/sync");

/**
 * Output files reached from `startKeys` through static imports. Manifest
 * `imports` are manifest keys, not file names.
 *
 * @param {Record<string, { file?: string, imports?: string[] }>} manifest
 * @param {string[]} startKeys
 * @returns {Set<string>}
 */
export function staticFiles(manifest, startKeys) {
  const files = new Set();
  const seen = new Set();
  const queue = [...startKeys];
  while (queue.length) {
    const key = queue.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    const item = manifest[key];
    if (!item) continue;
    if (item.file) files.add(item.file);
    for (const next of item.imports ?? []) queue.push(next);
  }
  return files;
}

/**
 * Manifest keys for the two windows' boot roots.
 *
 * @param {Record<string, unknown>} manifest
 */
export function bootRoots(manifest) {
  const shell = Object.keys(manifest).find((key) =>
    key.endsWith("src/desktop-alt/HqWorkWorkShell.svelte"),
  );
  return {
    desktop: ["desktop-alt.html", ...(shell ? [shell] : [])],
    main: ["index.html"],
  };
}

async function jsBytes(dir, files) {
  let total = 0;
  for (const file of files) {
    if (file.endsWith(".js")) total += (await stat(join(dir, file))).size;
  }
  return total;
}

async function build(outDir) {
  const require = createRequire(resolve(syncRoot, "package.json"));
  const { build: viteBuild } = await import(pathToFileURL(require.resolve("vite")).href);
  delete process.env.SENTRY_AUTH_TOKEN;
  await viteBuild({
    root: syncRoot,
    configFile: resolve(syncRoot, "vite.config.ts"),
    logLevel: "error",
    build: { outDir, emptyOutDir: true, manifest: true },
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const existing = argv.includes("--no-build") ? argv[argv.indexOf("--no-build") + 1] : null;
  const keep = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : null;
  const dir = existing ?? keep ?? (await mkdtemp(join(tmpdir(), "hq-boot-js-")));
  try {
    if (!existing) await build(dir);
    const manifest = JSON.parse(await readFile(join(dir, ".vite/manifest.json"), "utf8"));
    const roots = bootRoots(manifest);
    const desktop = await jsBytes(dir, staticFiles(manifest, roots.desktop));
    const main = await jsBytes(dir, staticFiles(manifest, roots.main));
    const dynamic = Object.values(manifest).filter((item) => item.isDynamicEntry).length;
    console.log(`desktop window boot JS: ${desktop} bytes`);
    console.log(`main window entry JS:   ${main} bytes`);
    console.log(`dynamic chunks:         ${dynamic}`);
  } finally {
    if (!existing && !keep) await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
