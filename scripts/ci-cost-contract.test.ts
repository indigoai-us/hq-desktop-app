// Contract tests for the CI runner-cost invariants.
//
// GitHub bills macOS minutes at 10x and Windows at 2x a Linux minute, so the
// three rules asserted here are what keep the PR gate affordable:
//
//   1. Every PR-triggered workflow cancels superseded runs. Without a
//      concurrency group, a branch that is pushed to N times leaves N-1 full
//      Windows runs executing against commits nobody will merge.
//   2. The Windows jobs cache Rust artifacts with Swatinem/rust-cache, which
//      prunes to registry + dependency artifacts. Caching a raw `target/`
//      directory with actions/cache produces multi-GB entries that evict each
//      other out of the repository's 10 GB cache budget, so every run compiles
//      cold while still paying to upload the archive.
//   3. Work that is not macOS-specific runs on ubuntu-latest. Only the Tauri
//      app crate and the real-child process regressions need a macOS runner.
//
// These are shape assertions over the workflow YAML, in the same style as
// release-workflow.test.ts, so a regression fails the frontend job (which is
// cheap) instead of silently costing runner minutes.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let ciWorkflow = "";
let windowsCheckWorkflow = "";

beforeAll(async () => {
  [ciWorkflow, windowsCheckWorkflow] = await Promise.all([
    readFile(resolve(rootDir, ".github/workflows/ci.yml"), "utf8"),
    readFile(resolve(rootDir, ".github/workflows/windows-check.yml"), "utf8"),
  ]);
});

/** Slice one top-level `jobs:` entry out of a workflow document. */
function jobBody(workflow: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `\\n  ${escaped}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:\\n|$)`,
  ).exec(workflow);

  if (!match) {
    throw new Error(`workflow is missing the ${name} job`);
  }

  return match[1];
}

/** The document preamble: everything above `jobs:`. */
function preamble(workflow: string): string {
  return workflow.slice(0, workflow.indexOf("\njobs:"));
}

describe("superseded runs are cancelled", () => {
  // A pull_request-triggered workflow with no concurrency group keeps running
  // after the branch moves on. Measured over 30 days, 153 of 689 windows-check
  // runs (22%) were still executing when a newer push superseded them.
  for (const [label, get] of [
    ["ci", () => ciWorkflow],
    ["windows-check", () => windowsCheckWorkflow],
  ] as const) {
    it(`${label} declares a per-ref concurrency group that cancels in progress`, () => {
      const head = preamble(get());

      expect(head).toMatch(/\nconcurrency:\n/);
      expect(head).toContain(
        "group: ${{ github.workflow }}-${{ github.ref }}",
      );
      expect(head).toContain("cancel-in-progress: true");
    });
  }
});

describe("windows jobs cache Rust artifacts with rust-cache", () => {
  const windowsJobs = ["windows-check", "windows-installer-e2e"] as const;

  it("never caches a raw target/ directory with actions/cache", () => {
    // actions/cache has no pruning: it archives every intermediate artifact in
    // target/, which for this Tauri app is several GB per entry.
    expect(windowsCheckWorkflow).not.toContain("uses: actions/cache@");
    expect(windowsCheckWorkflow).not.toContain("apps/sync/src-tauri/target\n");
  });

  for (const job of windowsJobs) {
    it(`${job} restores through Swatinem/rust-cache`, () => {
      expect(jobBody(windowsCheckWorkflow, job)).toContain(
        "uses: Swatinem/rust-cache@v2",
      );
    });

    it(`${job} caches the root workspace and the app workspace`, () => {
      // The previous actions/cache key hashed only the app Cargo.lock and
      // cached only the app target/, so a root-workspace change neither
      // invalidated the cache nor got its artifacts reused.
      const body = jobBody(windowsCheckWorkflow, job);

      expect(body).toContain("workspaces: |");
      expect(body).toMatch(/workspaces: \|\n\s+\.\n\s+apps\/sync\/src-tauri\n/);
    });
  }

  it("gives the check and installer jobs disjoint cache keys", () => {
    // The check job builds the debug profile; the installer job builds
    // release. Sharing a key (or a restore-keys fallback across them) makes
    // each job restore the other's profile and rebuild from scratch anyway.
    const check = jobBody(windowsCheckWorkflow, "windows-check");
    const installer = jobBody(windowsCheckWorkflow, "windows-installer-e2e");

    const keyOf = (body: string) => /\n\s+key: (\S+)\n/.exec(body)?.[1];

    expect(keyOf(check)).toBeDefined();
    expect(keyOf(installer)).toBeDefined();
    expect(keyOf(check)).not.toEqual(keyOf(installer));
  });
});

describe("only macOS-specific work runs on a macOS runner", () => {
  it("runs the shared root-workspace crates on ubuntu-latest", () => {
    // hq-desktop-core declares its Unix deps under
    // cfg(any(target_os = "macos", target_os = "linux")) and hq-telemetry is
    // pure Rust, so the root workspace does not need a 10x runner.
    const linux = jobBody(ciWorkflow, "rust-linux");

    expect(linux).toContain("runs-on: ubuntu-latest");
    expect(linux).toContain("cargo test --workspace --locked");
    expect(linux).toContain("cargo check --workspace --locked");
  });

  it("keeps the root-workspace crates off the macOS runner", () => {
    const macos = jobBody(ciWorkflow, "rust-macos");

    expect(macos).toContain("runs-on: macos-latest");
    expect(macos).not.toContain("cargo test --workspace --locked");
    expect(macos).not.toContain("cargo check --workspace --locked");
  });

  it("keeps the Tauri app crate and the real-child regressions on macOS", () => {
    // These are the jobs that genuinely need the shipping platform: the app
    // crate is the macOS Tauri binary, and the escalation suite asserts real
    // SIGKILL propagation across a process tree.
    const macos = jobBody(ciWorkflow, "rust-macos");

    expect(macos).toContain("working-directory: apps/sync/src-tauri");
    expect(macos).toContain("cargo test --locked");
    expect(macos).toContain(
      "cargo test --locked commands::process::cross_generation_escalation_tests",
    );
  });

  it("runs rustfmt on Linux rather than on the macOS runner", () => {
    // cargo fmt needs no compilation, so it has no reason to occupy a 10x
    // runner. clippy stays on macOS because it has to build the Tauri app.
    const linux = jobBody(ciWorkflow, "rust-linux");
    const macos = jobBody(ciWorkflow, "rust-macos");

    expect(linux).toContain("cargo fmt --check");
    expect(macos).not.toContain("cargo fmt --check");
  });

  it("keeps the macOS job named as the required status check", () => {
    // "Rust tests (macOS)" is listed in the required_status_checks of the
    // active `main` ruleset. A job rename makes that context never report, so
    // every PR sits unmergeable waiting on a check that no longer exists.
    // Renaming is fine — but the ruleset has to change in the same breath.
    expect(ciWorkflow).toContain("name: Rust tests (macOS)");
  });

  it("gates the new Linux job on the same draft-PR guard as its siblings", () => {
    // Every CI job skips draft PRs; a new job that forgets the guard
    // reintroduces the cost the draft skip was added to remove.
    const linux = jobBody(ciWorkflow, "rust-linux");

    expect(linux).toContain(
      "if: ${{ github.event_name != 'pull_request' || github.event.pull_request.draft == false }}",
    );
  });
});
