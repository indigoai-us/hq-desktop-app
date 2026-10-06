import { describe, expect, it } from "vitest";
import {
  isMacosRelevant,
  MACOS_RELEVANT_PATTERNS,
} from "./macos-check-relevant.mjs";

describe("macOS Rust gate path scope", () => {
  it("runs for app, shared Rust, dependency, script, and workflow inputs", () => {
    for (const path of [
      "apps/sync/src-tauri/src/main.rs",
      "apps/sync/sidecar/package.json",
      "apps/work/src/App.svelte",
      "apps/intro/package.json",
      "packages/ui/src/Button.test.ts",
      "packages/core/src/index.ts",
      "crates/hq-desktop-core/src/lib.rs",
      "imports/hq-sync-win/src-tauri/src/main.rs",
      "Cargo.lock",
      "rust-toolchain.toml",
      "package.json",
      "pnpm-lock.yaml",
      "scripts/windows-check-relevant.mjs",
      ".github/workflows/ci.yml",
    ]) {
      expect(isMacosRelevant([path]), path).toBe(true);
    }
  });

  it("skips only changes outside the Rust job's inputs", () => {
    expect(
      isMacosRelevant([
        "CHANGELOG.md",
        "apps/intro/src/App.svelte",
        "docs/README.md",
        "e2e/README.md",
      ]),
    ).toBe(false);
  });

  it("fails open when no changed-file list is available", () => {
    expect(isMacosRelevant([])).toBe(true);
    expect(isMacosRelevant(["", "  "])).toBe(true);
  });

  it("keeps the source list broad enough to include project and CI inputs", () => {
    expect(MACOS_RELEVANT_PATTERNS).toEqual(
      expect.arrayContaining([
        "apps/sync/**",
        "apps/work/**",
        "apps/*/package.json",
        "packages/**",
        "crates/**",
        "imports/**",
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
        "versions.toml",
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "scripts/**",
        ".github/**",
      ]),
    );
  });
});
