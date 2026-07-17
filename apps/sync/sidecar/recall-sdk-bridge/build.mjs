#!/usr/bin/env node
/**
 * build.mjs - produce the Windows `recall-desktop-sdk` Tauri sidecar.
 *
 * Two outputs, both required for the bundled SDK to actually run:
 *
 *   1. The LAUNCHER  -> src-tauri/binaries/recall-desktop-sdk-<triple>.exe
 *      A Node Single Executable Application (SEA): a copy of node.exe with
 *      launcher-bootstrap.cjs injected. This is the file Tauri references in
 *      `bundle.externalBin`. It is a real PE32+ executable (required because
 *      the Rust process spawner uses a direct CreateProcess with no shell, so
 *      a .cmd/.bat shim could not be launched). It is self-contained: end users
 *      do NOT need Node installed.
 *
 *   2. The PAYLOAD   -> sidecar/recall-sdk-bridge/node_modules/** (left in place)
 *      The real `@recallai/desktop-sdk` runtime: agent-windows.exe + the full
 *      FFmpeg/GStreamer DLL stack + gstreamer-1.0/ plugins. Tauri ships this
 *      verbatim via `bundle.resources` (mapped next to the exe), so the
 *      launcher's in-process `import("bridge.mjs")` can `require()` it. We only
 *      ensure it is installed here; placement is Tauri's job.
 *
 * USAGE
 *   node sidecar/recall-sdk-bridge/build.mjs          # build (idempotent)
 *   node sidecar/recall-sdk-bridge/build.mjs --force  # rebuild launcher
 *   node sidecar/recall-sdk-bridge/build.mjs --check   # verify only, no build
 *
 * Idempotent: a second run with the launcher already present and the SDK
 * payload already installed is a fast no-op (safe to chain from Tauri's
 * beforeBuildCommand). Pass --force to always rebuild the launcher.
 *
 * Windows ARM64 uses a native ARM64 Node runtime for this launcher. Recall's
 * agent remains a separate x64 child process, which Windows on ARM runs under
 * its built-in x64 emulation; it is never loaded into the ARM64 Node process.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  mkdirSync,
  readSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, "..", "..");

const args = new Set(process.argv.slice(2));
const FORCE = args.has("--force");
const CHECK_ONLY = args.has("--check");

// The Tauri externalBin target triple. Overridable so the release matrix can
// pass aarch64-pc-windows-msvc. Tauri appends the triple + .exe to the
// externalBin stem (`binaries/recall-desktop-sdk`) when it copies the binary.
const TARGET_TRIPLE =
  process.env.RECALL_SIDECAR_TARGET || "x86_64-pc-windows-msvc";
const TARGET_MACHINES = new Map([
  ["x86_64-pc-windows-msvc", 0x8664],
  ["aarch64-pc-windows-msvc", 0xaa64],
]);
const launcherRuntime = process.env.RECALL_SIDECAR_NODE_EXECUTABLE
  ? resolve(process.env.RECALL_SIDECAR_NODE_EXECUTABLE)
  : process.execPath;

const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const binariesDir = join(appRoot, "src-tauri", "binaries");
const launcherExe = join(binariesDir, `recall-desktop-sdk-${TARGET_TRIPLE}.exe`);
const bootstrap = join(__dirname, "launcher-bootstrap.cjs");
const seaConfigPath = join(__dirname, "sea-config.json");
const seaBlobPath = join(__dirname, "recall-desktop-sdk.blob");

function log(msg) {
  process.stdout.write(`[recall-sidecar/build] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[recall-sidecar/build] ERROR: ${msg}\n`);
  process.exit(1);
}

function commandName(base) {
  return process.platform === "win32" ? `${base}.cmd` : base;
}

function peMachine(path) {
  const fd = openSync(path, "r");
  try {
    const dosHeader = Buffer.alloc(64);
    if (readSync(fd, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length) {
      fail(`cannot read DOS header from ${path}`);
    }
    if (dosHeader.readUInt16LE(0) !== 0x5a4d) {
      fail(`launcher runtime is not a PE executable: ${path}`);
    }
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(6);
    if (readSync(fd, peHeader, 0, peHeader.length, peOffset) !== peHeader.length) {
      fail(`cannot read PE header from ${path}`);
    }
    if (peHeader.readUInt32LE(0) !== 0x00004550) {
      fail(`launcher runtime has an invalid PE signature: ${path}`);
    }
    return peHeader.readUInt16LE(4);
  } finally {
    closeSync(fd);
  }
}

function assertTargetArchitecture(path) {
  const expected = TARGET_MACHINES.get(TARGET_TRIPLE);
  const actual = peMachine(path);
  if (actual !== expected) {
    fail(
      `runtime architecture mismatch for ${TARGET_TRIPLE}: expected PE machine ` +
        `0x${expected.toString(16)}, got 0x${actual.toString(16)} (${path})`,
    );
  }
}

// 1. Ensure the @recallai/desktop-sdk runtime payload is installed.
function sdkInstalled() {
  // setup.js downloads the native runtime as a sibling of index.js. The
  // agent-windows.exe is the canonical proof the win32 payload extracted.
  try {
    const pkgDir = dirname(require.resolve("@recallai/desktop-sdk/package.json"));
    return existsSync(join(pkgDir, "agent-windows.exe"));
  } catch {
    return false;
  }
}

function ensureSdkPayload() {
  if (sdkInstalled()) {
    log("@recallai/desktop-sdk runtime already present (agent-windows.exe found)");
    return;
  }
  if (CHECK_ONLY) {
    fail(
      "@recallai/desktop-sdk runtime missing (no agent-windows.exe). Run " +
        "`pnpm install --ignore-workspace` in sidecar/recall-sdk-bridge/ first.",
    );
  }
  log("@recallai/desktop-sdk runtime missing - installing into sidecar/recall-sdk-bridge");
  // pnpm respects the .npmrc (node-linker=hoisted, minimum-release-age) and runs
  // the package's postinstall (setup.js), which fetches desktop_sdk_win32.tar.
  execFileSync(commandName("pnpm"), ["install", "--ignore-workspace"], {
    cwd: __dirname,
    stdio: "inherit",
  });
  if (!sdkInstalled()) {
    fail("install completed but agent-windows.exe still missing");
  }
  log("@recallai/desktop-sdk runtime installed");
}

// 2. Build the SEA launcher exe.
async function buildLauncher() {
  if (existsSync(launcherExe) && !FORCE) {
    assertTargetArchitecture(launcherExe);
    log(`launcher already present (${launcherExe}); pass --force to rebuild`);
    return;
  }
  if (CHECK_ONLY) {
    fail(`launcher missing (${launcherExe}). Run build.mjs (no --check) to produce it.`);
  }

  mkdirSync(binariesDir, { recursive: true });
  if (!existsSync(launcherRuntime)) {
    fail(`launcher runtime not found: ${launcherRuntime}`);
  }
  assertTargetArchitecture(launcherRuntime);

  // 2a. SEA prep blob from the bootstrap.
  writeFileSync(
    seaConfigPath,
    JSON.stringify(
      {
        main: bootstrap,
        output: seaBlobPath,
        disableExperimentalSEAWarning: true,
      },
      null,
      2,
    ),
  );
  log("generating SEA preparation blob");
  execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], {
    stdio: "inherit",
  });

  // 2b. Copy the target-architecture Node runtime to the launcher path. The
  // SEA preparation blob is architecture-independent because snapshots and
  // code cache are disabled in sea-config.json.
  log(`copying node runtime (${launcherRuntime}) -> ${launcherExe}`);
  copyFileSync(launcherRuntime, launcherExe);

  // 2c. Inject the blob with postject via its programmatic API. We resolve the
  // module (a sidecar devDependency) and call inject() directly; invoking the
  // `postject` CLI through `npx`/the `.cmd` shim is unreliable across shells on
  // Windows and would pull from the network. The blob name + sentinel fuse must
  // match what Node's SEA loader looks for.
  log("injecting SEA blob (postject programmatic API)");
  let postject;
  try {
    postject = require("postject");
  } catch {
    fail(
      "postject not installed - run `pnpm install --ignore-workspace` in " +
        "sidecar/recall-sdk-bridge (it is a devDependency).",
    );
  }
  await postject.inject(launcherExe, "NODE_SEA_BLOB", readFileSync(seaBlobPath), {
    sentinelFuse: SEA_FUSE,
  });

  // 2d. Clean up intermediate artifacts.
  for (const f of [seaConfigPath, seaBlobPath]) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* best-effort */
    }
  }

  const size = statSync(launcherExe).size;
  assertTargetArchitecture(launcherExe);
  log(`launcher built: ${launcherExe} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

// Main.
async function main() {
  log(`target triple: ${TARGET_TRIPLE}`);
  if (!TARGET_MACHINES.has(TARGET_TRIPLE)) {
    fail(`unsupported target ${TARGET_TRIPLE}`);
  }
  ensureSdkPayload();
  await buildLauncher();

  // Final assertion so a broken build fails loudly here rather than at
  // `tauri build` time.
  if (!existsSync(launcherExe)) {
    fail(`expected launcher not found after build: ${launcherExe}`);
  }
  if (!sdkInstalled()) {
    fail("expected @recallai/desktop-sdk runtime payload missing after build");
  }
  log("OK - launcher + runtime payload ready for `tauri build`");
}

main().catch((err) => {
  fail(err && err.stack ? err.stack : String(err));
});
