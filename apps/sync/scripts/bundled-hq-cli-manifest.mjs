#!/usr/bin/env node
// Manifest writer and checker for the bundled hq-cli payload.
//
// One arch directory (bundle/darwin-<arch>/) holds:
//   manifest.json      this file's output
//   package/           the hq-cli package root with its own node_modules
//   node/bin/node      the pinned Node runtime
//
// The manifest lists every regular file with its sha256 and executable bit,
// plus a tree digest over the sorted list. The app re-checks the same digest
// on first run (crates/hq-desktop-core/src/bundled_hq_cli.rs), so the two
// formulas must stay identical:
//   tree_sha256 = sha256( for each file sorted by path: path + "\0" + sha256 + "\n" )
//
// Usage:
//   bundled-hq-cli-manifest.mjs write   <dir> --version V --node-version V --arch A
//   bundled-hq-cli-manifest.mjs restamp <dir>     (recompute hashes, keep the version fields; run after codesign)
//   bundled-hq-cli-manifest.mjs verify  <dir> [--version V] [--node-version V] [--arch A]

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, posix } from "node:path";

export const MANIFEST_SCHEMA = "hq-bundled-cli.v1";
const MANIFEST_NAME = "manifest.json";
const ARCHES = new Set(["arm64", "x64"]);

function fail(message) {
  console.error(`[bundled-hq-cli-manifest] ${message}`);
  process.exit(1);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Walk the payload and return sorted regular files. Symlinks and special files
// fail the build: the app copies plain files only.
export function collectFiles(root) {
  const files = [];
  const walk = (rel) => {
    const abs = rel ? join(root, rel) : root;
    for (const name of readdirSync(abs).sort()) {
      const childRel = rel ? posix.join(rel, name) : name;
      if (!rel && name === MANIFEST_NAME) continue;
      const stat = lstatSync(join(root, childRel));
      if (stat.isSymbolicLink()) fail(`symlink is not allowed in the bundle: ${childRel}`);
      if (stat.isDirectory()) {
        walk(childRel);
      } else if (stat.isFile()) {
        files.push({
          path: childRel,
          sha256: sha256File(join(root, childRel)),
          executable: (stat.mode & 0o111) !== 0,
        });
      } else {
        fail(`unsupported file type in the bundle: ${childRel}`);
      }
    }
  };
  walk("");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

export function treeDigest(files) {
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.path}\0${file.sha256}\n`);
  return hash.digest("hex");
}

function readBins(root) {
  const pkgPath = join(root, "package", "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (error) {
    fail(`cannot read ${pkgPath}: ${error.message}`);
  }
  const bin = typeof pkg.bin === "string" ? { [pkg.name.split("/").pop()]: pkg.bin } : pkg.bin ?? {};
  const bins = {};
  for (const name of Object.keys(bin).sort()) {
    bins[name] = posix.normalize(bin[name]).replace(/^\.\//, "");
  }
  return { version: pkg.version, bins };
}

function buildManifest(root, { version, nodeVersion, arch }) {
  if (!ARCHES.has(arch)) fail(`unknown arch: ${arch}`);
  const pkg = readBins(root);
  if (pkg.version !== version) fail(`package.json version ${pkg.version} does not match the pin ${version}`);
  const files = collectFiles(root);
  for (const file of files) {
    if (file.path.split("/").includes("node-llama-cpp")) fail(`node-llama-cpp must not ship: ${file.path}`);
  }
  for (const [name, target] of Object.entries(pkg.bins)) {
    if (!files.some((file) => file.path === `package/${target}`)) fail(`bin ${name} target is missing: package/${target}`);
  }
  if (!files.some((file) => file.path === "node/bin/node" && file.executable)) fail("node/bin/node is missing or not executable");
  return {
    schema: MANIFEST_SCHEMA,
    version,
    node_version: nodeVersion,
    arch,
    bins: pkg.bins,
    tree_sha256: treeDigest(files),
    files,
  };
}

function writeManifest(root, manifest) {
  const target = join(root, MANIFEST_NAME);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, target);
}

function readManifest(root) {
  try {
    return JSON.parse(readFileSync(join(root, MANIFEST_NAME), "utf8"));
  } catch (error) {
    fail(`cannot read ${join(root, MANIFEST_NAME)}: ${error.message}`);
  }
}

function verify(root, expect) {
  const manifest = readManifest(root);
  if (manifest.schema !== MANIFEST_SCHEMA) fail(`unexpected schema ${manifest.schema}`);
  if (expect.version && manifest.version !== expect.version) fail(`manifest version ${manifest.version} does not match ${expect.version}`);
  if (expect.nodeVersion && manifest.node_version !== expect.nodeVersion) fail(`manifest node_version ${manifest.node_version} does not match ${expect.nodeVersion}`);
  if (expect.arch && manifest.arch !== expect.arch) fail(`manifest arch ${manifest.arch} does not match ${expect.arch}`);
  const actual = buildManifest(root, { version: manifest.version, nodeVersion: manifest.node_version, arch: manifest.arch });
  const listed = new Map(manifest.files.map((file) => [file.path, file]));
  for (const file of actual.files) {
    const entry = listed.get(file.path);
    if (!entry) fail(`file not listed in the manifest: ${file.path}`);
    if (entry.sha256 !== file.sha256) fail(`checksum mismatch: ${file.path}`);
    if (entry.executable !== file.executable) fail(`executable bit mismatch: ${file.path}`);
    listed.delete(file.path);
  }
  if (listed.size) fail(`listed file is missing: ${[...listed.keys()][0]}`);
  if (manifest.tree_sha256 !== actual.tree_sha256) fail("tree digest mismatch");
  console.log(`[bundled-hq-cli-manifest] ok ${manifest.arch} hq-cli ${manifest.version} node ${manifest.node_version} files=${actual.files.length} tree=${actual.tree_sha256}`);
}

function parseArgs(argv) {
  const [command, root, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (value === undefined) fail(`missing value for ${key}`);
    if (key === "--version") options.version = value;
    else if (key === "--node-version") options.nodeVersion = value;
    else if (key === "--arch") options.arch = value;
    else fail(`unknown option ${key}`);
  }
  if (!command || !root) fail("usage: bundled-hq-cli-manifest.mjs <write|restamp|verify> <dir> [options]");
  return { command, root, options };
}

const { command, root, options } = parseArgs(process.argv.slice(2));
if (command === "write") {
  if (!options.version || !options.nodeVersion || !options.arch) fail("write needs --version, --node-version and --arch");
  writeManifest(root, buildManifest(root, options));
  verify(root, options);
} else if (command === "restamp") {
  const current = readManifest(root);
  writeManifest(root, buildManifest(root, { version: current.version, nodeVersion: current.node_version, arch: current.arch }));
  verify(root, {});
} else if (command === "verify") {
  verify(root, options);
} else {
  fail(`unknown command ${command}`);
}
