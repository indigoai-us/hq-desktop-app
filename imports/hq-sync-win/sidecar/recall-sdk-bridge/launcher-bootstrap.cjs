// launcher-bootstrap.cjs — embedded entry point for the recall-desktop-sdk
// Single Executable Application (Node SEA) launcher.
//
// WHY THIS EXISTS (Windows parity with the macOS bash wrapper)
// ------------------------------------------------------------
// On macOS the externalBin `recall-desktop-sdk-{triple}` is a tiny *bash*
// wrapper that `exec node bridge.mjs`. Windows has no equivalent: the Rust
// process spawner (`commands::process`) launches the sidecar with a direct
// `CreateProcess` (CREATE_NO_WINDOW, no shell), so the externalBin MUST be a
// real PE executable — a `.cmd`/`.bat` shim would not be launchable that way.
//
// We therefore build the launcher as a Node Single Executable Application:
// a copy of the `node.exe` runtime with this bootstrap blob injected
// (see build.mjs). The launcher is fully self-contained — it does NOT depend
// on a system Node being installed on the end-user's machine.
//
// At runtime this bootstrap:
//   1. Locates `bridge.mjs` (the real sidecar) shipped via Tauri
//      `bundle.resources` next to the app executable.
//   2. `import()`s it IN-PROCESS under the launcher's own embedded Node
//      runtime. Because bridge.mjs is loaded from a real on-disk path, its
//      own `require("@recallai/desktop-sdk")` + relative `./recording-tracker`
//      imports resolve through the normal node_modules tree that ships
//      alongside it (also via bundle.resources). No child `node` is spawned.
//
// All CLI args (`--json` from recall_sdk.rs) and every `RECALL_*` env var are
// already in this process and are visible to bridge.mjs unchanged.
//
// RESOLUTION ORDER (first existing wins)
//   a. <exeDir>/recall-sdk-bridge/bridge.mjs   ← Tauri Windows bundle layout
//                                                 (resources land next to exe)
//   b. <exeDir>/resources/recall-sdk-bridge/bridge.mjs ← defensive: some Tauri
//                                                 versions nest under resources/
//   c. <exeDir>/bridge.mjs                      ← flat fallback
//   d. $RECALL_BRIDGE_PATH                       ← explicit override for tests
//   e. dev tree: ../../sidecar/recall-sdk-bridge/bridge.mjs relative to exe
//
// On total failure we print every path we checked to stderr (captured by
// recall_sdk.rs as `recall-sdk.stderr`) and exit non-zero, which the Rust
// side maps to RECALL_SDK_UNAVAILABLE — the app keeps running.

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const exeDir = path.dirname(process.execPath);

const candidates = [
  path.join(exeDir, "recall-sdk-bridge", "bridge.mjs"),
  path.join(exeDir, "resources", "recall-sdk-bridge", "bridge.mjs"),
  path.join(exeDir, "bridge.mjs"),
  process.env.RECALL_BRIDGE_PATH || "",
  // Dev / loose-build fallbacks: launcher sitting in src-tauri/binaries or
  // target/{debug,release} with the repo checkout above it.
  path.join(exeDir, "..", "..", "sidecar", "recall-sdk-bridge", "bridge.mjs"),
  path.join(
    exeDir,
    "..",
    "..",
    "..",
    "sidecar",
    "recall-sdk-bridge",
    "bridge.mjs",
  ),
];

let bridgePath = null;
for (const candidate of candidates) {
  if (candidate && fs.existsSync(candidate)) {
    bridgePath = candidate;
    break;
  }
}

if (!bridgePath) {
  process.stderr.write(
    "[recall-desktop-sdk launcher] cannot find bridge.mjs; checked:\n",
  );
  for (const candidate of candidates) {
    if (candidate) process.stderr.write(`  ${candidate}\n`);
  }
  process.exit(1);
}

// Load the ESM sidecar in-process. Any throw inside bridge.mjs (e.g. the SDK
// failing to require) surfaces here; bridge.mjs itself handles its own clean
// process.exit codes (2/3/4) for the documented unavailable paths, so a reject
// reaching us is genuinely unexpected — log it and exit non-zero.
import(pathToFileURL(bridgePath).href).catch((err) => {
  process.stderr.write(
    `[recall-desktop-sdk launcher] failed to start bridge.mjs (${bridgePath}): ${
      err && err.stack ? err.stack : err
    }\n`,
  );
  process.exit(1);
});
