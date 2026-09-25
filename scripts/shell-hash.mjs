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

const SHELL_SOURCE_ROOTS = [
  "crates",
  "apps/sync/src-tauri/src",
  "apps/sync/src-tauri/build_support",
];

const SHELL_SOURCE_FILES = [
  "apps/sync/src-tauri/Cargo.lock",
  "apps/sync/src-tauri/Cargo.toml",
  "apps/sync/src-tauri/build.rs",
];

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

export async function computeShellHash(root, { rustToolchain, targetTriple } = {}) {
  const files = await collectShellFiles(root);
  const hash = createHash("sha256");
  hash.update(`toolchain=${rustToolchain ?? ""}\n`);
  hash.update(`target=${targetTriple ?? ""}\n`);
  for (const rel of files) {
    const abs = join(root, rel);
    let contents;
    if (rel === "apps/sync/src-tauri/tauri.conf.json") {
      contents = normalizeTauriConf(await readFile(abs, "utf8"));
    } else {
      contents = await readFile(abs);
    }
    hash.update(`\0path=${rel}\0len=${contents.length}\0`);
    hash.update(contents);
  }
  // tauri.conf.json itself is not in SHELL_SOURCE_ROOTS/FILES above — add it
  // explicitly, normalized, so a version-only edit never changes the hash.
  try {
    const confPath = join(root, "apps/sync/src-tauri/tauri.conf.json");
    const normalized = normalizeTauriConf(await readFile(confPath, "utf8"));
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
