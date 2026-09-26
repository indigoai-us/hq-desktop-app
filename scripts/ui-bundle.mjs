#!/usr/bin/env node
// UI hot-update bundles (see docs/RELEASE.md "UI hot updates" and
// crates/hq-desktop-core/src/ui_hot.rs, which verifies what this produces).
//
// A bundle is a tar.gz containing:
//   hq-ui-manifest.json   {uiVersion, shellKeys[], createdAt, minAppVersion?}
//   dist/...              the built frontend (index.html at dist/index.html)
// The archive is signed with the Tauri updater's minisign key (`tauri signer
// sign`), so the signature covers the inner manifest and its shell keys.
//
// Next to the archive this script writes `ui-manifest.json` (the inner
// manifest plus the archive's sha256), and `pointer` turns that plus the .sig
// into `ui-latest-<channel>.json`, the file installed apps poll.
//
// Usage:
//   node scripts/ui-bundle.mjs version --app-version 0.10.330 --sha abc1234 [--now ISO]
//   node scripts/ui-bundle.mjs pack --dist apps/sync/dist --ui-version V \
//        --shell-key K [--shell-key K2 ...] [--min-app-version V] --out DIR
//   node scripts/ui-bundle.mjs pointer --manifest DIR/ui-manifest.json \
//        --sig DIR/ui-V.tar.gz.sig --url https://... --channel beta --out FILE
//   node scripts/ui-bundle.mjs select-base --releases releases.json --channel beta
//        (releases.json = `gh api repos/O/R/releases`; prints the tag whose
//        shell the ui-only bundle targets)
//   node scripts/ui-bundle.mjs keys --manifest ui-manifest.json [--extra k1,k2]
//        (prints the shell keys, one per line)
//   node scripts/ui-bundle.mjs prune-plan --assets assets.json --keep 10
//        (prints ui-updates archive asset names older than the newest N)
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CHANNELS = ["beta", "stable"];

/** `0.10.330+ui.20260926T101500Z.abc1234` — base version, then build stamp. */
export function uiVersionFor(appVersion, sha, now = new Date()) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(appVersion)) {
    throw new Error(`ui-bundle: app version "${appVersion}" is not SemVer`);
  }
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const short = String(sha || "local").replace(/[^0-9A-Za-z]/g, "").slice(0, 7) || "local";
  return `${appVersion}+ui.${stamp}.${short}`;
}

/** GitHub rewrites `+` in asset names, so file names use `_`. */
export function archiveName(uiVersion) {
  return `ui-${uiVersion.replace(/\+/g, "_")}.tar.gz`;
}

export function validUiVersion(v) {
  return typeof v === "string" && v.length > 0 && v.length <= 96 && /^\d[0-9A-Za-z.+-]*$/.test(v) && !v.includes("..");
}

export function buildInnerManifest({ uiVersion, shellKeys, minAppVersion, createdAt }) {
  if (!validUiVersion(uiVersion)) throw new Error(`ui-bundle: invalid uiVersion "${uiVersion}"`);
  const keys = [...new Set((shellKeys ?? []).map((k) => String(k).trim()).filter(Boolean))];
  if (keys.length === 0) throw new Error("ui-bundle: at least one --shell-key is required");
  const manifest = { uiVersion, shellKeys: keys, createdAt: createdAt ?? new Date().toISOString() };
  if (minAppVersion) manifest.minAppVersion = minAppVersion;
  return manifest;
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function pack({ dist, uiVersion, shellKeys, minAppVersion, out, createdAt }) {
  if (!existsSync(join(dist, "index.html"))) {
    throw new Error(`ui-bundle: ${dist}/index.html not found (build the UI first)`);
  }
  const inner = buildInnerManifest({ uiVersion, shellKeys, minAppVersion, createdAt });
  const stage = mkdtempSync(join(tmpdir(), "ui-bundle-"));
  try {
    cpSync(dist, join(stage, "dist"), { recursive: true, dereference: true });
    writeFileSync(join(stage, "hq-ui-manifest.json"), `${JSON.stringify(inner, null, 2)}\n`);
    mkdirSync(out, { recursive: true });
    const archive = resolve(out, archiveName(uiVersion));
    // COPYFILE_DISABLE keeps macOS bsdtar from adding ._ AppleDouble files.
    execFileSync("tar", ["-czf", archive, "-C", stage, "hq-ui-manifest.json", "dist"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const sha256 = sha256Hex(readFileSync(archive));
    const manifest = { ...inner, sha256, archive: archiveName(uiVersion), size: statSync(archive).size };
    writeFileSync(join(out, "ui-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return { archive, manifest };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function buildPointer({ manifest, signature, url, channel, allowLocal = false }) {
  if (!CHANNELS.includes(channel)) throw new Error(`ui-bundle: channel must be one of ${CHANNELS.join(", ")}`);
  // file:// and loopback URLs are for local verification against a debug
  // build only (release builds refuse them).
  const local = allowLocal && /^(file:\/\/|http:\/\/127\.0\.0\.1)/.test(url);
  if (!/^https:\/\//.test(url) && !local) throw new Error("ui-bundle: --url must be https");
  const sig = String(signature).trim();
  if (!sig) throw new Error("ui-bundle: empty signature");
  if (!/^[0-9a-f]{64}$/.test(manifest.sha256 ?? "")) throw new Error("ui-bundle: manifest has no sha256");
  const pointer = {
    channel,
    uiVersion: manifest.uiVersion,
    shellKeys: manifest.shellKeys,
    sha256: manifest.sha256,
    size: manifest.size,
    createdAt: manifest.createdAt,
    url,
    signature: sig,
  };
  if (manifest.minAppVersion) pointer.minAppVersion = manifest.minAppVersion;
  return pointer;
}

const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/**
 * The release a ui-only bundle is built on top of. `stable` follows the
 * newest published non-prerelease; `beta` the newest published release of
 * either kind. Drafts and the non-version tags (shell-cache, ui-updates) are
 * never chosen.
 */
export function selectBaseRelease(releases, channel) {
  if (!CHANNELS.includes(channel)) throw new Error(`ui-bundle: channel must be one of ${CHANNELS.join(", ")}`);
  const candidates = releases
    .flat()
    .filter((r) => r && !r.draft && RELEASE_TAG.test(r.tag_name ?? ""))
    .filter((r) => channel === "beta" || !r.prerelease)
    .sort((a, b) => String(b.published_at ?? "").localeCompare(String(a.published_at ?? "")));
  const base = candidates[0];
  if (!base) throw new Error(`ui-bundle: no published release for channel ${channel}`);
  return { tag: base.tag_name, version: base.tag_name.match(RELEASE_TAG)[1] };
}

/** Shell keys from a release's ui-manifest.json, plus explicit extras. */
export function shellKeysFor(manifest, extra = []) {
  const keys = [...(manifest?.shellKeys ?? []), ...extra]
    .map((k) => String(k).trim())
    .filter(Boolean);
  for (const k of keys) {
    if (!/^[0-9a-f]{64}$/.test(k)) throw new Error(`ui-bundle: "${k}" is not a shell key`);
  }
  const unique = [...new Set(keys)];
  if (unique.length === 0) throw new Error("ui-bundle: no shell keys (base release has no ui-manifest.json and no --extra keys)");
  return unique;
}

const ARCHIVE_ASSET = /^ui-.+\.tar\.gz$/;

/**
 * ui-updates archive (+ .sig) assets to delete: everything but the newest
 * `keep` archives and anything a pointer still references.
 */
export function prunePlan(assets, keep, referenced = []) {
  const archives = assets
    .filter((a) => ARCHIVE_ASSET.test(a.name))
    .sort((a, b) => String(b.created_at ?? b.createdAt ?? "").localeCompare(String(a.created_at ?? a.createdAt ?? "")));
  const doomed = archives.slice(keep).map((a) => a.name).filter((n) => !referenced.includes(n));
  const names = new Set(assets.map((a) => a.name));
  return doomed.flatMap((n) => (names.has(`${n}.sig`) ? [n, `${n}.sig`] : [n]));
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { shellKeys: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`ui-bundle: bad argument "${flag}"`);
    const key = flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (key === "shellKey") opts.shellKeys.push(value);
    else opts[key] = value;
  }
  return { command, opts };
}

function main(argv) {
  const { command, opts } = parseArgs(argv);
  if (command === "version") {
    process.stdout.write(`${uiVersionFor(opts.appVersion, opts.sha, opts.now ? new Date(opts.now) : new Date())}\n`);
  } else if (command === "pack") {
    const { archive, manifest } = pack({ ...opts, dist: opts.dist, out: opts.out });
    process.stdout.write(`${archive}\n`);
    process.stderr.write(`ui-bundle: ${manifest.uiVersion} sha256=${manifest.sha256} keys=${manifest.shellKeys.length}\n`);
  } else if (command === "pointer") {
    const manifest = JSON.parse(readFileSync(opts.manifest, "utf8"));
    const pointer = buildPointer({
      manifest,
      signature: readFileSync(opts.sig, "utf8"),
      url: opts.url,
      channel: opts.channel,
      allowLocal: opts.allowLocal === "true",
    });
    writeFileSync(opts.out, `${JSON.stringify(pointer, null, 2)}\n`);
    process.stdout.write(`${opts.out}\n`);
  } else if (command === "select-base") {
    const base = selectBaseRelease(JSON.parse(readFileSync(opts.releases, "utf8")), opts.channel);
    process.stdout.write(`${base.tag} ${base.version}\n`);
  } else if (command === "keys") {
    const manifest = opts.manifest && existsSync(opts.manifest) ? JSON.parse(readFileSync(opts.manifest, "utf8")) : null;
    const extra = (opts.extra ?? "").split(/[\s,]+/).filter(Boolean);
    process.stdout.write(`${shellKeysFor(manifest, extra).join("\n")}\n`);
  } else if (command === "prune-plan") {
    const assets = JSON.parse(readFileSync(opts.assets, "utf8"));
    const referenced = (opts.referenced ?? "").split(/[\s,]+/).filter(Boolean);
    const plan = prunePlan(assets, Number(opts.keep ?? 10), referenced);
    if (plan.length) process.stdout.write(`${plan.join("\n")}\n`);
  } else {
    throw new Error(`ui-bundle: unknown command "${command}" (version | pack | pointer | select-base | keys | prune-plan)`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
