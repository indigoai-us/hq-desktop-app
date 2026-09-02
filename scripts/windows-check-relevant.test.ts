// The Windows gate's relevance matcher, and the workflow shape that makes its
// two REQUIRED checks reachable.
//
// Both jobs in windows-check.yml are required status checks on `main`. When the
// workflow carried a `paths:` trigger filter, any pull request outside that
// list left both contexts pending forever — GitHub never reports a status for a
// workflow that path filtering prevented from triggering, so branch protection
// blocks the PR with nothing to fix. Observed on PR #524, which touched only
// `.githooks/`, `scripts/`, `docs/`, and `package.json`.
//
// The fix is to always trigger and skip the jobs via a job-level `if:`, which
// GitHub reports as Success. These tests pin both halves: the matcher's
// decisions, and the workflow wiring that depends on them.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import {
  WINDOWS_RELEVANT_PATTERNS,
  isWindowsRelevant,
} from "./windows-check-relevant.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(rootDir, "scripts/windows-check-relevant.mjs");
const watchdogScriptPath = resolve(
  rootDir,
  "scripts/windows-test-watchdog.ps1",
);

let workflow = "";
let watchdogScript = "";

beforeAll(async () => {
  workflow = await readFile(
    resolve(rootDir, ".github/workflows/windows-check.yml"),
    "utf8",
  );
  watchdogScript = await readFile(watchdogScriptPath, "utf8");
});

describe("paths that need the Windows gate", () => {
  const relevant = [
    "apps/sync/src-tauri/src/main.rs",
    "apps/sync/src-tauri/tauri.windows.conf.json",
    "apps/sync/src-tauri/icons/icon.ico",
    "apps/sync/sidecar/recall-sdk-bridge/package.json",
    "apps/sync/e2e/desktop-alt/live-preauth.spec.ts",
    "apps/sync/package.json",
    "apps/sync/pnpm-lock.yaml",
    "crates/hq-desktop-core/src/paths.rs",
    "imports/hq-installer-react/src/App.tsx",
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "versions.toml",
    "scripts/release-asset-contract.mjs",
    "scripts/release-stable-order.test.ts",
    "scripts/windows-msi-version.mjs",
    "scripts/windows-msi-version.test.ts",
    "scripts/windows-check-relevant.mjs",
    "scripts/windows-test-watchdog.ps1",
    ".github/workflows/release.yml",
    ".github/workflows/windows-check.yml",
    "workspace/evidence/run-1/log.txt",
  ];

  it.each(relevant)("runs the gate for %s", (path) => {
    expect(isWindowsRelevant([path])).toBe(true);
  });
});

describe("paths that do not need the Windows gate", () => {
  const irrelevant = [
    ".githooks/pre-push",
    "scripts/pre-push-tag-cooldown.test.ts",
    "scripts/version-app.ts",
    "docs/RELEASE.md",
    "package.json",
    "README.md",
    ".github/workflows/ci.yml",
    "reports/whatever.md",
    "apps/sync/src/App.svelte",
    "apps/sync/src/lib/stores/auth.ts",
    "apps/sync/__tests__/stories/US-001.test.ts",
    "apps/sync/scripts/create-dmg.sh",
    "apps/sync/desktop-alt.html",
    "apps/sync/.claude/CLAUDE.md",
  ];

  it.each(irrelevant)("skips the gate for %s", (path) => {
    expect(isWindowsRelevant([path])).toBe(false);
  });

  it("skips a whole changeset of irrelevant paths", () => {
    expect(isWindowsRelevant(irrelevant)).toBe(false);
  });

  it("runs the gate when one relevant path rides along", () => {
    expect(isWindowsRelevant([...irrelevant, "crates/x/src/lib.rs"])).toBe(true);
  });
});

describe("unknown input runs the gate rather than skipping it", () => {
  // Skipping a required platform gate on unknown input would let a Windows
  // regression merge green. Every ambiguous case has to fail toward running.
  it("runs the gate for an empty list", () => {
    expect(isWindowsRelevant([])).toBe(true);
  });

  it("runs the gate for a list of blank lines", () => {
    expect(isWindowsRelevant(["", "  ", "\n"])).toBe(true);
  });
});

describe("pattern matching is anchored", () => {
  it("does not match a prefix of a directory name", () => {
    expect(isWindowsRelevant(["cratesfoo/x.rs"])).toBe(false);
    expect(isWindowsRelevant(["apps/syncthing/x.ts"])).toBe(false);
  });

  it("does not let a single * cross a path separator", () => {
    expect(isWindowsRelevant(["scripts/release-a/b.mjs"])).toBe(false);
  });

  it("does not match a suffix of an exact-file pattern", () => {
    expect(isWindowsRelevant(["apps/sync/src-tauri/Cargo.toml"])).toBe(true);
    expect(isWindowsRelevant(["vendor/Cargo.toml"])).toBe(false);
  });
});

describe("the CLI entrypoint", () => {
  function run(stdin: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = execFile(
        process.execPath,
        [scriptPath],
        { cwd: rootDir },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolvePromise(stdout);
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(stdin);
    });
  }

  it("prints true for a relevant changeset", async () => {
    expect(await run("docs/RELEASE.md\ncrates/a/src/lib.rs\n")).toBe("true");
  });

  it("prints false for an irrelevant changeset", async () => {
    expect(await run(".githooks/pre-push\ndocs/RELEASE.md\n")).toBe("false");
  });

  it("prints true for empty stdin", async () => {
    expect(await run("")).toBe("true");
  });
});

describe("the workflow keeps both required checks reachable", () => {
  it("does not path-filter the pull_request trigger", () => {
    const trigger = workflow.slice(
      workflow.indexOf("\non:"),
      workflow.indexOf("\nconcurrency:"),
    );
    // A `paths:` filter here is what makes a required check unmergeable.
    expect(trigger).not.toMatch(/^\s+paths:/m);
    expect(trigger).toContain("pull_request:");
  });

  it("gates every Windows job on the changes job", () => {
    // The installer gate is three jobs -- two parallel builds feeding the
    // required E2E context -- and all of them have to observe the same gate,
    // or a skipped PR pays for a Windows build it decided it did not need.
    for (const job of [
      "windows-check",
      "build-bridge-installers",
      "build-target-updater",
      "windows-installer-e2e",
    ]) {
      const body = workflow.slice(
        workflow.indexOf(`\n  ${job}:\n`),
        workflow.indexOf("\n    steps:", workflow.indexOf(`\n  ${job}:\n`)),
      );
      expect(body, `${job} must depend on the changes job`).toMatch(
        /needs: (changes\n|\[changes,)/,
      );
      expect(body, `${job} must skip when the gate does not apply`).toContain(
        "needs.changes.outputs.windows == 'true'",
      );
    }
  });

  it("keeps the draft exclusion on every gated job", () => {
    const drafts = workflow.match(/github\.event\.pull_request\.draft == false/g);
    expect(drafts).toHaveLength(4);
  });

  it("runs the relevance decision on a cheap runner", () => {
    const body = workflow.slice(
      workflow.indexOf("\n  changes:\n"),
      workflow.indexOf("\n  windows-check:\n"),
    );
    expect(body).toContain("runs-on: ubuntu-latest");
    expect(body).toContain("scripts/windows-check-relevant.mjs");
  });

  it("names the jobs exactly as branch protection requires them", () => {
    // Renaming either job silently orphans the required context.
    expect(workflow).toContain("name: cargo check (x86_64-pc-windows-msvc)");
    expect(workflow).toContain("name: installer E2E (x64 MSI + NSIS)");
  });

  it("pins the exact relevance list", () => {
    expect(WINDOWS_RELEVANT_PATTERNS).toEqual([
      "apps/sync/src-tauri/**",
      "apps/sync/sidecar/**",
      "apps/sync/e2e/desktop-alt/**",
      "apps/sync/package.json",
      "apps/sync/pnpm-lock.yaml",
      "apps/sync/pnpm-workspace.yaml",
      "imports/hq-installer-react/**",
      "crates/**",
      "Cargo.toml",
      "Cargo.lock",
      "rust-toolchain.toml",
      "versions.toml",
      "scripts/release-*.mjs",
      "scripts/release-*.test.ts",
      "scripts/windows-*.mjs",
      "scripts/windows-*.test.ts",
      "scripts/windows-*.ps1",
      ".github/workflows/release.yml",
      ".github/workflows/windows-check.yml",
      "workspace/evidence/**",
    ]);
  });
});

describe("the Windows test process-tree watchdog", () => {
  it("runs the complete pre-built Windows binary suite with live diagnostics", () => {
    expect(watchdogScript).toContain('"test",');
    expect(watchdogScript).toContain('"--target",');
    expect(watchdogScript).toContain('"x86_64-pc-windows-msvc",');
    expect(watchdogScript).toContain('"--bins"');
    expect(watchdogScript).not.toContain("--no-run");
    expect(watchdogScript).toMatch(
      /Start-Process -FilePath "cargo" -ArgumentList \$cargoArguments -NoNewWindow -PassThru/,
    );
    expect(watchdogScript).not.toContain("RedirectStandardOutput");
    expect(watchdogScript).not.toContain("RedirectStandardError");
  });

  it("returns cargo's actual exit code when the suite finishes before the deadline", () => {
    expect(watchdogScript).toContain(
      "if ($cargo.WaitForExit($TimeoutSeconds * 1000)) {",
    );
    expect(watchdogScript).toContain("exit $cargo.ExitCode");
  });

  it("kills cargo and its complete descendant tree before failing on deadline", () => {
    expect(watchdogScript).toContain("& taskkill.exe /PID $cargo.Id /T /F");
    expect(watchdogScript).toContain("$cargo.WaitForExit(30000)");
    // PowerShell does not allow digit separators such as `30_000`.
    expect(watchdogScript).not.toMatch(/(?<![A-Za-z0-9])\d+_\d+/);
    expect(watchdogScript).toContain("$taskkillExitCode -ne 0");
    expect(watchdogScript).toContain("process-tree deadline");
    expect(watchdogScript).toContain("exit 1");
  });

  it("makes the five-minute watchdog deadline explicit while retaining an outer guard", () => {
    const executionStepStart = workflow.indexOf(
      "\n      - name: Windows tests (process-tree watchdog)\n",
    );
    const executionStep = workflow.slice(
      executionStepStart,
      workflow.indexOf("\n\n", executionStepStart),
    );

    expect(executionStep).toContain("timeout-minutes: 7");
    expect(executionStep).toContain("working-directory: apps/sync/src-tauri");
    expect(executionStep).toContain("shell: pwsh");
    expect(executionStep).toContain(
      '& "$env:GITHUB_WORKSPACE/scripts/windows-test-watchdog.ps1" -TimeoutSeconds 300',
    );
  });

  it("keeps the compile and link gate separate with its 30-minute deadline", () => {
    const buildStepStart = workflow.indexOf(
      "\n      - name: Build Windows test binaries\n",
    );
    const buildStep = workflow.slice(
      buildStepStart,
      workflow.indexOf("\n\n", buildStepStart),
    );

    expect(buildStep).toContain("timeout-minutes: 30");
    expect(buildStep).toContain(
      "cargo test --target x86_64-pc-windows-msvc --bins --no-run",
    );
  });
});
