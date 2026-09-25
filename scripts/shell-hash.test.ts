import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { computeShellHash, normalizeTauriConf } from "./shell-hash.mjs";

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
});
