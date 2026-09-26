#!/usr/bin/env node
// Computes the "shell cache key" for the prebuilt-native-shell release
// pipeline (see docs/RELEASE.md "Prebuilt shell"). The key must change
// exactly when a rebuild of the compiled Tauri shell is required, and must
// NOT change for anything that only affects the frontend bundle or the
// stamped app version — otherwise every release either misses the cache
// (slow) or reuses a stale shell for a Rust change (unsafe).
//
// Included, in this fixed order (sorted, so the key is host-independent):
//   - apps/sync/src-tauri/Cargo.lock
//   - every file under crates/**  and apps/sync/src-tauri/src/**
//   - apps/sync/src-tauri/build.rs and build_support/**
//   - apps/sync/src-tauri/tauri.conf.json, WITH the top-level "version"
//     field stripped before hashing
//   - apps/sync/src-tauri/capabilities/**
//   - apps/sync/src-tauri/icons/** (icon bytes are compiled into the binary)
//   - apps/sync/src-tauri/Cargo.toml (plugin/dependency set)
//   - the rustc toolchain version + target triple (passed in, not read from
//     disk, since the CI matrix picks these)
//
// Excluded on purpose: CHANGELOG.md, package.json version, anything under
// apps/sync/src/**, apps/sync/dist/**, apps/sync/public/** (frontend only).
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const SHELL_SOURCE_ROOTS = [
  "crates",
  "apps/sync/src-tauri/src",
  "apps/sync/src-tauri/build_support",
];

const SHELL_SOURCE_FILES = [
  "apps/sync/src-tauri/Cargo.lock",
  "apps/sync/src-tauri/Cargo.toml",
  "apps/sync/src-tauri/build.rs",
  // macOS bundle inputs: the platform config, the Info.plist template, the
  // entitlements, the tray helper source, and the Recall sidecar files the
  // bundle copies into Resources (its node_modules come from the lockfile).
  "apps/sync/src-tauri/tauri.macos.conf.json",
  "apps/sync/src-tauri/Info.plist",
  "apps/sync/src-tauri/Entitlements.plist",
  "apps/sync/src-tauri/helper/hq-tray-helper.swift",
  "apps/sync/sidecar/recall-sdk-bridge/bridge.mjs",
  "apps/sync/sidecar/recall-sdk-bridge/recording-tracker.mjs",
  "apps/sync/sidecar/recall-sdk-bridge/package.json",
  "apps/sync/sidecar/recall-sdk-bridge/pnpm-lock.yaml",
];

// The app package's own version is stamped from the release tag into
// Cargo.toml and Cargo.lock on every release. The shell reads its version at
// runtime (version.json / Info.plist), so that field must not change the key.
const APP_PACKAGE = "hq-sync-menubar";

/** Blank the app package's own `version = "..."` line in Cargo.toml text. */
export function normalizeCargoToml(text) {
  return text.replace(
    /(\[package\][^[]*?\n)version\s*=\s*"[^"]*"/,
    '$1version = ""',
  );
}

/** Blank the app package's version in Cargo.lock text. */
export function normalizeCargoLock(text) {
  return text.replace(
    new RegExp(`(name = "${APP_PACKAGE}"\\r?\\n)version = "[^"]*"`),
    '$1version = ""',
  );
}

const SHELL_SOURCE_DIRS_SINGLE = [
  "apps/sync/src-tauri/capabilities",
  "apps/sync/src-tauri/icons",
];

/** Strip the top-level "version" field from tauri.conf.json before hashing
 * (JSON.stringify with sorted keys, not the raw text, so formatting-only
 * diffs never change the key). */
export function normalizeTauriConf(jsonText) {
  const parsed = JSON.parse(jsonText);
  delete parsed.version;
  return JSON.stringify(sortKeysDeep(parsed));
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep(value[key])]),
    );
  }
  return value;
}

async function walk(root, dir, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "target" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, out);
    } else if (entry.isFile()) {
      out.push(relative(root, full).split(sep).join("/"));
    }
  }
}

export async function collectShellFiles(root) {
  const files = new Set();
  for (const rel of SHELL_SOURCE_FILES) {
    files.add(rel);
  }
  for (const rel of SHELL_SOURCE_ROOTS) {
    try {
      const abs = join(root, rel);
      await stat(abs);
      const acc = [];
      await walk(root, abs, acc);
      for (const f of acc) files.add(f);
    } catch {
      // root not present (e.g. partial checkout in a unit test) — skip
    }
  }
  for (const rel of SHELL_SOURCE_DIRS_SINGLE) {
    try {
      const abs = join(root, rel);
      await stat(abs);
      const acc = [];
      await walk(root, abs, acc);
      for (const f of acc) files.add(f);
    } catch {
      // optional
    }
  }
  return [...files].sort();
}

/** Hash text files with LF line endings. `* text=auto` in .gitattributes
 * checks text files out with CRLF on Windows runners (only some extensions
 * are pinned to eol=lf), so without this the same commit hashed to a
 * different key on Windows than on Linux, and publish's recompute of the
 * Windows keys could never match. A file is treated as binary, and hashed
 * byte for byte, if its first 8000 bytes contain a NUL (git's heuristic). */
export function normalizeLineEndings(contents) {
  if (typeof contents === "string") return contents.replace(/\r\n/g, "\n");
  if (contents.subarray(0, 8000).includes(0)) return contents;
  if (!contents.includes(13)) return contents;
  return Buffer.from(contents.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
}

export async function computeShellHash(root, { rustToolchain, targetTriple } = {}) {
  const files = await collectShellFiles(root);
  const hash = createHash("sha256");
  hash.update(`toolchain=${rustToolchain ?? ""}\n`);
  hash.update(`target=${targetTriple ?? ""}\n`);
  for (const rel of files) {
    const abs = join(root, rel);
    let contents;
    try {
      if (rel === "apps/sync/src-tauri/tauri.conf.json") {
        contents = normalizeTauriConf(await readFile(abs, "utf8"));
      } else if (rel === "apps/sync/src-tauri/Cargo.toml") {
        contents = normalizeCargoToml(await readFile(abs, "utf8"));
      } else if (rel === "apps/sync/src-tauri/Cargo.lock") {
        contents = normalizeCargoLock(await readFile(abs, "utf8"));
      } else {
        contents = await readFile(abs);
      }
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
      // Optional single file absent (e.g. a unit-test fixture). Hash the
      // absence so adding the file later changes the key.
      contents = "<absent>";
    }
    contents = normalizeLineEndings(contents);
    hash.update(`\0path=${rel}\0len=${contents.length}\0`);
    hash.update(contents);
  }
  // tauri.conf.json itself is not in SHELL_SOURCE_ROOTS/FILES above — add it
  // explicitly, normalized, so a version-only edit never changes the hash.
  try {
    const confPath = join(root, "apps/sync/src-tauri/tauri.conf.json");
    const normalized = normalizeLineEndings(normalizeTauriConf(await readFile(confPath, "utf8")));
    hash.update(`\0path=apps/sync/src-tauri/tauri.conf.json\0`);
    hash.update(normalized);
  } catch {
    // absent in unit-test fixtures without a conf file
  }
  return hash.digest("hex");
}

export async function main(argv) {
  const args = parseArgs(argv);
  const digest = await computeShellHash(args.root, {
    rustToolchain: args.toolchain,
    targetTriple: args.target,
  });
  console.log(digest);
  return 0;
}

function parseArgs(argv) {
  const out = { root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") out.root = argv[++i];
    else if (a === "--toolchain") out.toolchain = argv[++i];
    else if (a === "--target") out.target = argv[++i];
  }
  return out;
}

// process.argv[1] is a raw OS path (backslashes on Windows); import.meta.url
// is always a file:// URL. Comparing them directly never matches on Windows,
// so this entry point silently never ran there — main() exited 0 with no
// output, and the caller's own `KEY` regex check is what actually caught it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
