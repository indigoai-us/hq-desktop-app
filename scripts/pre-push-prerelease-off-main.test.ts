// Behaviour tests for the alpha/beta-off-main check in `.githooks/pre-push`.
//
// Owner rule: vX.Y.Z-beta.N and vX.Y.Z-alpha.N tags are cut from a release
// branch, never from main. The accepted shape is a same-tree
// "chore(release): <tag>" commit on top of main, pushed to release/<tag>; that
// commit is not on main, so it passes. A tag whose commit is an ancestor of,
// or equal to, origin/main is refused. Stable and shelltest tags are not
// checked. The Release workflow enforces the same rule in CI
// (scripts/release-workflow.test.ts, "release branch policy behaviour").
//
// These run the hook for real against throwaway repositories with a bare
// origin, so the hook's own `git fetch <remote> main` is exercised.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = resolve(rootDir, ".githooks/pre-push");
const ZERO = "0".repeat(40);

let workdir = "";

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), "prepush-prerelease-"));
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  stdin = "",
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      args[0],
      args.slice(1),
      { cwd, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolvePromise({
          code: typeof error?.code === "number" ? error.code : 0,
          stdout,
          stderr,
        });
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
  });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await run(cwd, ["git", ...args]);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

interface Fixture {
  repo: string;
  originUrl: string;
  mainSha: string;
  releaseSha: string;
}

/**
 * origin has main at M. Locally, release/<tag> holds an empty
 * "chore(release)" commit R on top of M (same tree, not on main).
 */
async function makeFixture(name: string, releaseTag: string): Promise<Fixture> {
  const base = join(workdir, name);
  const origin = join(base, "origin.git");
  const repo = join(base, "repo");
  await run(workdir, ["mkdir", "-p", base]);
  await git(base, "init", "--bare", "--quiet", origin);
  await git(base, "init", "--quiet", "--initial-branch=main", repo);
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, "file.txt"), "hello\n");
  await git(repo, "add", "file.txt");
  await git(repo, "commit", "--quiet", "-m", "main");
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "push", "--quiet", "origin", "main");
  const mainSha = await git(repo, "rev-parse", "HEAD");

  await git(repo, "switch", "--quiet", "-c", `release/${releaseTag}`);
  await git(repo, "commit", "--quiet", "--allow-empty", "-m", `chore(release): ${releaseTag}`);
  const releaseSha = await git(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "--quiet", "main");

  return { repo, originUrl: origin, mainSha, releaseSha };
}

/** Run the hook as git would for `git push origin <tag>` at `sha`. */
async function pushTag(
  fixture: Fixture,
  tag: string,
  sha: string,
  env: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  // Create the tag locally first, as a real push would; the cooldown ignores
  // tags that are part of the push itself, so a fresh repo is never cooled.
  await git(fixture.repo, "tag", "-f", tag, sha);
  const line = `refs/tags/${tag} ${sha} refs/tags/${tag} ${ZERO}\n`;
  return run(
    fixture.repo,
    ["bash", hookPath, "origin", fixture.originUrl],
    { HQ_ALLOW_TAG_PUSH: "", HQ_ALLOW_PRERELEASE_FROM_MAIN: "", ...env },
    line,
  );
}

// Each case builds two repositories and runs a real fetch, which can exceed
// vitest's 5s default on a loaded machine.
describe("pre-push: alpha/beta tags must not be cut from main", { timeout: 30_000 }, () => {
  for (const channel of ["beta", "alpha"] as const) {
    const tag = `v0.11.8-${channel}.1`;

    it(`rejects a ${channel} tag on a main commit`, async () => {
      const fx = await makeFixture(`${channel}-main`, tag);
      const result = await pushTag(fx, tag, fx.mainSha);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`BLOCKED: refusing to push ${channel} tag ${tag}`);
      expect(result.stderr).toContain("must be cut from a release branch, never from main");
    });

    it(`rejects a ${channel} tag on an older ancestor of main`, async () => {
      const fx = await makeFixture(`${channel}-ancestor`, tag);
      await writeFile(join(fx.repo, "file.txt"), "next\n");
      await git(fx.repo, "commit", "--quiet", "-am", "advance main");
      await git(fx.repo, "push", "--quiet", "origin", "main");
      const result = await pushTag(fx, tag, fx.mainSha);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`refusing to push ${channel} tag ${tag}`);
    });

    it(`accepts a ${channel} tag on a chore(release) child of main on release/${tag}`, async () => {
      const fx = await makeFixture(`${channel}-release`, tag);
      const result = await pushTag(fx, tag, fx.releaseSha);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("BLOCKED");
    });

    it(`HQ_ALLOW_TAG_PUSH does not bypass the ${channel}-off-main check`, async () => {
      const fx = await makeFixture(`${channel}-cooldown-bypass`, tag);
      const result = await pushTag(fx, tag, fx.mainSha, { HQ_ALLOW_TAG_PUSH: "1" });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`refusing to push ${channel} tag ${tag}`);
    });

    it(`HQ_ALLOW_PRERELEASE_FROM_MAIN=1 allows a ${channel} main tag and logs it`, async () => {
      const fx = await makeFixture(`${channel}-override`, tag);
      const result = await pushTag(fx, tag, fx.mainSha, { HQ_ALLOW_PRERELEASE_FROM_MAIN: "1" });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain(
        `HQ_ALLOW_PRERELEASE_FROM_MAIN=1 — allowing ${channel} tag ${tag} on main commit ${fx.mainSha}`,
      );
    });
  }

  it("leaves a stable tag on main unaffected", async () => {
    const fx = await makeFixture("stable", "v0.11.8-beta.1");
    const result = await pushTag(fx, "v0.11.8", fx.mainSha);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("BLOCKED");
  });

  it("leaves a shelltest tag on main unaffected", async () => {
    const fx = await makeFixture("shelltest", "v0.11.8-beta.1");
    const result = await pushTag(fx, "v0.0.0-shelltest.7", fx.mainSha);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("BLOCKED");
  });

  it("falls back to the last-fetched origin/main when the remote is unreachable", async () => {
    const fx = await makeFixture("offline", "v0.11.8-beta.1");
    await git(fx.repo, "fetch", "--quiet", "origin");
    await git(fx.repo, "remote", "set-url", "origin", join(workdir, "does-not-exist.git"));
    const result = await pushTag(fx, "v0.11.8-beta.1", fx.mainSha);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("refusing to push beta tag v0.11.8-beta.1");
  });
});
