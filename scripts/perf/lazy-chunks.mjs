/**
 * Read Vite's build manifest and decide whether Atlas / telemetry landed in
 * the initial JS graph. The manifest is JSON next to the build, not part of
 * the shipped shell.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const ATLAS = /(?:^|\/)atlas(?:\/|$)|\.atlas\b|src\/atlas\//;
const TELEMETRY = /(?:^|\/)telemetry(?:\/|$)|\.telemetry\b|src\/telemetry\//;

function matches(entry, pattern) {
  const src = `${entry.src ?? ""} ${entry.file ?? ""}`;
  return pattern.test(src);
}

/**
 * Output files the entry loads before anything else: the entry chunk and
 * everything it imports statically. A manifest's `imports` lists manifest
 * KEYS, not output files. For a source module the key is its path; for a
 * chunk with no source module (such as the shared "hq-shared" chunk) the key
 * is `_<name>-<hash>.js` while the file is `assets/<name>-<hash>.js`.
 * Walking keys counts those shared chunks, which a file-name walk misses.
 *
 * @param {Record<string, { file?: string, isEntry?: boolean, imports?: string[] }>} manifest
 * @returns {Set<string>}
 */
export function initialFiles(manifest) {
  const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry);
  const files = new Set();
  const seen = new Set();
  const queue = entryKey ? [entryKey] : [];
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

export async function inspectLazyChunks(buildDir) {
  const manifestPath = join(buildDir, ".vite/manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return {
      manifest: false,
      atlasInInitialJs: false,
      telemetryInInitialJs: false,
      atlasBytes: 0,
      telemetryBytes: 0,
      initialJsBytes: null,
      atlasInitial: [],
      telemetryInitial: [],
      note: "no Vite manifest; treated as absent (chunks not built)",
    };
  }

  const initial = initialFiles(manifest);

  const atlasInitial = [];
  const telemetryInitial = [];
  let atlasBytes = 0;
  let telemetryBytes = 0;
  let initialJsBytes = 0;

  for (const item of Object.values(manifest)) {
    if (!item.file) continue;
    const filePath = join(buildDir, item.file);
    let bytes = 0;
    try {
      bytes = (await stat(filePath)).size;
    } catch {
      bytes = 0;
    }
    const inInitial = initial.has(item.file);
    if (matches(item, ATLAS)) {
      atlasBytes += bytes;
      if (inInitial) atlasInitial.push(item.src ?? item.file);
    }
    if (matches(item, TELEMETRY)) {
      telemetryBytes += bytes;
      if (inInitial) telemetryInitial.push(item.src ?? item.file);
    }
  }

  for (const file of initial) {
    if (!file.endsWith(".js")) continue;
    try {
      initialJsBytes += (await stat(join(buildDir, file))).size;
    } catch {
      // A listed file that is missing on disk counts as zero bytes.
    }
  }

  return {
    manifest: true,
    atlasInInitialJs: atlasInitial.length > 0,
    telemetryInInitialJs: telemetryInitial.length > 0,
    atlasBytes,
    telemetryBytes,
    initialJsBytes,
    atlasInitial,
    telemetryInitial,
  };
}
