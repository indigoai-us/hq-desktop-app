import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { computeShellHash, normalizeCargoLock, normalizeCargoToml, normalizeTauriConf } from "./shell-hash.mjs";

const execFileAsync = promisify(execFile);

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "shell-hash-"));
  await mkdir(join(root, "crates/hq-desktop-core/src"), { recursive: true });
  await mkdir(join(root, "apps/sync/src-tauri/src"), { recursive: true });
  await writeFile(join(root, "crates/hq-desktop-core/src/lib.rs"), "pub fn hi() {}\n");
  await writeFile(join(root, "apps/sync/src-tauri/src/main.rs"), "fn main() {}\n");
  await writeFile(join(root, "apps/sync/src-tauri/Cargo.lock"), "# lock v1\n");
  await writeFile(join(root, "apps/sync/src-tauri/Cargo.toml"), "[package]\nname='x'\n");
  await writeFile(join(root, "apps/sync/src-tauri/build.rs"), "fn main() {}\n");
  await writeFile(
    join(root, "apps/sync/src-tauri/tauri.conf.json"),
    JSON.stringify({ productName: "HQ", version: "0.10.328", app: { z: 1, a: 2 } }),
  );
  return root;
}

describe("shell-hash", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true });
  });

  it("does not change when only the tauri.conf.json version changes", async () => {
    const root = await makeFixture();
    cleanup.push(root);
    const before = await computeShellHash(root, { rustToolchain: "1.80.0", targetTriple: "aarch64-apple-darwin" });

    await writeFile(
      join(root, "apps/sync/src-tauri/tauri.conf.json"),
      JSON.stringify({ productName: "HQ", version: "0.10.999", app: { z: 1, a: 2 } }),
    );
    const after = await computeShellHash(root, { rustToolchain: "1.80.0", targetTriple: "aarch64-apple-darwin" });

    expect(after).toBe(before);
  });

  it("changes when a Rust source file under crates/ changes", async () => {
    const root = await makeFixture();
    cleanup.push(root);
    const before = await computeShellHash(root, { rustToolchain: "1.80.0", targetTriple: "aarch64-apple-darwin" });

    await writeFile(join(root, "crates/hq-desktop-core/src/lib.rs"), "pub fn hi() { /* changed */ }\n");
    const after = await computeShellHash(root, { rustToolchain: "1.80.0", targetTriple: "aarch64-apple-darwin" });

    expect(after).not.toBe(before);
  });

  it("changes when a src-tauri source file changes", async () => {
    const root = await makeFixture();
    cleanup.push(root);
    const before = await computeShellHash(root, { rustToolchain: "1.80.0", targetTriple: "aarch64-apple-darwin" });

    await writeFile(join(root, "apps/sync/src-tauri/src/main.rs"), "fn main() { /* changed */ }\n");
    const after = await computeShellHash(root, { rustToolchain: "1.80.0", targetTriple: "aarch64-apple-darwin" });

    expect(after).not.toBe(before);
  });

  it("changes when Cargo.lock changes", async () => {
    const root = await makeFixture();
    cleanup.push(root);
    const before = await computeShellHash(root, { rustToolchain: "1.80.0", targetTriple: "aarch64-apple-darwin" });

    await writeFile(join(root, "apps/sync/src-tauri/Cargo.lock"), "# lock v2\n");
    const after = await computeShellHash(root, { rustToolchain: "1.80.0", targetTriple: "aarch64-apple-darwin" });

    expect(after).not.toBe(before);
  });

  it("changes when the rustc toolchain or target triple changes", async () => {
    const root = await makeFixture();
    cleanup.push(root);
    const base = await computeShellHash(root, { rustToolchain: "1.80.0", targetTriple: "aarch64-apple-darwin" });
    const diffToolchain = await computeShellHash(root, { rustToolchain: "1.81.0", targetTriple: "aarch64-apple-darwin" });
    const diffTarget = await computeShellHash(root, { rustToolchain: "1.80.0", targetTriple: "x86_64-pc-windows-msvc" });

    expect(diffToolchain).not.toBe(base);
    expect(diffTarget).not.toBe(base);
  });

  it("is unaffected by tauri.conf.json key order", () => {
    const a = normalizeTauriConf(JSON.stringify({ b: 1, a: 2, version: "1.0.0" }));
    const b = normalizeTauriConf(JSON.stringify({ a: 2, b: 1, version: "9.9.9" }));
    expect(a).toBe(b);
  });

  it("does not change when only the app package version in Cargo.toml / Cargo.lock changes", async () => {
    const root = await makeFixture();
    cleanup.push(root);
    const toml = (v: string) => `[package]\nname = "hq-sync-menubar"\nversion = "${v}"\nedition = "2021"\n`;
    const lock = (v: string) =>
      `[[package]]\nname = "hq-sync-menubar"\nversion = "${v}"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\n`;
    await writeFile(join(root, "apps/sync/src-tauri/Cargo.toml"), toml("0.10.328"));
    await writeFile(join(root, "apps/sync/src-tauri/Cargo.lock"), lock("0.10.328"));
    const before = await computeShellHash(root, { rustToolchain: "1.80.0", targetTriple: "universal-apple-darwin" });

    await writeFile(join(root, "apps/sync/src-tauri/Cargo.toml"), toml("0.0.0-shelltest.7"));
    await writeFile(join(root, "apps/sync/src-tauri/Cargo.lock"), lock("0.0.0-shelltest.7"));
    const after = await computeShellHash(root, { rustToolchain: "1.80.0", targetTriple: "universal-apple-darwin" });

    expect(after).toBe(before);
  });

  it("still changes when a dependency version in Cargo.lock changes", () => {
    const lock = (v: string) => `[[package]]\nname = "hq-sync-menubar"\nversion = "1.0.0"\n\n[[package]]\nname = "serde"\nversion = "${v}"\n`;
    expect(normalizeCargoLock(lock("1.0.0"))).not.toBe(normalizeCargoLock(lock("1.0.1")));
    expect(normalizeCargoToml('[package]\nname = "x"\nversion = "1"\n[dependencies]\nserde = { version = "1" }\n')).toContain(
      'serde = { version = "1" }',
    );
  });

  it("changes when a bundled macOS input (Recall sidecar lockfile, tray helper) changes", async () => {
    const root = await makeFixture();
    cleanup.push(root);
    const before = await computeShellHash(root, { rustToolchain: "1.80.0", targetTriple: "universal-apple-darwin" });

    await mkdir(join(root, "apps/sync/sidecar/recall-sdk-bridge"), { recursive: true });
    await writeFile(join(root, "apps/sync/sidecar/recall-sdk-bridge/pnpm-lock.yaml"), "lockfileVersion: 9\n");
    const withSidecar = await computeShellHash(root, { rustToolchain: "1.80.0", targetTriple: "universal-apple-darwin" });
    expect(withSidecar).not.toBe(before);

    await mkdir(join(root, "apps/sync/src-tauri/helper"), { recursive: true });
    await writeFile(join(root, "apps/sync/src-tauri/helper/hq-tray-helper.swift"), "print(1)\n");
    const withHelper = await computeShellHash(root, { rustToolchain: "1.80.0", targetTriple: "universal-apple-darwin" });
    expect(withHelper).not.toBe(withSidecar);
  });

  it("does not change for a frontend-only edit", async () => {
    const root = await makeFixture();
    cleanup.push(root);
    const before = await computeShellHash(root, { rustToolchain: "1.80.0", targetTriple: "universal-apple-darwin" });
    await mkdir(join(root, "apps/sync/src"), { recursive: true });
    await writeFile(join(root, "apps/sync/src/App.svelte"), "<p>changed</p>\n");
    const after = await computeShellHash(root, { rustToolchain: "1.80.0", targetTriple: "universal-apple-darwin" });
    expect(after).toBe(before);
  });

  // Regression: the CLI-entry check (`import.meta.url === file://${argv[1]}`)
  // compared a URL against a raw OS path. process.argv[1] is a backslash path
  // on Windows, which never equals a file:// URL, so `main()` silently never
  // ran there — node exited 0 with empty stdout, and the release workflow's
  // shell-windows-x64/arm64 jobs failed with "shell-hash.mjs returned an
  // invalid key: " (empty). This can't reproduce the Windows path separator
  // itself on a POSIX test runner, but it does exercise the exact invocation
  // shape release.yml uses (a relative path from the working directory) and
  // would have caught the "never runs, prints nothing" failure mode outright.
  it("prints a 64-hex key when invoked as a CLI script, not just as a module", async () => {
    const scriptPath = fileURLToPath(new URL("./shell-hash.mjs", import.meta.url));
    const { stdout } = await execFileAsync("node", [
      scriptPath,
      "--root",
      fileURLToPath(new URL("../", import.meta.url)),
      "--toolchain",
      "1.80.0",
      "--target",
      "x86_64-pc-windows-msvc",
    ]);
    expect(stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
  });
});
