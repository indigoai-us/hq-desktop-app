import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isWindowsRelevant } from "./windows-check-relevant.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let workflow = "";
let clientClassifier = "";
let windowsConfig = "";
let windowsCheckWorkflow = "";
let versionsToml = "";
let syncCargoToml = "";
let releaseDocs = "";
let requiredSurfaces = "";
let releasePolicyWorkdir = "";

beforeAll(async () => {
  [workflow, clientClassifier, windowsConfig, windowsCheckWorkflow, versionsToml, syncCargoToml, releaseDocs, requiredSurfaces] = await Promise.all([
    readFile(resolve(rootDir, ".github/workflows/release.yml"), "utf8"),
    readFile(resolve(rootDir, "crates/hq-desktop-core/src/release_channel.rs"), "utf8"),
    readFile(resolve(rootDir, "apps/sync/src-tauri/tauri.windows.conf.json"), "utf8"),
    readFile(resolve(rootDir, ".github/workflows/windows-check.yml"), "utf8"),
    readFile(resolve(rootDir, "versions.toml"), "utf8"),
    readFile(resolve(rootDir, "apps/sync/src-tauri/Cargo.toml"), "utf8"),
    readFile(resolve(rootDir, "docs/RELEASE.md"), "utf8"),
    readFile(resolve(rootDir, "scripts/release-required-surfaces.txt"), "utf8"),
  ]);
});

beforeAll(async () => {
  releasePolicyWorkdir = await mkdtemp(join(tmpdir(), "hq-release-policy-"));
});

afterAll(async () => {
  await rm(releasePolicyWorkdir, { recursive: true, force: true });
});

/**
 * Mirrors the workflow's own manifest parsing: strip `#` comments, trim, drop
 * blanks. Kept in step with the `while IFS= read -r surface` loop in the
 * "Enforce v1 desktop shell" step.
 */
function parseRequiredSurfaces(manifest: string): string[] {
  return manifest
    .split("\n")
    .map((line) => line.split("#")[0].trim())
    .filter((line) => line.length > 0);
}

function jobBody(name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `\\n  ${escaped}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:\\n|$)`,
  ).exec(workflow);

  if (!match) {
    throw new Error(`release workflow is missing the ${name} job`);
  }

  return match[1];
}

function stepBody(job: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `\\n      - name: ${escaped}\\n([\\s\\S]*?)(?=\\n      - name: |$)`,
  ).exec(job);

  if (!match) {
    throw new Error(`release workflow is missing the ${name} step`);
  }

  return match[1];
}

/** Extract the Bash source from the workflow step rather than duplicating it. */
function stepScript(job: string, name: string): string {
  const step = stepBody(job, name);
  const marker = "\n        run: |\n";
  const start = step.indexOf(marker);

  if (start === -1) {
    throw new Error(`release workflow step ${name} is missing its shell script`);
  }

  return step
    .slice(start + marker.length)
    .split("\n")
    .map((line) => (line === "" ? "" : line.replace(/^ {10}/, "")))
    .join("\n");
}

interface CommandResult {
  code: number;
  output: string;
}

function runCommand(
  cwd: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      args,
      { cwd, encoding: "utf8", env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }

        resolvePromise({
          code: typeof error?.code === "number" ? error.code : 0,
          output: `${stdout}${stderr}`,
        });
      },
    );
  });
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await runCommand(cwd, "git", args);

  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.output}`);
  }
}

interface ReleasePolicyCase {
  advanceMainAfterReleaseBranch?: boolean;
  branch: string;
  expectedCode: number;
  expectedOutput: string;
  name: string;
  prerelease: boolean;
  releaseBranch?: string;
  tagAtForkPoint?: boolean;
}

async function releasePolicyRepository(testCase: ReleasePolicyCase): Promise<{
  runner: string;
  tag: string;
}> {
  const repoRoot = await mkdtemp(join(releasePolicyWorkdir, "case-"));
  const origin = join(repoRoot, "origin.git");
  const source = join(repoRoot, "source");
  const runner = join(repoRoot, "runner");
  const tag = testCase.prerelease ? "v0.11.0-beta.1" : "v0.11.0";

  await git(repoRoot, "init", "--bare", "--quiet", origin);
  await git(repoRoot, "init", "--initial-branch=main", "--quiet", source);
  await git(source, "config", "user.email", "release-test@example.com");
  await git(source, "config", "user.name", "Release policy test");
  await writeFile(join(source, "release.txt"), "main\n");
  await git(source, "add", "release.txt");
  await git(source, "commit", "--quiet", "-m", "main");
  await git(source, "remote", "add", "origin", origin);
  await git(source, "push", "--quiet", "origin", "main");

  let tagPushed = false;
  if (testCase.tagAtForkPoint) {
    await git(source, "tag", "-a", tag, "-m", tag);
    await git(source, "push", "--quiet", "origin", `refs/tags/${tag}`);
    tagPushed = true;
  }

  if (testCase.releaseBranch) {
    await git(source, "switch", "--quiet", "-c", testCase.releaseBranch);
    await writeFile(join(source, "release.txt"), `${testCase.releaseBranch}\n`);
    await git(source, "add", "release.txt");
    await git(source, "commit", "--quiet", "-m", testCase.releaseBranch);
    await git(source, "push", "--quiet", "origin", `HEAD:refs/heads/${testCase.releaseBranch}`);
    await git(source, "switch", "--quiet", "main");

    if (testCase.advanceMainAfterReleaseBranch) {
      await writeFile(join(source, "release.txt"), "main after release branch\n");
      await git(source, "add", "release.txt");
      await git(source, "commit", "--quiet", "-m", "main after release branch");
      await git(source, "push", "--quiet", "origin", "main");
    }
  }

  if (testCase.branch !== "main" && testCase.branch !== testCase.releaseBranch) {
    await git(source, "switch", "--quiet", "-c", testCase.branch);
    await writeFile(join(source, "release.txt"), `${testCase.branch}\n`);
    await git(source, "add", "release.txt");
    await git(source, "commit", "--quiet", "-m", testCase.branch);
    await git(source, "push", "--quiet", "origin", `HEAD:refs/heads/${testCase.branch}`);
  }

  if (!tagPushed) {
    await git(source, "tag", "-a", tag, "-m", tag);
    await git(source, "push", "--quiet", "origin", `refs/tags/${tag}`);
  }

  // This deliberately has only the tag ref before the extracted workflow
  // script runs, matching a fresh checkout of a pushed tag. Its own fetch
  // must populate main and release/* before it can decide anything.
  await git(repoRoot, "init", "--quiet", runner);
  await git(runner, "remote", "add", "origin", origin);
  await git(runner, "fetch", "--quiet", "--no-tags", "origin", `refs/tags/${tag}:refs/tags/${tag}`);
  await git(runner, "checkout", "--quiet", "--detach", tag);

  return { runner, tag };
}

async function invokeReleasePolicy(testCase: ReleasePolicyCase): Promise<CommandResult> {
  const { runner, tag } = await releasePolicyRepository(testCase);
  const script = stepScript(jobBody("validate"), "Enforce release branch policy");

  return runCommand(runner, "bash", ["-c", script], {
    GITHUB_WORKSPACE: runner,
    TAG: tag,
    CHANNEL: testCase.prerelease ? "beta" : "stable",
    PRERELEASE: String(testCase.prerelease),
  });
}

function uploadArtifactStepBodies(job: string): string[] {
  return [...job.matchAll(
    /\n      - name: [^\n]+\n        uses: actions\/upload-artifact@v4\n([\s\S]*?)(?=\n      - (?:name|uses): |$)/g,
  )].map((match) => match[1]);
}

function classifierPatterns(): RegExp[] {
  const validate = jobBody("validate");
  return [...validate.matchAll(/\[\[ "\$TAG" =~ (\^\S+\$) \]\]/g)]
    .map((match) => new RegExp(match[1]));
}

describe("release workflow channel contract", () => {
  it("requires workflow_dispatch to name an existing strict release tag", () => {
    const dispatch = workflow.slice(0, workflow.indexOf("\njobs:"));

    expect(dispatch).toContain("workflow_dispatch:");
    expect(dispatch).toMatch(/tag:\n\s+description:.*Existing tag/);
    expect(dispatch).toMatch(/tag:[\s\S]*?required: true/);
    expect(jobBody("validate")).toContain(
      "ref: refs/tags/${{ steps.classify.outputs.tag }}",
    );
    expect(workflow).not.toContain("github.event.inputs.tag || github.ref");
  });

  it("accepts only the tag shapes understood by the Rust client classifier", () => {
    const patterns = classifierPatterns();
    const accepted = [
      "v0.10.35",
      "v0.10.35-beta.0",
      "v0.10.35-beta.1",
      "v0.10.35-beta.42",
      "v0.10.35-alpha.1",
    ];
    const rejected = [
      "0.10.35",
      "v0.10",
      "v0.10.35-beta",
      "v0.10.35-beta.x",
      "v0.10.35-beta.1.2",
      "v0.10.35-alpha",
      "v0.10.35-rc.1",
      "v0.10.35-pre.1",
      "v0.10.35-dev",
      "v0.10.35+manual",
      "v0.10.35-beta.1+manual",
      "v00.10.35",
      "v0.010.35",
      "v0.10.035",
      "v0.10.35-beta.01",
      "v0.10.35-alpha.00",
    ];

    expect(patterns.map((pattern) => pattern.source)).toEqual([
      "^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$",
      "^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)-beta\\.(0|[1-9][0-9]*)$",
      "^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)-alpha\\.(0|[1-9][0-9]*)$",
    ]);

    for (const tag of accepted) {
      expect(patterns.filter((pattern) => pattern.test(tag)), tag).toHaveLength(1);
    }
    for (const tag of rejected) {
      expect(patterns.some((pattern) => pattern.test(tag)), tag).toBe(false);
    }

    expect(clientClassifier).toContain("vX.Y.Z-beta.N");
    expect(clientClassifier).toContain("vX.Y.Z-alpha.N");
    expect(clientClassifier).toContain("tag.strip_prefix('v')?");
    expect(clientClassifier).toContain("if !version.build.is_empty()");
    expect(clientClassifier).toContain("if pre_ids.len() != 2");
    expect(clientClassifier).toContain('pre_ids[1].parse::<u64>()');
  });

  it("requires stable on main and alpha/beta prereleases on release branches", () => {
    const validate = jobBody("validate");

    // The policy fetches the only refs it trusts, so a tag checkout cannot
    // accidentally pass simply because its remote tracking refs are absent.
    expect(validate).toContain(
      'git -C "$GITHUB_WORKSPACE" fetch --no-tags origin',
    );
    expect(validate).toContain(
      '"+refs/heads/release/*:refs/remotes/origin/release/*"',
    );
    expect(validate).toContain(
      '"${TAG}^{commit}" refs/remotes/origin/main',
    );

    // The branch rule splits by channel, keyed off the classified prerelease
    // flag: stable must ship from main; alpha/beta need release/* containment.
    expect(validate).toContain('if [ "$PRERELEASE" = "true" ]; then');
    expect(validate).toContain('if [ "$ON_MAIN" = "true" ]; then');
    expect(validate).toMatch(/for-each-ref\s+\\\n\s+--format=.*\n\s+--contains=/);
    expect(validate).toContain(
      "Stable release tag $TAG is not contained in origin/main",
    );
    expect(validate).toContain(
      "alpha and beta prereleases must not be cut from main",
    );
    expect(validate).toContain(
      "promote this commit as a stable vX.Y.Z release instead",
    );
    expect(validate).toContain(
      "alpha and beta releases may only be cut from a release/* branch",
    );
    expect(validate).toContain("Release Managers team");

    // The check runs only on a fresh tag push. A workflow_dispatch retry of an
    // existing, immutable tag must not be re-gated by the branch policy.
    expect(validate).toMatch(
      /- name: Enforce release branch policy\n {8}if: \$\{\{ github\.event_name == 'push' \}\}/,
    );
  });

  describe("release branch policy behaviour", () => {
    const cases: ReleasePolicyCase[] = [
      {
        name: "accepts a prerelease tag that exists only on origin/release/0.11 after the fork",
        branch: "release/0.11",
        prerelease: true,
        expectedCode: 0,
        expectedOutput:
          "beta prerelease v0.11.0-beta.1 is contained in origin/release/* — allowed.",
      },
      {
        name: "rejects a prerelease tag contained only in origin/chore/release-0.10.85",
        branch: "chore/release-0.10.85",
        prerelease: true,
        expectedCode: 1,
        expectedOutput:
          "alpha and beta releases may only be cut from a release/* branch",
      },
      {
        name: "rejects a prerelease tag contained only in a personal feature branch",
        branch: "agent/personal-feature",
        prerelease: true,
        expectedCode: 1,
        expectedOutput:
          "alpha and beta releases may only be cut from a release/* branch",
      },
      {
        name: "rejects a prerelease tag on main when origin/release/1.0 descends from it",
        branch: "main",
        prerelease: true,
        expectedCode: 1,
        expectedOutput:
          "alpha and beta prereleases must not be cut from main",
        releaseBranch: "release/1.0",
        tagAtForkPoint: true,
      },
      {
        name: "rejects a prerelease tag at the main and release/1.0 fork point",
        branch: "main",
        prerelease: true,
        expectedCode: 1,
        expectedOutput:
          "alpha and beta prereleases must not be cut from main",
        advanceMainAfterReleaseBranch: true,
        releaseBranch: "release/1.0",
        tagAtForkPoint: true,
      },
      {
        name: "accepts a stable tag contained in origin/main",
        branch: "main",
        prerelease: false,
        expectedCode: 0,
        expectedOutput: "Stable release v0.11.0 is on main — allowed.",
      },
      {
        name: "rejects a stable tag not contained in origin/main",
        branch: "agent/personal-feature",
        prerelease: false,
        expectedCode: 1,
        expectedOutput:
          "Stable release tag v0.11.0 is not contained in origin/main",
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, async () => {
        const result = await invokeReleasePolicy(testCase);

        expect(
          result.code,
          `${testCase.name}: expected exit ${testCase.expectedCode}, got ${result.code}; output:\n${result.output}`,
        ).toBe(testCase.expectedCode);
        expect(
          result.output,
          `${testCase.name}: expected output to contain ${JSON.stringify(testCase.expectedOutput)}`,
        ).toContain(testCase.expectedOutput);
      });
    }
  });

  it("refuses to release a tag whose tree carries the V2 chat shell", () => {
    const validate = jobBody("validate");

    // The guard runs on the tag's own checked-out tree, which is the only
    // place that catches the actual failure mode: a stable tag cut from a main
    // tip that still carried the shell. A branch-level check cannot see it.
    expect(validate).toContain("- name: Enforce v1 desktop shell");
    expect(validate).toContain('if [ -d "$SHELL_DIR/chat" ]; then');
    expect(validate).toContain("this tag carries the V2 chat shell");

    // Negative check alone is not enough — an empty desktop-alt tree would
    // pass it. Required surfaces must positively be present, and the list of
    // them lives in a manifest rather than inline here, so shipping a new
    // surface and protecting it are the same edit.
    expect(validate).toContain(
      'MANIFEST="scripts/release-required-surfaces.txt"',
    );
    expect(validate).toContain("a required surface is absent from this tag's tree");
    // A tag cut before the manifest existed must fail loudly, not skip the
    // whole check because the file it reads happens to be absent.
    expect(validate).toContain(
      "the release guard cannot verify this tag's surfaces",
    );
  });

  it("applies the shell guard to workflow_dispatch retries too", () => {
    const validate = jobBody("validate");

    // The branch policy above deliberately skips dispatch retries. This guard
    // must NOT: a retry re-publishes that tag's artifacts to stable, so
    // retrying any of v0.10.106–v0.10.116 would put the V2 shell back in front
    // of users. Asserting the absence of the gate keeps a well-meaning
    // "make it consistent with the step above" edit from reopening that path.
    expect(validate).not.toMatch(
      /- name: Enforce v1 desktop shell\n {8}if: \$\{\{ github\.event_name == 'push' \}\}/,
    );
  });

  it("keeps the working tree on the v1 desktop shell", async () => {
    const shellDir = resolve(rootDir, "apps/sync/src/desktop-alt");

    await expect(stat(resolve(shellDir, "chat"))).rejects.toThrow();

    for (const marker of ["v4/V4Sidebar.svelte", "v4/V4SecondarySidebar.svelte"]) {
      await expect(stat(resolve(shellDir, marker))).resolves.toBeDefined();
    }
  });

  it("keeps every surface named in the release manifest present on disk", async () => {
    // The guard reads this manifest against a tag's tree at release time,
    // where a missing path is a failed release. Checking it here instead
    // means a stale entry surfaces in an ordinary PR run.
    const surfaces = parseRequiredSurfaces(requiredSurfaces);

    expect(surfaces.length).toBeGreaterThan(0);

    for (const surface of surfaces) {
      await expect(
        stat(resolve(rootDir, surface)),
        `${surface} is listed in scripts/release-required-surfaces.txt but does not exist`,
      ).resolves.toBeDefined();
    }
  });

  it("covers the surfaces a whole-tree revert has actually destroyed", () => {
    // #454 reset apps/sync/src/desktop-alt to an older tree and took the
    // "Finish setting up HQ" card with it; the guard's two sidebar markers
    // waved 36 releases through without it. Pinning these entries stops the
    // manifest being quietly emptied back to a shell-only check.
    const surfaces = parseRequiredSurfaces(requiredSurfaces);

    expect(surfaces).toContain(
      "apps/sync/src/desktop-alt/components/SetupIncompleteCard.svelte",
    );
    expect(surfaces).toContain("apps/sync/src/desktop-alt/lib/setup-launch.ts");
    expect(surfaces).toContain("apps/sync/src/desktop-alt/v4/V4Sidebar.svelte");
    expect(surfaces).toContain(
      "apps/sync/src/desktop-alt/v4/V4SecondarySidebar.svelte",
    );
  });

  it("allows an equal stable rerun but rejects a rollback below public latest", () => {
    const validate = jobBody("validate");

    expect(validate).toContain(
      "if: ${{ steps.classify.outputs.channel == 'stable' }}",
    );
    expect(validate).toContain(
      "node .release-control/scripts/release-stable-order.mjs stable-order",
    );
    expect(validate).toContain('--repository "$TARGET_REPOSITORY"');
    expect(validate).toContain('--tag "$TARGET_TAG"');
  });

  it("runs the commit-lineage rollback gate at both stable call sites", () => {
    const validate = jobBody("validate");
    const publish = jobBody("publish");

    // Validate job, before the expensive native builds.
    const rejectStep = stepBody(validate, "Reject stable release rollback");
    expect(rejectStep).toContain(
      "node .release-control/scripts/release-stable-order.mjs lineage",
    );
    expect(rejectStep).toContain('--repository "$TARGET_REPOSITORY"');
    expect(rejectStep).toContain('--tag "$TARGET_TAG"');
    expect(validate).toContain(
      "if: ${{ steps.classify.outputs.channel == 'stable' }}",
    );

    // Publish job, inside the global publication lock, immediately before the
    // only public-state mutation.
    const revalidateStep = stepBody(publish, "Revalidate stable publication order");
    expect(revalidateStep).toContain(
      "node .release-control/scripts/release-stable-order.mjs lineage",
    );
    expect(revalidateStep).toContain('--repository "$TARGET_REPOSITORY"');
    expect(publish).toContain(
      "needs.validate.outputs.channel == 'stable' && steps.release-plan.outputs.action != 'already-published'",
    );
  });

  it("stamps the tag's own commit into both build jobs for the Sentry build_commit tag", () => {
    for (const job of ["macos", "windows"]) {
      const step = stepBody(jobBody(job), "Stamp build commit identity");
      expect(step).toContain(
        'echo "HQ_BUILD_COMMIT=$(git rev-parse HEAD)" >> "$GITHUB_ENV"',
      );
    }
  });

  it("documents the stable lineage rollback contract and the Rollback-Of trailer", () => {
    expect(releaseDocs).toContain("Rollback-Of: vX.Y.Z");
    expect(releaseDocs).toContain("drops every fix the named release contains");
    // The rollback tag must name the older commit explicitly, not tag HEAD.
    expect(releaseDocs).toContain("git tag -a vX.Y.Z <rollback-commit>");
  });

  it("documents the latest.json rollback feed and the mark-bad operator command", () => {
    expect(releaseDocs).toContain('"rollback": true');
    expect(releaseDocs).toContain('"bad_versions": ["0.10.178"]');
    expect(releaseDocs).toContain("min_supported");
    expect(releaseDocs).toContain("node scripts/release-mark-bad.mjs 0.10.178 --to 0.10.177");
    expect(releaseDocs).toContain("gh release upload v0.10.177 latest.json --clobber");
    expect(releaseDocs).toContain("HQ_RELEASE_SMOKE_REFRESH_TOKEN_NON_INDIGO");
    expect(releaseDocs).toContain("gh release edit <tag> --latest --prerelease=false");
    expect(releaseDocs).toContain("gh release edit v0.10.178");
    expect(clientClassifier).toContain("pub struct UpdateFeedPolicy");
    expect(clientClassifier).toContain("pub fn should_offer_update");
  });

  it("classifies stable separately from beta and alpha", () => {
    const validate = jobBody("validate");

    expect(validate).toMatch(
      /CHANNEL="stable"[\s\S]*?PRERELEASE="false"[\s\S]*?MAKE_LATEST="true"/,
    );
    expect(validate).toMatch(
      /CHANNEL="beta"[\s\S]*?PRERELEASE="true"[\s\S]*?MAKE_LATEST="false"/,
    );
    expect(validate).toMatch(
      /CHANNEL="alpha"[\s\S]*?PRERELEASE="true"[\s\S]*?MAKE_LATEST="false"/,
    );

    for (const output of [
      "tag",
      "version",
      "channel",
      "prerelease",
      "make_latest",
      "msi_version",
    ]) {
      expect(workflow).toContain(
        output === "msi_version"
          ? "msi_version: ${{ steps.msi-version.outputs.version }}"
          : `${output}: \${{ steps.classify.outputs.${output} }}`,
      );
    }
  });

  it("stamps versions.toml and all four generated files from the tag", () => {
    const validate = jobBody("validate");

    // The tag is the source of truth: validate derives every version surface
    // from it rather than requiring a human to have bumped them beforehand.
    expect(validate).toContain('pnpm run version:app --set-version "$RELEASE_VERSION"');
    expect(validate).toContain("pnpm run version:check");

    for (const file of [
      "versions.toml",
      "apps/sync/package.json",
      "apps/sync/src-tauri/tauri.conf.json",
      "apps/sync/src-tauri/Cargo.toml",
      "apps/sync/src-tauri/Cargo.lock",
    ]) {
      expect(validate).toContain(file);
    }

    expect(jobBody("macos")).toContain("needs: validate");
    expect(jobBody("windows")).toContain("needs: validate");
    expect(workflow.match(/ref: refs\/tags\//g)).toHaveLength(4);
  });

  it("hands both platform builds the same stamped version bytes", () => {
    // One artifact, produced once, consumed by every builder — so macOS and
    // Windows can never bundle different versions from the same tag.
    expect(jobBody("validate")).toContain("name: release-version-stamp");

    for (const job of ["macos", "windows"]) {
      const body = jobBody(job);
      expect(body).toContain("actions/download-artifact@v4");
      expect(body).toContain("name: release-version-stamp");
      expect(body).toContain("Verify stamped version");
    }
  });

  it("syncs the released version back to main only for stable releases", () => {
    const sync = jobBody("sync-version");

    // Runs only after a successful publish, so a branch it cannot push never
    // blocks or masks a shipped release.
    expect(sync).toContain("needs: [validate, publish]");
    expect(sync).toContain("needs.publish.result == 'success'");
    // alpha/beta prereleases are cut from release/* branches, so their version
    // is never stamped onto main — sync-back is gated to stable releases only.
    expect(sync).toContain("needs.validate.outputs.prerelease != 'true'");
    expect(sync).toContain("ref: main");

    // main is protected with no role bypass, and GitHub will not accept the
    // Actions identity as a ruleset bypass actor — the push must go through the
    // hq-audit-bot App, which is the bypass actor on the `main` ruleset.
    expect(sync).toContain("actions/create-github-app-token@v1");
    expect(sync).toContain("HQ_AUDIT_BOT_APP_ID");
    expect(sync).toContain("token: ${{ steps.app-token.outputs.token }}");
    expect(sync).toContain("scripts/release-version-order.mjs");
    expect(sync).toContain("git push origin HEAD:refs/heads/main");
    // Never `git add -A`: only the five version surfaces may be committed.
    expect(sync).not.toContain("git add -A");
  });

  it("publishes prereleases without advancing the stable latest alias", () => {
    const publish = jobBody("publish");

    expect(publish).toContain("needs: [validate, macos, windows]");
    expect(publish).toContain(
      "needs.macos.result == 'success' && needs.windows.result == 'success'",
    );
    expect(publish).not.toContain("needs.windows.result == 'failure'");
    expect(publish).toContain("Validate complete release artifact set");
    expect(publish).not.toContain("simply omitted");
    expect(publish).not.toContain("skip (missing)");
    expect(publish).toContain('VERSION="${TAG#v}"');
    for (const artifact of [
      "arm64-setup.exe",
      "arm64-setup.exe.sig",
      "arm64.msi",
      "arm64.msi.sig",
      "universal.app.tar.gz",
      "universal.app.tar.gz.sig",
      "universal.dmg",
      "x64-setup.exe",
      "x64-setup.exe.sig",
      "x64.msi",
      "x64.msi.sig",
    ]) {
      expect(publish).toContain(artifact);
    }
  });

  it("uploads and verifies a hidden draft before making a release public", () => {
    const publish = jobBody("publish");
    const resolveState = publish.indexOf("- name: Resolve atomic release state");
    const create = publish.indexOf("- name: Create or reset hidden draft GitHub release");
    const upload = publish.indexOf("- name: Upload complete asset set to draft");
    const verify = publish.indexOf("- name: Verify exact draft release asset set");
    const makePublic = publish.indexOf("- name: Publish verified GitHub release");
    const confirm = publish.indexOf("- name: Confirm public release and channel isolation");

    expect(resolveState).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(resolveState);
    expect(upload).toBeGreaterThan(create);
    expect(verify).toBeGreaterThan(upload);
    expect(makePublic).toBeGreaterThan(verify);
    expect(confirm).toBeGreaterThan(makePublic);
    expect(publish).not.toContain("softprops/action-gh-release");
    expect(publish).toContain("group: release-publication");
    expect(publish).not.toContain("group: release-publish-${{");
    expect(publish).toContain("cancel-in-progress: false");
    expect(publish).toContain(
      '"repos/${REPOSITORY}/releases?per_page=100"',
    );
    expect(publish).not.toContain(
      '"repos/${REPOSITORY}/releases/tags/${TAG}"',
    );
    expect(publish).toContain(
      ".release-control/scripts/release-asset-contract.mjs plan",
    );
    expect(publish).toContain("create-draft");
    expect(publish).toContain("reset-draft|already-published|promote-pending");
    expect(publish).toContain("draft: true");
    expect(publish.match(/action != 'already-published'/g)).toHaveLength(3);
    expect(
      publish.match(
        /action == 'create-draft' \|\| steps\.release-plan\.outputs\.action == 'reset-draft'/g,
      ),
    ).toHaveLength(4);
    expect(publish).toContain('gh release upload "$TAG" release/* -R "$REPOSITORY"');
    expect(publish).toContain(
      ".release-control/scripts/release-asset-contract.mjs verify",
    );
    expect(publish).toContain("--draft true");
    expect(publish).toContain("--match-bytes true");
    expect(publish).toContain("draft: false");
    expect(publish).toContain(
      "PRERELEASE: ${{ needs.validate.outputs.prerelease }}",
    );
    expect(publish).toContain(
      "MAKE_LATEST: ${{ needs.validate.outputs.make_latest }}",
    );
    expect(publish).toContain(
      ".release-control/scripts/release-asset-contract.mjs manifest",
    );
    expect(publish).toContain('match_bytes="false"');
    const revalidate = publish.indexOf(
      "- name: Revalidate stable publication order",
    );
    expect(revalidate).toBeGreaterThan(verify);
    expect(revalidate).toBeLessThan(makePublic);
    expect(publish).toContain(
      "needs.validate.outputs.channel == 'stable' && steps.release-plan.outputs.action != 'already-published'",
    );
    expect(publish).toContain(
      "node .release-control/scripts/release-stable-order.mjs stable-order",
    );
    expect(publish).toContain(
      "node .release-control/scripts/release-stable-order.mjs confirm-channel",
    );
    expect(publish).toContain('--make-latest "$MAKE_LATEST"');
    expect(publish).toContain("--make-latest false");
    expect(publish).not.toContain('releases/latest" 2>/dev/null || true');
  });

  it("publishes a stable tag as a prerelease until the tag latest.json smokes, then promotes to latest", () => {
    const publish = jobBody("publish");
    const makePublic = publish.indexOf("- name: Publish verified GitHub release");
    const smokeFeed = publish.indexOf("- name: Smoke published latest.json for this tag");
    const promote = publish.indexOf("- name: Promote stable release to latest");
    const confirm = publish.indexOf("- name: Confirm public release and channel isolation");

    expect(smokeFeed).toBeGreaterThan(makePublic);
    expect(promote).toBeGreaterThan(smokeFeed);
    expect(confirm).toBeGreaterThan(promote);
    expect(publish).toContain("--staged-stable");
    expect(publish).toContain("promote-pending");
    expect(publish).toContain("make_latest: false");
    expect(stepBody(publish, "Publish verified GitHub release")).toContain(
      "make_latest: false",
    );
    expect(stepBody(publish, "Publish verified GitHub release")).not.toContain(
      "MAKE_LATEST: ${{ needs.validate.outputs.make_latest }}",
    );
    expect(publish).toContain("macos-artifact-smoke.mjs");
    expect(publish).toContain("/releases/download/${TAG}/latest.json");
    expect(publish).toContain('gh release edit "$TAG" -R "$REPOSITORY" --latest --prerelease=false');
    expect(stepBody(publish, "Promote stable release to latest")).toContain(
      "needs.validate.outputs.channel == 'stable'",
    );
    expect(publish).toContain("scripts/macos-artifact-smoke.mjs");
  });

  it("loads retry-safe publication helpers from the exact workflow commit", () => {
    const validate = jobBody("validate");
    const publish = jobBody("publish");

    for (const job of [validate, publish]) {
      expect(job).toContain("- name: Checkout release control plane");
      expect(job).toContain("ref: ${{ github.workflow_sha }}");
      expect(job).toContain("path: .release-control");
      expect(job).toContain("scripts/release-asset-contract.mjs");
      expect(job).toContain("scripts/release-stable-order.mjs");
      expect(job).toContain("sparse-checkout-cone-mode: false");
      expect(job).toContain("persist-credentials: false");
    }
    expect(publish).toContain("scripts/macos-artifact-smoke.mjs");
  });

  it("smokes the signed macOS app as a non-Indigo identity before publish", () => {
    const macos = jobBody("macos");
    const publish = jobBody("publish");
    const smoke = stepBody(macos, "Non-Indigo artifact smoke");

    expect(macos.indexOf("- name: Build unsigned universal app and updater archive")).toBeLessThan(
      macos.indexOf("- name: Non-Indigo artifact smoke"),
    );
    expect(macos.indexOf("- name: Sign app bundle")).toBeLessThan(
      macos.indexOf("- name: Non-Indigo artifact smoke"),
    );
    expect(publish).toContain("needs: [validate, macos, windows]");
    expect(smoke).not.toContain("continue-on-error");
    expect(macos).not.toMatch(
      /Non-Indigo artifact smoke[\s\S]*?continue-on-error: true/,
    );
    expect(smoke).toContain("HQ_RELEASE_SMOKE_REFRESH_TOKEN_NON_INDIGO");
    expect(smoke).toContain("secrets.HQ_RELEASE_SMOKE_REFRESH_TOKEN_NON_INDIGO");
    expect(smoke).toContain('if [ -z "${HQ_RELEASE_SMOKE_REFRESH_TOKEN_NON_INDIGO:-}" ]; then');
    expect(smoke).toContain("fail-closed");
    expect(smoke).toContain("macos-artifact-smoke.mjs");
    expect(smoke).toContain("--launch");
    expect(smoke).toContain("--timeout-ms 30000");
    expect(smoke).toContain("HQ.app");
    expect(macos).toContain("scripts/macos-artifact-smoke.mjs");
    expect(macos).toContain("ref: ${{ github.workflow_sha }}");
  });

  it("documents the release hosts and native targets the workflow actually ships", () => {
    expect(versionsToml).toContain(
      'manifest_base = "https://github.com/indigoai-us/hq-desktop-app/releases"',
    );
    expect(versionsToml).toContain(
      'macos = ["aarch64-apple-darwin", "x86_64-apple-darwin"]',
    );
    expect(versionsToml).toContain(
      'windows = ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"]',
    );
  });

  it("gives WiX a numeric MSI ProductVersion while preserving app SemVer", () => {
    const windows = jobBody("windows");

    expect(windows).toContain("Generate Windows MSI version overlay");
    expect(windows).toContain(
      "node ../../scripts/windows-msi-version.mjs",
    );
    expect(windows).toContain(
      "--config $env:TAURI_MSI_VERSION_CONFIG",
    );
    expect(windows).toContain("--bundles msi nsis updater");
    expect(windows).toContain("Required updater signature is missing");
    expect(windows.indexOf("--config src-tauri/tauri.windows.release.conf.json")).toBeLessThan(
      windows.indexOf("--config $env:TAURI_MSI_VERSION_CONFIG"),
    );
    expect(JSON.parse(windowsConfig).bundle.windows.allowDowngrades).toBe(false);
  });

  it("builds a prerelease MSI in the regular Windows installer gate", () => {
    expect(windowsCheckWorkflow).toContain("installer E2E (x64 MSI + NSIS)");
    expect(windowsCheckWorkflow).toContain("Generate Windows MSI version overlay");
    expect(windowsCheckWorkflow).toContain(
      "node ../../scripts/windows-msi-version.mjs",
    );
    expect(windowsCheckWorkflow).toContain("--bundles msi nsis");
    expect(windowsCheckWorkflow).toContain("Verify prerelease MSI package");
    expect(windowsCheckWorkflow).toContain(
      "--config $env:TAURI_MSI_VERSION_CONFIG",
    );
  });

  // The relevance list used to be a `paths:` trigger filter on
  // windows-check.yml, and this test read it as YAML text. It now lives in
  // scripts/windows-check-relevant.mjs, because a path-filtered workflow leaves
  // its REQUIRED contexts pending forever on a non-matching PR. Assert the
  // decision instead of the syntax: these are the release-control files that
  // must still bring the Windows gate with them.
  it("runs the required Windows gate for release-control changes", () => {
    for (const path of [
      "versions.toml",
      "scripts/release-asset-contract.mjs",
      "scripts/release-stable-order.mjs",
      "scripts/release-asset-contract.test.ts",
      "scripts/windows-msi-version.mjs",
      "scripts/windows-msi-version.test.ts",
      ".github/workflows/release.yml",
    ]) {
      expect(isWindowsRelevant([path]), `${path} must run the gate`).toBe(true);
    }
  });

  it("retains native debug files only in Sentry and verifies each uploaded debug id", () => {
    const macos = jobBody("macos");
    const windows = jobBody("windows");

    expect(macos).toContain("Install Sentry CLI");
    expect(macos).toContain("Upload macOS debug files to Sentry");
    expect(macos).toContain("sentry-cli debug-files upload");
    expect(macos).toContain("--no-sources");
    expect(macos).toContain("SENTRY_AUTH_TOKEN");
    expect(macos).toContain("SENTRY_AUTH_TOKEN is not configured");
    expect(stepBody(macos, "Upload macOS debug files to Sentry")).toContain(
      "GITHUB_STEP_SUMMARY",
    );
    expect(stepBody(macos, "Upload macOS debug files to Sentry")).toContain(
      "https://sentry.io/api/0/projects/indigo-d0/hq-desktop/files/dsyms/",
    );
    expect(stepBody(macos, "Upload macOS debug files to Sentry")).toContain(
      "debug_id",
    );
    expect(macos).toContain('DSYM_BUNDLE="${APP_BUNDLE}.dSYM"');
    expect(macos).toContain("HQ.app/Contents/MacOS/hq-sync-menubar");
    expect(macos).toContain(
      'DSYM_BINARY="$DSYM_BUNDLE/Contents/Resources/DWARF/hq-sync-menubar"',
    );
    // The sidecar dSYM is produced BEFORE the app binary is stripped: preferred
    // source is the packed per-arch dSYMs (split-debuginfo = "packed"),
    // lipo-combined into one universal DWARF; dsymutil on the pre-strip binary
    // is only a fallback.
    expect(macos).toContain(
      "src-tauri/target/${ARCH}/release/hq-sync-menubar.dSYM",
    );
    expect(macos).toContain('lipo -create "${DWARF_SLICES[@]}" -output "$DSYM_BINARY"');
    // The shipped binary is stripped explicitly in the workflow: cargo's strip
    // left the embedded __DWARF on this universal build, so an xcrun strip is
    // required to keep the bundle deterministically under budget.
    expect(macos).toContain('xcrun strip -S -x "$APP_BINARY"');
    // The 15 MB total-bundle budget was never satisfiable (the bundle carries
    // the ~150 MB Recall SDK sidecar). The meaningful native-symbol/code-bloat
    // signal is the stripped binary, budgeted tightly; a coarse total-bundle
    // ceiling still catches runaway resource growth.
    expect(macos).toContain("APP_BINARY_BUDGET_KB=$((120 * 1024))");
    expect(macos).toContain("macOS app binary exceeds 120 MB budget");
    expect(macos).toContain("BUNDLE_BUDGET_KB=$((300 * 1024))");
    expect(macos).toContain("macOS app bundle exceeds 300 MB budget");
    expect(macos).not.toContain("15 * 1024");

    expect(windows).toContain("Install Sentry CLI");
    expect(windows).toContain("Verify Windows debug file contract");
    expect(windows).toContain("hq_sync_menubar.pdb");
    expect(windows).toContain("hq-sync-menubar.exe");
    expect(windows).toContain("sentry-cli difutil check");
    expect(windows).toContain("Upload Windows debug files to Sentry");
    expect(windows).toContain("sentry-cli debug-files upload");
    expect(windows).toContain("--no-sources");
    expect(windows).toContain("SENTRY_AUTH_TOKEN is not configured");
    expect(windows).toContain("SENTRY_AUTH_TOKEN is invalid or upload failed");
    expect(stepBody(windows, "Upload Windows debug files to Sentry")).toContain(
      'Write-Host "::warning::$message"',
    );
    expect(stepBody(windows, "Upload Windows debug files to Sentry")).toContain(
      "GITHUB_STEP_SUMMARY",
    );
    expect(stepBody(windows, "Upload Windows debug files to Sentry")).toContain(
      "https://sentry.io/api/0/projects/indigo-d0/hq-desktop/files/dsyms/",
    );
    expect(stepBody(windows, "Upload Windows debug files to Sentry")).toContain(
      "debug_id",
    );
    expect(windows).toContain("$exeMetadata.variants");
    expect(windows).toContain("$pdbMetadata.variants");
    expect(macos).toContain('data.get("variants", [])');
    expect(syncCargoToml).toMatch(/\[profile\.release\][\s\S]*?debug = "line-tables-only"/);
    // Deterministic strip keeps the shipped macOS .app under the 15 MB budget
    // regardless of rust-cache / incremental-artifact state (v0.10.81 regression).
    expect(syncCargoToml).toMatch(/\[profile\.release\][\s\S]*?strip = "symbols"/);
    expect(syncCargoToml).toMatch(/\[profile\.release\][\s\S]*?split-debuginfo = "packed"/);

    expect(windowsCheckWorkflow).toContain("Verify installer debug file contract");
    expect(windowsCheckWorkflow).toContain("hq-sync-menubar.exe");
    expect(windowsCheckWorkflow).toContain("hq_sync_menubar.pdb");
    expect(windowsCheckWorkflow).toContain("sentry-cli difutil check --json");
    expect(windowsCheckWorkflow).toContain("Installer executable/PDB debug id");

    expect(workflow).not.toContain("hq-debug-");
    expect(workflow).not.toContain("debug-artifacts-${{ matrix.target }}");
    expect(workflow).not.toContain("private CI artifact");
    expect(workflow).not.toContain("private GitHub Actions");
    expect(releaseDocs).toContain("Sentry is the only retention path");
    expect(releaseDocs).toContain("that build\nhas no recoverable symbols");
    expect(releaseDocs).toContain("`--no-sources`");
    expect(releaseDocs).not.toContain("private CI artifact");
    expect(releaseDocs).not.toContain("private GitHub Actions");
    for (const uploadBody of [
      ...uploadArtifactStepBodies(macos),
      ...uploadArtifactStepBodies(windows),
    ]) {
      expect(uploadBody).not.toMatch(/(?:\.pdb|\.app\.dSYM)/);
    }
    expect(`${macos}\n${windows}`).not.toContain("--include-sources");

    const publish = jobBody("publish");
    expect(publish).not.toContain("Download all artifacts");
    expect(publish).toContain("Download macOS release artifacts");
    expect(publish).toContain("Download Windows x64 release artifacts");
    expect(publish).toContain("Download Windows ARM64 release artifacts");
    expect(publish).not.toContain("hq-debug-");
  });
});
