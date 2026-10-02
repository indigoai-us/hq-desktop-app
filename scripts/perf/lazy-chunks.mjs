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
      atlasInitial: [],
      telemetryInitial: [],
      note: "no Vite manifest; treated as absent (chunks not built)",
    };
  }

  const byFile = new Map();
  for (const entry of Object.values(manifest)) {
    if (entry.file) byFile.set(entry.file, entry);
  }

  const entry = Object.values(manifest).find((item) => item.isEntry);
  const initial = new Set();
  const queue = [...(entry?.imports ?? []), entry?.file].filter(Boolean);
  while (queue.length) {
    const file = queue.pop();
    if (initial.has(file)) continue;
    initial.add(file);
    const item = byFile.get(file);
    for (const next of item?.imports ?? []) queue.push(next);
  }

  const atlasInitial = [];
  const telemetryInitial = [];
  let atlasBytes = 0;
  let telemetryBytes = 0;

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

  return {
    manifest: true,
    atlasInInitialJs: atlasInitial.length > 0,
    telemetryInInitialJs: telemetryInitial.length > 0,
    atlasBytes,
    telemetryBytes,
    atlasInitial,
    telemetryInitial,
  };
}
