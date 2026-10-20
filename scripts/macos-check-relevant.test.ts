import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, posix, relative, resolve, sep } from "node:path";
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
      "imports/hq-sync-win/scripts/replace-rescue.sh",
      "apps/sync/package.json",
      "packages/ui/src/settings/__fixtures__/storage/status.json",
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

  it("runs for every tracked file a Rust source reads through a literal CARGO_MANIFEST_DIR path", () => {
    // Rust tests also read files at run time through paths built from
    // env!("CARGO_MANIFEST_DIR"). Two literal forms are resolved here:
    //   concat!(env!("CARGO_MANIFEST_DIR"), "/lit")
    //   Path::new(env!("CARGO_MANIFEST_DIR")).join("a").join("b")
    //     (also PathBuf::from(...)), stopping at the first non-literal join
    // Each resolves against the crate dir (nearest ancestor with Cargo.toml).
    // A directory target is expanded to the tracked files under it.
    // Forms that cannot be resolved statically are skipped, currently:
    //   compat.rs manifest_dir().join(...) helper (reads capabilities/*.json
    //     and src/main.rs inside src-tauri, already covered)
    //   join(name) / format!("{FIXTURES}{name}") tails with a runtime argument
    //     (the literal prefix before them is still checked)
    //   build.rs std::env::var("CARGO_MANIFEST_DIR") (runtime env, and
    //     build.rs plus its inputs are covered separately)
    // Targets with no tracked files (for example apps/sync/dist) are ignored.
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" })
        .split("\n")
        .filter(Boolean);
    const sources = git(["ls-files", "--", "*.rs"]);
    const crateDir = (source: string) => {
      let dir = posix.dirname(source);
      while (dir !== "." && !existsSync(resolve(root, dir, "Cargo.toml"))) {
        dir = posix.dirname(dir);
      }
      return dir;
    };
    const MANIFEST = String.raw`env!\(\s*"CARGO_MANIFEST_DIR"\s*\)`;
    const concatForm = new RegExp(
      String.raw`concat!\(\s*${MANIFEST}\s*,\s*"([^"]*)"\s*,?\s*\)`,
      "g",
    );
    const joinForm = new RegExp(
      String.raw`(?:Path::new|PathBuf::from)\(\s*${MANIFEST}\s*\)((?:\s*\.join\(\s*"[^"]*"\s*\))*)`,
      "g",
    );
    const resolved = new Map<string, string>();

    for (const source of sources) {
      const text = readFileSync(resolve(root, source), "utf8");
      const crate = crateDir(source);
      const add = (suffix: string) => {
        const target = posix.normalize(posix.join(crate, suffix));
        if (!target.startsWith("..")) {
          resolved.set(target.replace(/\/$/, ""), source);
        }
      };
      for (const match of text.matchAll(concatForm)) add(match[1]);
      for (const match of text.matchAll(joinForm)) {
        const parts = [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
        add(parts.join("/"));
      }
    }

    expect(resolved.get("packages/ui/src/settings/__fixtures__/storage")).toBe(
      "apps/sync/src-tauri/src/commands/storage.rs",
    );
    for (const [target, source] of resolved) {
      for (const file of git(["ls-files", "--", target])) {
        expect(isMacosRelevant([file]), `${file} (read by ${source})`).toBe(
          true,
        );
      }
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
      "imports/**",
      "apps/sync/package.json",
      "packages/ui/src/settings/__fixtures__/storage/**",
    ]);
  });
});
