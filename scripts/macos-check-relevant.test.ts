import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isMacosRelevant,
  MACOS_RELEVANT_PATTERNS,
} from "./macos-check-relevant.mjs";

describe("macOS Rust gate path scope", () => {
  it("runs for Rust, native, toolchain, sidecar, and gate-definition inputs", () => {
    for (const path of [
      "apps/sync/src-tauri/src/main.rs",
      "apps/sync/src-tauri/tauri.conf.json",
      "apps/sync/src-tauri/helper/hq-tray-helper.swift",
      "apps/sync/src-tauri/build.rs",
      "apps/sync/src-tauri/Cargo.lock",
      "apps/sync/sidecar/recall-sdk-bridge/package.json",
      "apps/work/src-tauri/gen/apple/Sources/hq-work-mobile/main.mm",
      "apps/work/src-tauri/gen/apple/Sources/hq-work-mobile/bindings/bindings.h",
      "crates/hq-desktop-core/src/lib.rs",
      "imports/hq-sync-win/src-tauri/src/main.rs",
      "Cargo.toml",
      "Cargo.lock",
      "build.rs",
      "rust-toolchain.toml",
      "rust-toolchain",
      ".cargo/config.toml",
      "packages/native/src/Bridge.m",
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
      "apps/sync/src/components/onboarding/welcome/welcome.css",
      "scripts/macos-check-relevant.mjs",
    ]) {
      expect(isMacosRelevant([path]), path).toBe(true);
    }
  });

  it("skips frontend, docs, lockfile, script, and other-workflow changes", () => {
    for (const path of [
      "CHANGELOG.md",
      "docs/README.md",
      "apps/sync/src/App.svelte",
      "apps/sync/src/lib/api.ts",
      "apps/sync/package.json",
      "apps/sync/e2e/desktop-alt/home.spec.ts",
      "apps/work/src/App.svelte",
      "apps/intro/package.json",
      "packages/ui/src/Button.test.ts",
      "package.json",
      "pnpm-lock.yaml",
      "versions.toml",
      "scripts/windows-check-relevant.mjs",
      ".github/workflows/windows-check.yml",
      "apps/sync/src/components/onboarding/welcome/welcome.svelte",
    ]) {
      expect(isMacosRelevant([path]), path).toBe(false);
    }
  });

  it("runs when any one path in a mixed change is relevant", () => {
    expect(
      isMacosRelevant(["docs/README.md", "apps/sync/src-tauri/src/lib.rs"]),
    ).toBe(true);
  });

  it("runs when no changed-file list is available", () => {
    expect(isMacosRelevant([])).toBe(true);
    expect(isMacosRelevant(["", "  "])).toBe(true);
  });

  it("runs for every file a Rust source compiles in with include_str!/include_bytes!", () => {
    // A Rust test that embeds a file outside the patterns would keep passing
    // on a PR that breaks it, because the macOS gate would be skipped.
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const sources = execFileSync(
      "git",
      ["ls-files", "--", "*.rs"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    const embedded = new Set<string>();

    for (const source of sources) {
      const text = readFileSync(resolve(root, source), "utf8");
      for (const match of text.matchAll(
        /include_(?:str|bytes)!\(\s*"([^"]+)"\s*\)/g,
      )) {
        const target = relative(root, resolve(root, dirname(source), match[1]));
        if (!target.startsWith("..")) embedded.add(target.split(sep).join("/"));
      }
    }

    expect(embedded.size).toBeGreaterThan(0);
    for (const target of embedded) {
      expect(isMacosRelevant([target]), target).toBe(true);
    }
  });

  it("pins the pattern list", () => {
    expect(MACOS_RELEVANT_PATTERNS).toEqual([
      "**/src-tauri/**",
      "apps/sync/sidecar/**",
      "crates/**",
      ".cargo/**",
      "**/Cargo.toml",
      "**/Cargo.lock",
      "rust-toolchain*",
      "**/build.rs",
      "**/*.rs",
      "**/*.swift",
      "**/*.m",
      "**/*.mm",
      "**/*.h",
      "apps/sync/src/components/onboarding/welcome/welcome.css",
      ".github/workflows/release.yml",
      ".github/workflows/ci.yml",
      "scripts/macos-check-relevant.mjs",
    ]);
  });
});
