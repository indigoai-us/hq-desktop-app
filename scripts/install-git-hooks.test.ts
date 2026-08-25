// Tests for the `prepare` hook installer.
//
// `core.hooksPath` is a single repo-wide setting, so installing the release-tag
// cooldown hook is not simply a matter of writing it: a clone that already
// points that setting somewhere else (Husky, or a developer's own hooks) would
// lose every pre-commit and commit-msg hook it has, because .githooks provides
// only pre-push. And because this runs from a package lifecycle script, it has
// to be plain Node — a POSIX shell one-liner fails `pnpm install` outright on
// Windows, where `/dev/null` is not a path and `true` is not a command.

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HOOKS_PATH, installGitHooks } from "./install-git-hooks.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let workdir = "";

beforeAll(async () => {
  workdir = await mkdtemp(resolve(tmpdir(), "install-git-hooks-"));
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(args[0], args.slice(1), { cwd }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise(stdout.trim());
    });
  });
}

async function makeRepo(name: string): Promise<string> {
  const repo = resolve(workdir, name);
  await mkdir(repo, { recursive: true });
  await run(repo, ["git", "init", "--quiet", "--initial-branch=main"]);
  return repo;
}

function hooksPath(repo: string): Promise<string> {
  return run(repo, ["git", "config", "--local", "core.hooksPath"]).catch(
    () => "",
  );
}

/** Collect what the installer logged instead of printing it. */
function capture(): { log: (m: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (m: string) => lines.push(m), lines };
}

describe("installing into a clean clone", () => {
  it("points core.hooksPath at .githooks", async () => {
    const repo = await makeRepo("clean");

    expect(installGitHooks(repo, () => {})).toBe("installed");
    expect(await hooksPath(repo)).toBe(HOOKS_PATH);
  });

  it("is idempotent across repeated installs", async () => {
    const repo = await makeRepo("idempotent");

    expect(installGitHooks(repo, () => {})).toBe("installed");
    expect(installGitHooks(repo, () => {})).toBe("already");
    expect(installGitHooks(repo, () => {})).toBe("already");
    expect(await hooksPath(repo)).toBe(HOOKS_PATH);
  });
});

describe("an existing custom hooks path is preserved", () => {
  // Overwriting this is how a developer silently loses every pre-commit,
  // commit-msg, and prepare-commit-msg hook they had.
  it("does not overwrite a Husky hooks path", async () => {
    const repo = await makeRepo("husky");
    await run(repo, ["git", "config", "--local", "core.hooksPath", ".husky/_"]);

    const { log, lines } = capture();
    expect(installGitHooks(repo, log)).toBe("preserved");
    expect(await hooksPath(repo)).toBe(".husky/_");
    // Silence would leave the developer believing the cooldown is active.
    expect(lines.join("\n")).toContain(".husky/_");
    expect(lines.join("\n")).toContain("NOT installed");
  });

  it("does not overwrite a personal hooks path", async () => {
    const repo = await makeRepo("personal-hooks");
    await run(repo, [
      "git",
      "config",
      "--local",
      "core.hooksPath",
      "my-hooks",
    ]);

    expect(installGitHooks(repo, () => {})).toBe("preserved");
    expect(await hooksPath(repo)).toBe("my-hooks");
  });

  it("tells the developer how to enable the hook anyway", async () => {
    const repo = await makeRepo("preserve-guidance");
    await run(repo, ["git", "config", "--local", "core.hooksPath", ".husky/_"]);

    const { log, lines } = capture();
    installGitHooks(repo, log);

    const message = lines.join("\n");
    expect(message).toContain(`git config core.hooksPath ${HOOKS_PATH}`);
    expect(message).toContain(`${HOOKS_PATH}/pre-push`);
  });
});

describe("a missing git work tree never breaks the install", () => {
  it("skips a directory that is not a repository", async () => {
    const plain = resolve(workdir, "not-a-repo");
    await mkdir(plain, { recursive: true });
    await writeFile(resolve(plain, "package.json"), "{}\n");

    expect(installGitHooks(plain, () => {})).toBe("skipped");
  });

  it("does not throw when git is unavailable", async () => {
    const plain = resolve(workdir, "no-git");
    await mkdir(plain, { recursive: true });

    // An empty PATH makes spawnSync fail to find git, which is the same shape
    // as a machine without git installed.
    const previous = process.env.PATH;
    process.env.PATH = "";
    try {
      expect(() => installGitHooks(plain, () => {})).not.toThrow();
    } finally {
      process.env.PATH = previous;
    }
  });
});

describe("running as a lifecycle script", () => {
  const cli = () => resolve(rootDir, "scripts/install-git-hooks.mjs");

  it("installs into the repository it is pointed at", async () => {
    const repo = await makeRepo("cli-repo");

    await run(repo, [process.execPath, cli(), repo]);

    expect(await hooksPath(repo)).toBe(HOOKS_PATH);
  });

  it("exits zero in a directory with no repository", async () => {
    const plain = resolve(workdir, "cli-no-repo");
    await mkdir(plain, { recursive: true });

    // Resolving means it exited 0. A non-zero exit here would fail every
    // `pnpm install` run from a tarball or a non-git checkout.
    await expect(
      run(plain, [process.execPath, cli(), plain]),
    ).resolves.toBeDefined();
  });

  it("exits zero rather than clobbering a custom hooks path", async () => {
    const repo = await makeRepo("cli-preserve");
    await run(repo, ["git", "config", "--local", "core.hooksPath", ".husky/_"]);

    await expect(
      run(repo, [process.execPath, cli(), repo]),
    ).resolves.toBeDefined();
    expect(await hooksPath(repo)).toBe(".husky/_");
  });
});
