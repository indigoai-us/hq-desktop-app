// launcher-bootstrap.cjs - embedded entry point for the recall-desktop-sdk
// Single Executable Application (Node SEA) launcher.
//
// WHY THIS EXISTS (Windows parity with the macOS bash wrapper)
// ------------------------------------------------------------
// On macOS the externalBin `recall-desktop-sdk-{triple}` is a tiny bash
// wrapper that `exec node bridge.mjs`. Windows has no equivalent: the Rust
// process spawner (`commands::process`) launches the sidecar with a direct
// CreateProcess (CREATE_NO_WINDOW, no shell), so the externalBin MUST be a
// real PE executable. A .cmd/.bat shim would not be launchable that way.
//
// We therefore build the launcher as a Node Single Executable Application:
// a copy of the node.exe runtime with this bootstrap blob injected (see
// build.mjs). The launcher is fully self-contained. It does NOT depend on a
// system Node being installed on the end-user's machine.
//
// At runtime this bootstrap:
//   1. Locates `bridge.mjs` (the real sidecar) shipped via Tauri
//      `bundle.resources` next to the app executable.
//   2. `import()`s it in-process under the launcher's own embedded Node
//      runtime. Because bridge.mjs is loaded from a real on-disk path, its own
//      `require("@recallai/desktop-sdk")` + relative `./recording-tracker`
//      imports resolve through the normal node_modules tree that ships
//      alongside it (also via bundle.resources). No child node is spawned.
//
// All CLI args (`--json` from recall_sdk.rs) and every RECALL_* env var are
// already in this process and are visible to bridge.mjs unchanged.
//
// RESOLUTION ORDER (first existing wins)
//   a. <exeDir>/recall-sdk-bridge/bridge.mjs
//   b. <exeDir>/resources/recall-sdk-bridge/bridge.mjs
//   c. <exeDir>/bridge.mjs
//   d. $RECALL_BRIDGE_PATH
//   e. dev tree fallbacks relative to src-tauri/binaries or target/{debug,release}

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

// Load the ESM sidecar in-process. Any throw inside bridge.mjs surfaces here;
// bridge.mjs itself handles its own clean process.exit codes for documented
// unavailable paths, so a reject reaching us is unexpected.
import(pathToFileURL(bridgePath).href).catch((err) => {
  process.stderr.write(
    `[recall-desktop-sdk launcher] failed to start bridge.mjs (${bridgePath}): ${
      err && err.stack ? err.stack : err
    }\n`,
  );
  process.exit(1);
});
