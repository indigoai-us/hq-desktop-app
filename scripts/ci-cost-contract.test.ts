// Contract tests for the CI runner-cost invariants.
//
// This repository is public, so GitHub's standard runners are free and the 10x
// macOS / 2x Windows minute multipliers -- which this comment used to cite as
// the reason for all of it -- are never applied to anything here. The costs
// that are real are the wall clock a contributor waits on a required check,
// and the repository's 10 GB Actions cache budget, which every branch shares
// and which is currently close to full. The three rules asserted here defend
// those:
//
//   1. Every PR-triggered workflow cancels superseded runs. Without a
//      concurrency group, a branch that is pushed to N times leaves N-1 full
//      Windows runs executing against commits nobody will merge, holding
//      concurrency slots the runs people are waiting on then queue behind.
//   2. The Windows jobs cache Rust artifacts with Swatinem/rust-cache, which
//      prunes to registry + dependency artifacts. Caching a raw `target/`
//      directory with actions/cache produces multi-GB entries that evict each
//      other out of the 10 GB budget, so every run compiles cold -- and takes
//      the eviction out on every other branch's entries too.
//   3. Work that is not macOS-specific runs on ubuntu-latest. Only the Tauri
//      app crate and the real-child process regressions need a macOS runner;
//      macOS runners are the scarcest pool and the slowest to be assigned.
//
// These are shape assertions over the workflow YAML, in the same style as
// release-workflow.test.ts, so a regression fails the frontend job (which is
// fast) instead of silently costing everyone minutes.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let ciWorkflow = "";
let windowsCheckWorkflow = "";
let releaseWorkflow = "";
let fixtureProfile = "";
let appManifest = "";

beforeAll(async () => {
  [
    ciWorkflow,
    windowsCheckWorkflow,
    releaseWorkflow,
    fixtureProfile,
    appManifest,
  ] = await Promise.all([
    readFile(resolve(rootDir, ".github/workflows/ci.yml"), "utf8"),
    readFile(resolve(rootDir, ".github/workflows/windows-check.yml"), "utf8"),
    readFile(resolve(rootDir, ".github/workflows/release.yml"), "utf8"),
    readFile(
      resolve(rootDir, "apps/sync/src-tauri/ci/fixture-profile.toml"),
      "utf8",
    ),
    readFile(resolve(rootDir, "apps/sync/src-tauri/Cargo.toml"), "utf8"),
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

/**
 * A job body with its comments stripped.
 *
 * `jobBody` slices to the next job key, so the comment block introducing the
 * NEXT job lands at the end of the previous one's text. Negative assertions
 * ("this job must not build the app") have to read configuration, not prose --
 * otherwise a comment that merely mentions a sibling fails the test, and the
 * fix would be to stop explaining things.
 */
function jobConfig(workflow: string, name: string): string {
  return jobBody(workflow, name)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

/** Every top-level job key, discovered rather than listed. */
function jobNames(workflow: string): string[] {
  const jobs = workflow.slice(workflow.indexOf("\njobs:"));

  return [...jobs.matchAll(/\n {2}([a-zA-Z0-9_-]+):\n/g)].map((m) => m[1]);
}

describe("every job declares a job-level timeout", () => {
  // A job with no `timeout-minutes` inherits the Actions default of 360
  // minutes. That is not a cost ceiling, it is the absence of one: a blocked
  // step holds a runner -- and, for a required check, the merge -- for six
  // hours while reporting nothing but "in progress".
  //
  // This is not hypothetical. windows-check was the one long-running job in
  // the repository that never got a job-level timeout, even though its three
  // siblings in the same file declare 45, 45 and 30, and 30 of its 46 steps
  // carry no step timeout either. Run 33624196971 blocked on "Windows app
  // tests (e2e automation)" -- a step whose healthy duration is about two
  // minutes -- and was still sitting there an hour later with nothing
  // scheduled to end it.
  //
  // The list is discovered from the document rather than hard-coded, because
  // the gap arrived with a job that predated the convention: a fixed list
  // would let the next such job through the same hole.
  for (const [label, get] of [
    ["ci", () => ciWorkflow],
    ["windows-check", () => windowsCheckWorkflow],
  ] as const) {
    it(`${label} gives every job a timeout-minutes`, () => {
      const workflow = get();
      const missing = jobNames(workflow).filter(
        // Four spaces pins this to the job mapping. Step timeouts nest deeper,
        // and matching those would let a job pass on a step's declaration.
        (name) => !/\n {4}timeout-minutes: \d+\n/.test(jobBody(workflow, name)),
      );

      expect(missing).toEqual([]);
    });

    it(`${label} keeps every timeout under the six-hour default`, () => {
      // A timeout at or above the default is decoration -- it changes nothing
      // about when a hung job stops.
      const workflow = get();
      const overrun = jobNames(workflow)
        .map((name) => ({
          name,
          minutes: Number(
            /\n {4}timeout-minutes: (\d+)\n/.exec(jobBody(workflow, name))?.[1],
          ),
        }))
        .filter((job) => !(job.minutes < 360));

      expect(overrun).toEqual([]);
    });
  }
});

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
      expect(head).toContain("group: ${{ github.workflow }}-${{ github.ref }}");
      expect(head).toContain("cancel-in-progress: true");
    });
  }
});

describe("windows jobs cache Rust artifacts with rust-cache", () => {
  // Every Windows job that actually compiles. Two are deliberately absent:
  // windows-installer-e2e consumes prebuilt installers plus a prebuilt
  // tauri-driver.exe as artifacts and runs no cargo at all, and windows-check
  // is now an ubuntu adjudicator over the three jobs below. Restoring a
  // multi-GB dependency cache into either would be pure download time.
  const windowsJobs = [
    "windows-check-crates",
    "windows-check-app",
    "windows-check-live",
    "build-bridge-installers",
    "build-target-updater",
  ] as const;

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

  for (const job of windowsJobs) {
    it(`${job} still saves its cache when the job fails`, () => {
      // rust-cache defaults cache-on-failure:false. windows-check is red about
      // 15% of the time (100 of 688 runs over 30 days) and its workflow header
      // says it is expected to be red during the Phase 3 port -- but the
      // compile that fills the cache runs BEFORE the tests that fail, so those
      // artifacts are valid. Discarding them means the next run starts cold.
      expect(jobBody(windowsCheckWorkflow, job)).toContain(
        "cache-on-failure: true",
      );
    });
  }

  const keyOf = (body: string) => /\n\s+shared-key: (\S+)\n/.exec(body)?.[1];

  it("gives the check and installer jobs disjoint cache keys", () => {
    // The check job builds the debug profile; the installer builds release.
    // Sharing a key (or a restore-keys fallback across them) makes each job
    // restore the other's profile and rebuild from scratch anyway.
    const check = jobBody(windowsCheckWorkflow, "windows-check-app");
    const installer = jobBody(windowsCheckWorkflow, "build-bridge-installers");

    expect(keyOf(check)).toBeDefined();
    expect(keyOf(installer)).toBeDefined();
    expect(keyOf(check)).not.toEqual(keyOf(installer));
  });

  it("lets exactly one of the three check jobs write the shared entry", () => {
    // The three run in parallel off one debug profile and one set of
    // lockfiles, so rust-cache computes the same key for all of them. Two
    // writers race for one entry; three keys would triple the footprint
    // against the same 10 GB repo budget. windows-check-app owns the write
    // because it builds the default-feature app bins the other two either
    // do not need or cannot share.
    const jobs = [
      "windows-check-crates",
      "windows-check-app",
      "windows-check-live",
    ] as const;
    const bodies = jobs.map((job) => jobBody(windowsCheckWorkflow, job));

    expect(new Set(bodies.map(keyOf)).size).toBe(1);
    expect(bodies.filter((body) => !body.includes("save-if: false"))).toEqual([
      jobBody(windowsCheckWorkflow, "windows-check-app"),
    ]);
  });

  it("lets exactly one of the two release builds write the shared entry", () => {
    // The two installer builds run in parallel off the same profile, the same
    // lockfiles and the same RUST*/CARGO* env, so rust-cache computes an
    // identical key for both. Two writers just race for one entry; a second
    // shared-key would double the footprint against an already-oversubscribed
    // 10 GB repo budget. One writer, one reader.
    const bridge = jobBody(windowsCheckWorkflow, "build-bridge-installers");
    const target = jobBody(windowsCheckWorkflow, "build-target-updater");

    expect(keyOf(bridge)).toEqual(keyOf(target));
    expect(bridge).not.toContain("save-if:");
    expect(target).toContain("save-if: false");
  });
});

describe("the windows check splits its suite across three jobs", () => {
  // One 46-step job called `cargo check` took 24m13s on run 33634531610 while
  // the installer chain beside it took 17m, so this gate -- not the release
  // builds -- set how long a PR waited. None of its steps consumed another's
  // output; they were serial only because they shared a runner.
  const checkJobs = [
    "windows-check-crates",
    "windows-check-app",
    "windows-check-live",
  ] as const;

  it("runs the three jobs in parallel off the path gate", () => {
    // Any of them depending on another reintroduces a serial critical path.
    for (const job of checkJobs) {
      const body = jobConfig(windowsCheckWorkflow, job);

      expect(body).toContain("needs: changes");
      for (const sibling of checkJobs.filter((name) => name !== job)) {
        expect(body).not.toContain(sibling);
      }
    }
  });

  it("keeps the required status check reporting under its old name", () => {
    // "cargo check (x86_64-pc-windows-msvc)" is in the required_status_checks
    // of the active `main` ruleset. Retiring that context leaves every PR
    // waiting forever on a check that no longer reports.
    expect(windowsCheckWorkflow).toContain(
      "name: cargo check (x86_64-pc-windows-msvc)",
    );
    expect(jobBody(windowsCheckWorkflow, "windows-check")).toContain(
      "runs-on: ubuntu-latest",
    );
  });

  it("fails that check when any of the three did not succeed", () => {
    // Same trap as windows-installer-e2e: GitHub reports a SKIPPED required
    // check as satisfied, so a job skipped because its `needs` failed is
    // indistinguishable from one skipped by the path gate, and a red suite
    // would merge green. always() starts the adjudicator anyway.
    const gate = jobBody(windowsCheckWorkflow, "windows-check");

    expect(gate).toContain("if: ${{ always() &&");
    expect(gate).toContain("needs.changes.outputs.windows == 'true'");

    for (const job of checkJobs) {
      expect(gate).toContain(`needs.${job}.result != 'success'`);
    }

    // The guard has to be the job's only real work, before anything that
    // could pass or fail for its own reasons.
    const steps = gate.slice(gate.indexOf("\n    steps:"));
    expect(steps).toContain("Fail when a Windows check job did not succeed");
  });

  it("keeps the non-test compile check alongside the test-binary build", () => {
    // `cargo check` compiles in non-test mode and `cargo test --no-run` in
    // test mode, so they are not duplicates: dropping the former would stop
    // anything from catching a #[cfg(not(test))] block that fails to compile.
    const app = jobBody(windowsCheckWorkflow, "windows-check-app");

    expect(app).toContain("cargo check --target x86_64-pc-windows-msvc");
    expect(app).toContain(
      "cargo test --target x86_64-pc-windows-msvc --bins --no-run",
    );
  });

  it("keeps the feature-flagged builds off the default-feature job", () => {
    // Changing cargo features invalidates the dependency graph. Splitting
    // these across jobs would make each one recompile what the other undid;
    // together on one runner the churn is confined.
    const app = jobConfig(windowsCheckWorkflow, "windows-check-app");
    const live = jobConfig(windowsCheckWorkflow, "windows-check-live");

    expect(app).not.toContain("--features");
    expect(live).toContain("--features sync-cancel-probe");
    expect(live).toContain("--bins --features e2e-automation");
    expect(live).toContain("pnpm tauri build --debug");
  });

  it("keeps the crate job free of any app build", () => {
    // It runs the shared crates through --manifest-path only, so it needs
    // neither the Svelte bundle nor the tauri sidecar resources.
    const crates = jobConfig(windowsCheckWorkflow, "windows-check-crates");

    expect(crates).not.toContain("pnpm run build");
    expect(crates).not.toContain("sidecar:install");
    expect(crates).not.toContain("--bins");
  });
});

describe("the installer gate splits its two release builds", () => {
  // Both builds are mandatory -- windows-installer-e2e.ps1 asserts the upgraded
  // binary has a different SHA256 AND a ProductVersion matching the target, so
  // neither can be replaced by reinstalling the same artifact. They are also
  // independent, and running them back to back put ~22 minutes of compile on
  // the critical path of a required status check.
  it("runs the bridge and target builds in parallel", () => {
    const bridge = jobBody(windowsCheckWorkflow, "build-bridge-installers");
    const target = jobBody(windowsCheckWorkflow, "build-target-updater");

    // Either depending on the other reintroduces the serial critical path.
    expect(bridge).toContain("needs: changes");
    expect(bridge).not.toContain("build-target-updater");
    expect(target).toContain("needs: changes");
    expect(target).not.toContain("build-bridge-installers");
  });

  it("keeps the E2E job free of any Rust toolchain or cargo invocation", () => {
    // It consumes artifacts: two NSIS installers and tauri-driver.exe.
    const e2e = jobBody(windowsCheckWorkflow, "windows-installer-e2e");

    expect(e2e).not.toContain("dtolnay/rust-toolchain");
    expect(e2e).not.toContain("Swatinem/rust-cache");
    expect(e2e).not.toContain("cargo ");
    expect(e2e).toContain("uses: actions/download-artifact@v4");
  });

  it("fails the required check when a build job did not succeed", () => {
    // GitHub reports a required check that was SKIPPED as satisfied. A job
    // skipped because its `needs` failed is therefore indistinguishable from a
    // job skipped because the path gate said no -- and a broken installer build
    // would merge green. `always()` starts the job anyway so a guard step can
    // turn that into a real red.
    const e2e = jobBody(windowsCheckWorkflow, "windows-installer-e2e");

    expect(e2e).toContain("if: ${{ always() &&");
    expect(e2e).toContain(
      "if: ${{ needs.build-bridge-installers.result != 'success' || needs.build-target-updater.result != 'success' }}",
    );

    // The guard has to be the first step, before anything that could fail or
    // pass for its own reasons.
    const steps = e2e.slice(e2e.indexOf("\n    steps:"));
    expect(
      steps.indexOf("Fail when an installer build job did not succeed"),
    ).toBeLessThan(steps.indexOf("uses: actions/checkout@v4"));
  });

  it("writes the fixture cargo profile only after rust-cache has keyed", () => {
    // rust-cache hashes `**/.cargo/config.toml` into its key. Writing the
    // overlay before the action therefore forks a second multi-GB lane out of
    // a 10 GB budget every branch in the repository shares -- which is the
    // exact cost this file's rule 2 exists to prevent. Writing it after is
    // sound because of the scope invariant asserted in the next test, so these
    // two assertions have to be read together.
    for (const job of ["build-bridge-installers", "build-target-updater"]) {
      const body = jobConfig(windowsCheckWorkflow, job);
      const cache = body.indexOf("uses: Swatinem/rust-cache@v2");
      const apply = body.indexOf("name: Apply the CI fixture cargo profile");
      const build = body.indexOf("pnpm tauri build");

      expect(cache).toBeGreaterThan(-1);
      expect(apply).toBeGreaterThan(cache);
      expect(build).toBeGreaterThan(apply);
    }
  });

  it("scopes the fixture profile to a crate the cache never stores", () => {
    // rust-cache deletes workspace-member artifacts before saving, so
    // hq-sync-menubar is never in the cache and overriding it cannot make the
    // lane disagree with its own key. Every dependency still builds at the
    // profile's own opt-level. Widen this to a dependency and the lane starts
    // holding artifacts its key does not describe -- silently, for every job
    // that restores the shared key, release builds warmed from main included.
    const overridden = [
      ...fixtureProfile.matchAll(/^\[profile\.[^\]]*\]/gm),
    ].map((m) => m[0]);
    expect(overridden).toEqual(["[profile.release.package.hq-sync-menubar]"]);

    // Cargo accepts a package spec that matches nothing without so much as a
    // warning -- verified against cargo 1.x directly. A typo here would build
    // exactly as before and read as "the override bought us nothing", so the
    // name is checked against the manifest rather than trusted.
    const pkg = /^name = "(.+)"$/m.exec(appManifest)?.[1];
    expect(pkg).toBe("hq-sync-menubar");
    expect(overridden[0]).toBe(`[profile.release.package.${pkg}]`);

    // And it must not be checked in at a path cargo reads on its own, or it
    // stops being CI-only and starts shipping.
    expect(windowsCheckWorkflow).toContain(
      "Copy-Item -LiteralPath src-tauri/ci/fixture-profile.toml -Destination src-tauri/.cargo/config.toml",
    );
    expect(releaseWorkflow).not.toContain("fixture-profile.toml");
  });

  it("derives both synthetic versions from one tested script", () => {
    // The two build jobs never exchange the arithmetic -- each derives it on
    // its own runner. Divergence would surface as "installer was not produced"
    // with no hint that two jobs had computed different numbers.
    const bridge = jobBody(windowsCheckWorkflow, "build-bridge-installers");
    const target = jobBody(windowsCheckWorkflow, "build-target-updater");

    for (const body of [bridge, target]) {
      expect(body).toContain("node ../../scripts/windows-e2e-versions.mjs");
    }

    // And the E2E job reads them from the build job rather than recomputing.
    const e2e = jobBody(windowsCheckWorkflow, "windows-installer-e2e");
    expect(e2e).not.toContain("windows-e2e-versions.mjs");
    expect(e2e).toContain(
      "BRIDGE_VERSION: ${{ needs.build-bridge-installers.outputs.bridge }}",
    );
    expect(e2e).toContain(
      "TARGET_VERSION: ${{ needs.build-bridge-installers.outputs.target }}",
    );
  });
});

describe("only macOS-specific work runs on a macOS runner", () => {
  it("runs the two heavy shared crates on ubuntu-latest", () => {
    // hq-desktop-core declares its Unix deps under
    // cfg(any(target_os = "macos", target_os = "linux")) and hq-telemetry is
    // pure Rust, so neither needs a 10x runner -- or anything but rustc.
    const linux = jobBody(ciWorkflow, "rust-linux");

    expect(linux).toContain("runs-on: ubuntu-latest");
    expect(linux).toContain(
      "cargo test -p hq-desktop-core -p hq-telemetry --locked",
    );
  });

  it("keeps those crates' tests off the macOS runner", () => {
    const macos = jobBody(ciWorkflow, "rust-macos");

    expect(macos).toContain("runs-on: macos-latest");
    expect(macos).not.toContain("cargo test --workspace --locked");
    expect(macos).not.toContain("-p hq-desktop-core");
  });

  it("installs no system packages on the Linux job", () => {
    // hq-platform's window-vibrancy dependency links GTK3 on Linux. Installing
    // those headers pulled 100 packages, cost 2.5 of the job's 4.5 minutes, and
    // failed 2 of 3 runs when azure.archive.ubuntu.com stopped answering (runs
    // 32299864862 and 32302036015). Acquire timeouts do not help against an
    // unreachable mirror -- apt just fails faster, in a loop. The job must stay
    // free of any package manager so it cannot inherit that failure mode.
    const linux = jobBody(ciWorkflow, "rust-linux");

    expect(linux).not.toContain("apt-get");
    expect(linux).not.toContain("libgtk");
  });

  it("keeps hq-platform and the full workspace check on macOS", () => {
    // Both need window-vibrancy to link, which is exactly what rust-linux is
    // avoiding. Putting them anywhere else reintroduces the GTK dependency.
    const macos = jobBody(ciWorkflow, "rust-macos");

    expect(macos).toContain("cargo test -p hq-platform --locked");
    expect(macos).toContain("cargo check --workspace --locked");
  });

  it("keeps the Tauri app crate and the real-child regressions on macOS", () => {
    const macos = jobBody(ciWorkflow, "rust-macos");

    expect(macos).toContain("working-directory: apps/sync/src-tauri");
    expect(macos).toContain("cargo test --locked");
    expect(macos).toContain(
      "cargo test --locked commands::process::cross_generation_escalation_tests",
    );
  });

  it("runs rustfmt on Linux rather than on the macOS runner", () => {
    const linux = jobBody(ciWorkflow, "rust-linux");
    const macos = jobBody(ciWorkflow, "rust-macos");

    expect(linux).toContain("cargo fmt --check");
    expect(macos).not.toContain("cargo fmt --check");
  });

  it("keeps the macOS job named as the required status check", () => {
    // "Rust tests (macOS)" is listed in the required_status_checks of the
    // active `main` ruleset. A job rename makes that context never report, so
    // every PR sits unmergeable waiting on a check that no longer exists.
    expect(ciWorkflow).toContain("name: Rust tests (macOS)");
  });

  it("gates the Linux job on the same draft-PR guard as its siblings", () => {
    const linux = jobBody(ciWorkflow, "rust-linux");

    expect(linux).toContain(
      "if: ${{ github.event_name != 'pull_request' || github.event.pull_request.draft == false }}",
    );
  });
});
