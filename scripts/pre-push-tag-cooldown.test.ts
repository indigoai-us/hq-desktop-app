// Behaviour tests for `.githooks/pre-push`, the release-tag cooldown.
//
// Pushing a `v*` tag is the whole release trigger (docs/RELEASE.md), and the
// Release workflow builds macOS universal + Windows x64/ARM64 installers on
// GitHub-hosted runners. macOS minutes bill at 10x and Windows at 2x a Linux
// minute, so a tag push is the single most expensive action in this repo.
// The hook paces those pushes; these tests run it for real against throwaway
// git repositories rather than asserting on its source text.

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = resolve(rootDir, ".githooks/pre-push");

const HOUR = 3600;
const ZERO = "0".repeat(40);
const SHA = "a".repeat(40);

let workdir = "";

beforeAll(async () => {
  workdir = await mkdtemp(resolve(tmpdir(), "prepush-cooldown-"));
});

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

interface RunResult {
  code: number;
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
      (error, _stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolvePromise({
          code: typeof error?.code === "number" ? error.code : 0,
          stderr,
        });
      },
    );
    // A short-lived child (`git rev-parse`, or the hook exiting early) can
    // close its stdin before we finish writing. That EPIPE is expected and
    // says nothing about the child's exit status, which is what we assert on.
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
  });
}

/** A repo with one commit and no tags, plus a helper to invoke the hook. */
async function makeRepo(name: string): Promise<string> {
  const repo = resolve(workdir, name);
  await mkdir(repo, { recursive: true });
  const git = (...args: string[]) => run(repo, ["git", ...args]);

  await git("init", "--quiet", "--initial-branch=main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await writeFile(resolve(repo, "file.txt"), "hello\n");
  await git("add", "file.txt");
  await git("commit", "--quiet", "-m", "initial");
  return repo;
}

/** Feed the hook one `pre-push` stdin line. */
function pushRef(
  repo: string,
  ref: string,
  localSha: string,
  env: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  return run(
    repo,
    ["bash", hookPath, "origin", "https://example.invalid/repo.git"],
    env,
    `${ref} ${localSha} ${ref} ${ZERO}\n`,
  );
}

/** Backdate the "last tag push" marker by `hoursAgo`. */
async function setMarker(repo: string, hoursAgo: number): Promise<void> {
  const { stderr } = await run(repo, [
    "git",
    "rev-parse",
    "--git-path",
    "hq-last-tag-push",
  ]);
  void stderr;
  const epoch = Math.floor(Date.now() / 1000) - Math.round(hoursAgo * HOUR);
  await writeFile(resolve(repo, ".git/hq-last-tag-push"), `${epoch}\n`);
}

/** Create a tag whose creation date is `hoursAgo` in the past. */
async function tagAt(
  repo: string,
  name: string,
  hoursAgo: number,
): Promise<void> {
  const when = new Date(Date.now() - hoursAgo * HOUR * 1000).toISOString();
  await run(repo, ["git", "tag", "-a", name, "-m", name], {
    GIT_COMMITTER_DATE: when,
    GIT_AUTHOR_DATE: when,
  });
}

describe("the hook is installable", () => {
  it("is executable so core.hooksPath can run it directly", async () => {
    const info = await stat(hookPath);
    expect(info.mode & 0o111).not.toBe(0);
  });
});

describe("release tag pushes are paced", () => {
  it("blocks a tag pushed inside the 6 hour cooldown", async () => {
    const repo = await makeRepo("inside-window");
    await setMarker(repo, 1.2);

    const { code, stderr } = await pushRef(repo, "refs/tags/v1.2.3", SHA);

    expect(code).toBe(1);
    expect(stderr).toContain("v1.2.3");
    // The message has to explain the cost, not just say "no".
    expect(stderr).toContain("Pushing a tag runs the release");
    // The wording is hard-wrapped, so compare against unwrapped text.
    const flat = stderr.replace(/\s+/g, " ");
    expect(flat).toMatch(/costs? a lot of real money in GitHub Actions/);
    expect(stderr).toContain("macOS");
    expect(stderr).toContain("Windows");
    expect(stderr).toContain("HQ_ALLOW_TAG_PUSH=1");
  });

  it("allows a tag once the cooldown has elapsed", async () => {
    const repo = await makeRepo("outside-window");
    await setMarker(repo, 6.5);

    const { code } = await pushRef(repo, "refs/tags/v1.2.4", SHA);

    expect(code).toBe(0);
  });

  it("blocks the second tag of a back-to-back pair", async () => {
    const repo = await makeRepo("consecutive");

    const first = await pushRef(repo, "refs/tags/v1.0.0", SHA);
    expect(first.code).toBe(0);

    const second = await pushRef(repo, "refs/tags/v1.0.1", SHA);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("v1.0.1");
  });

  it("blocks when a batch push contains any tag", async () => {
    const repo = await makeRepo("mixed-batch");
    await setMarker(repo, 0.5);

    const { code, stderr } = await run(
      repo,
      ["bash", hookPath, "origin", "https://example.invalid/repo.git"],
      {},
      `refs/heads/main ${SHA} refs/heads/main ${ZERO}\n` +
        `refs/tags/v2.0.0 ${SHA} refs/tags/v2.0.0 ${ZERO}\n`,
    );

    expect(code).toBe(1);
    expect(stderr).toContain("v2.0.0");
  });
});

describe("a fresh clone falls back to tag dates", () => {
  it("blocks when the newest existing tag is recent", async () => {
    const repo = await makeRepo("fallback-recent");
    await tagAt(repo, "v3.0.0", 2);

    const { code, stderr } = await pushRef(repo, "refs/tags/v3.0.1", SHA);

    expect(code).toBe(1);
    expect(stderr).toContain("tag v3.0.0");
  });

  it("allows when the newest existing tag is older than the window", async () => {
    const repo = await makeRepo("fallback-old");
    await tagAt(repo, "v3.0.0", 30);

    const { code } = await pushRef(repo, "refs/tags/v3.0.1", SHA);

    expect(code).toBe(0);
  });

  it("allows the very first tag in a repo with no history", async () => {
    const repo = await makeRepo("first-tag");

    const { code } = await pushRef(repo, "refs/tags/v0.1.0", SHA);

    expect(code).toBe(0);
  });

  it("ignores the tag being pushed when it already exists locally", async () => {
    const repo = await makeRepo("self-tag");
    await tagAt(repo, "v4.0.0", 0);

    const { code } = await pushRef(repo, "refs/tags/v4.0.0", SHA);

    expect(code).toBe(0);
  });
});

describe("non-release pushes are untouched", () => {
  it("allows branch pushes inside the window", async () => {
    const repo = await makeRepo("branch-push");
    await setMarker(repo, 0.1);

    const { code } = await pushRef(repo, "refs/heads/main", SHA);

    expect(code).toBe(0);
  });

  it("allows tag deletions inside the window", async () => {
    const repo = await makeRepo("tag-delete");
    await setMarker(repo, 0.1);

    const { code } = await pushRef(repo, "refs/tags/v5.0.0", ZERO);

    expect(code).toBe(0);
  });

  it("allows an empty push with no refs", async () => {
    const repo = await makeRepo("empty-push");
    await setMarker(repo, 0.1);

    const { code } = await run(
      repo,
      ["bash", hookPath, "origin", "https://example.invalid/repo.git"],
      {},
      "",
    );

    expect(code).toBe(0);
  });
});

describe("the cooldown is escapable and configurable", () => {
  it("honours HQ_ALLOW_TAG_PUSH=1", async () => {
    const repo = await makeRepo("bypass");
    await setMarker(repo, 0.1);

    const { code, stderr } = await pushRef(repo, "refs/tags/v6.0.0", SHA, {
      HQ_ALLOW_TAG_PUSH: "1",
    });

    expect(code).toBe(0);
    expect(stderr).toContain("bypassed");
  });

  it("honours HQ_TAG_PUSH_COOLDOWN_SECONDS", async () => {
    const repo = await makeRepo("custom-window");
    await setMarker(repo, 1);

    const relaxed = await pushRef(repo, "refs/tags/v7.0.0", SHA, {
      HQ_TAG_PUSH_COOLDOWN_SECONDS: "600",
    });
    expect(relaxed.code).toBe(0);

    await setMarker(repo, 1);
    const strict = await pushRef(repo, "refs/tags/v7.0.0", SHA, {
      HQ_TAG_PUSH_COOLDOWN_SECONDS: `${24 * HOUR}`,
    });
    expect(strict.code).toBe(1);
  });

  it("defaults to a 6 hour window", async () => {
    const repo = await makeRepo("default-window");
    await setMarker(repo, 5.9);
    expect((await pushRef(repo, "refs/tags/v8.0.0", SHA)).code).toBe(1);

    await setMarker(repo, 6.1);
    expect((await pushRef(repo, "refs/tags/v8.0.1", SHA)).code).toBe(0);
  });
});

describe("pnpm install wires the hook up", () => {
  it("points core.hooksPath at .githooks from the root prepare script", async () => {
    const pkg = JSON.parse(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(resolve(rootDir, "package.json"), "utf8"),
      ),
    );
    expect(pkg.scripts.prepare).toContain("core.hooksPath");
    expect(pkg.scripts.prepare).toContain(".githooks");
  });
});
