import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { checkCrossRepoConsumers } from "./check-cross-repo-consumers.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const installPath = "apps/sync/src-tauri/src/commands/install_deps.rs";
const cloudPath = "crates/hq-desktop-core/src/hq_cloud.rs";
const resolverConsumer = {
  repo: "indigoai-us/hq-cloud",
  file: ".github/scripts/resolve-shipped-node.mjs",
};
const versionConsumer = {
  repo: "indigoai-us/hq-cloud",
  file: ".github/workflows/unreleased-commits-nag.yml",
};

function fixture(t, entries, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "td-143-cross-repo-consumers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, contents);
  }
  const manifestPath = join(root, ".github/cross-repo-consumers.json");
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(entries, null, 2)}\n`);
  return { root, manifestPath };
}

function singleEntry(path, consumer, requiredTokens) {
  return [{ path, consumers: [consumer], required_tokens: requiredTokens }];
}

function failureMessage(action) {
  let error;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error, "expected the consumer check to fail");
  return error.message;
}

function withoutDeclaration(source, prefix) {
  const lines = source.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trimStart().startsWith(prefix));
  assert.notEqual(index, -1, `fixture must contain ${prefix}`);
  lines.splice(index, 1);
  return lines.join("\n");
}

test("passes against the committed manifest and desktop source tree", () => {
  const manifest = checkCrossRepoConsumers({ repoRoot });
  assert.ok(manifest.some((entry) => entry.path === installPath));
  assert.ok(manifest.some((entry) => entry.path === cloudPath));
});

test("names the path and consumer when a listed file is missing", (t) => {
  const missingPath = "apps/sync/src-tauri/src/commands/not-present.rs";
  const { root, manifestPath } = fixture(
    t,
    singleEntry(missingPath, resolverConsumer, []),
  );
  const message = failureMessage(() => checkCrossRepoConsumers({ repoRoot: root, manifestPath }));
  assert.ok(message.includes(missingPath));
  assert.ok(message.includes("indigoai-us/hq-cloud .github/scripts/resolve-shipped-node.mjs"));
});

test("requires MANAGED_NODE_VERSION as a declaration", (t) => {
  const source = readFileSync(resolve(repoRoot, installPath), "utf8");
  const without = withoutDeclaration(source, "const MANAGED_NODE_VERSION:");
  const { root, manifestPath } = fixture(
    t,
    singleEntry(installPath, resolverConsumer, ["MANAGED_NODE_VERSION"]),
    { [installPath]: without },
  );
  const message = failureMessage(() => checkCrossRepoConsumers({ repoRoot: root, manifestPath }));
  assert.ok(message.includes(installPath));
  assert.ok(message.includes("indigoai-us/hq-cloud .github/scripts/resolve-shipped-node.mjs"));
  assert.ok(message.includes('missing declaration "MANAGED_NODE_VERSION"'));
});

test("requires WINDOWS_MANAGED_NODE_VERSION as a declaration", (t) => {
  const source = readFileSync(resolve(repoRoot, installPath), "utf8");
  const without = withoutDeclaration(source, "const WINDOWS_MANAGED_NODE_VERSION:");
  const { root, manifestPath } = fixture(
    t,
    singleEntry(installPath, resolverConsumer, ["WINDOWS_MANAGED_NODE_VERSION"]),
    { [installPath]: without },
  );
  const message = failureMessage(() => checkCrossRepoConsumers({ repoRoot: root, manifestPath }));
  assert.ok(message.includes(installPath));
  assert.ok(message.includes("indigoai-us/hq-cloud .github/scripts/resolve-shipped-node.mjs"));
  assert.ok(message.includes('missing declaration "WINDOWS_MANAGED_NODE_VERSION"'));
});

test("requires HQ_CLOUD_VERSION as a declaration", (t) => {
  const source = readFileSync(resolve(repoRoot, cloudPath), "utf8");
  const without = withoutDeclaration(source, "pub const HQ_CLOUD_VERSION:");
  const { root, manifestPath } = fixture(
    t,
    singleEntry(cloudPath, versionConsumer, ["HQ_CLOUD_VERSION"]),
    { [cloudPath]: without },
  );
  const message = failureMessage(() => checkCrossRepoConsumers({ repoRoot: root, manifestPath }));
  assert.ok(message.includes(cloudPath));
  assert.ok(message.includes("indigoai-us/hq-cloud .github/workflows/unreleased-commits-nag.yml"));
  assert.ok(message.includes('missing declaration "HQ_CLOUD_VERSION"'));
});

test("reports the deleted pre-#855 deps.rs path", (t) => {
  const oldPath = "imports/hq-installer-react/src-tauri/src/commands/deps.rs";
  const { root, manifestPath } = fixture(
    t,
    singleEntry(oldPath, resolverConsumer, ["MANAGED_NODE_VERSION", "WINDOWS_MANAGED_NODE_VERSION"]),
  );
  const message = failureMessage(() => checkCrossRepoConsumers({ repoRoot: root, manifestPath }));
  assert.ok(message.includes(oldPath));
  assert.ok(message.includes("indigoai-us/hq-cloud .github/scripts/resolve-shipped-node.mjs"));
});
