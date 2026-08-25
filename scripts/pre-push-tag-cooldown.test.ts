// Behaviour tests for `.githooks/pre-push`, the release-tag cooldown.
//
// Pushing a `v*` tag is the whole release trigger (docs/RELEASE.md), and the
// Release workflow builds macOS universal + Windows x64/ARM64 installers on
// GitHub-hosted runners. macOS minutes bill at 10x and Windows at 2x a Linux
// minute, so a tag push is the single most expensive action in this repo.
// The hook paces those pushes; these tests run it for real against throwaway
// git repositories rather than asserting on its source text.

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = resolve(rootDir, ".githooks/pre-push");

const HOUR = 3600;
const ZERO = "0".repeat(40);
const SHA = "a".repeat(40);
const REMOTE = "https://example.invalid/repo.git";

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

/** A repo with one commit and no tags. */
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

/** Invoke the hook with raw `pre-push` stdin lines. */
function invoke(
  repo: string,
  stdin: string,
  env: NodeJS.ProcessEnv = {},
  remoteUrl = REMOTE,
): Promise<RunResult> {
  return run(repo, ["bash", hookPath, "origin", remoteUrl], env, stdin);
}

/** One `<local ref> <local sha> <remote ref> <remote sha>` line. */
function line(localRef: string, localSha: string, remoteRef: string): string {
  return `${localRef} ${localSha} ${remoteRef} ${ZERO}\n`;
}

/** The ordinary `git push origin vX` shape: local and remote refs match. */
function pushRef(
  repo: string,
  ref: string,
  localSha: string,
  env: NodeJS.ProcessEnv = {},
  remoteUrl = REMOTE,
): Promise<RunResult> {
  return invoke(repo, line(ref, localSha, ref), env, remoteUrl);
}

function markerPath(repo: string, remoteUrl = REMOTE): string {
  const key = remoteUrl.replace(/[^A-Za-z0-9._-]/g, "_");
  return resolve(repo, `.git/hq-last-tag-push-${key}`);
}

/** Backdate the cooldown marker for a destination by `hoursAgo`. */
async function setMarker(
  repo: string,
  hoursAgo: number,
  remoteUrl = REMOTE,
): Promise<void> {
  const epoch = Math.floor(Date.now() / 1000) - Math.round(hoursAgo * HOUR);
  await writeFile(markerPath(repo, remoteUrl), `${epoch}\n`);
}

async function markerAgeHours(
  repo: string,
  remoteUrl = REMOTE,
): Promise<number> {
  const raw = await readFile(markerPath(repo, remoteUrl), "utf8");
  return (Math.floor(Date.now() / 1000) - Number(raw.trim())) / HOUR;
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
    const flat = stderr.replace(/\s+/g, " ");
    expect(flat).toMatch(/costs? a lot of real money in GitHub Actions/);
    expect(stderr).toContain("macOS");
    expect(stderr).toContain("Windows");
    expect(stderr).toContain("HQ_ALLOW_TAG_PUSH=1");
  });

  it("allows a tag once the cooldown has elapsed", async () => {
    const repo = await makeRepo("outside-window");
    await setMarker(repo, 6.5);

    expect((await pushRef(repo, "refs/tags/v1.2.4", SHA)).code).toBe(0);
  });

  it("blocks the second tag of a back-to-back pair", async () => {
    const repo = await makeRepo("consecutive");

    expect((await pushRef(repo, "refs/tags/v1.0.0", SHA)).code).toBe(0);

    const second = await pushRef(repo, "refs/tags/v1.0.1", SHA);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("v1.0.1");
  });

  it("blocks when a batch push contains a release tag", async () => {
    const repo = await makeRepo("mixed-batch");
    await setMarker(repo, 0.5);

    const { code, stderr } = await invoke(
      repo,
      line("refs/heads/main", SHA, "refs/heads/main") +
        line("refs/tags/v2.0.0", SHA, "refs/tags/v2.0.0"),
    );

    expect(code).toBe(1);
    expect(stderr).toContain("v2.0.0");
  });
});

describe("the destination ref decides, not the source ref", () => {
  // `git push origin HEAD:refs/tags/v1.2.3` is a valid refspec whose LOCAL ref
  // is `HEAD`. Matching on the local ref lets that form skip the hook entirely
  // while still triggering the release workflow.
  it("blocks a tag pushed via HEAD:refs/tags/vX", async () => {
    const repo = await makeRepo("refspec-head");
    await setMarker(repo, 0.5);

    const { code, stderr } = await invoke(
      repo,
      line("HEAD", SHA, "refs/tags/v9.9.9"),
    );

    expect(code).toBe(1);
    expect(stderr).toContain("v9.9.9");
  });

  it("blocks a tag pushed from a branch ref to a tag ref", async () => {
    const repo = await makeRepo("refspec-branch");
    await setMarker(repo, 0.5);

    const { code } = await invoke(
      repo,
      line("refs/heads/main", SHA, "refs/tags/v9.9.8"),
    );

    expect(code).toBe(1);
  });

  it("records the marker for a refspec push it allows", async () => {
    const repo = await makeRepo("refspec-records");

    expect((await invoke(repo, line("HEAD", SHA, "refs/tags/v9.9.7"))).code).toBe(
      0,
    );
    expect(await markerAgeHours(repo)).toBeLessThan(0.1);
  });

  it("ignores a local tag ref pushed to a branch", async () => {
    const repo = await makeRepo("tag-to-branch");
    await setMarker(repo, 0.5);

    const { code } = await invoke(
      repo,
      line("refs/tags/v1.0.0", SHA, "refs/heads/release"),
    );

    expect(code).toBe(0);
  });
});

describe("only release tags count", () => {
  // The Release workflow triggers on `tags: ["v*"]` and nothing else, so any
  // other tag starts no billed build.
  it("allows a non-release tag during the cooldown", async () => {
    const repo = await makeRepo("non-release-tag");
    await setMarker(repo, 0.5);

    expect((await pushRef(repo, "refs/tags/docs-2026", SHA)).code).toBe(0);
  });

  it("does not spend the cooldown on a non-release tag", async () => {
    const repo = await makeRepo("non-release-no-marker");

    expect((await pushRef(repo, "refs/tags/docs-2026", SHA)).code).toBe(0);
    expect(existsSync(markerPath(repo))).toBe(false);

    // The real release that follows must still be allowed.
    expect((await pushRef(repo, "refs/tags/v1.0.0", SHA)).code).toBe(0);
  });

  it("ignores a non-release tag when reading the fallback", async () => {
    const repo = await makeRepo("non-release-fallback");
    await tagAt(repo, "docs-2026", 0.5);

    expect((await pushRef(repo, "refs/tags/v1.0.0", SHA)).code).toBe(0);
  });
});

describe("one release per push", () => {
  // Git invokes the hook once per push with one line per ref, so a single
  // cooldown check would otherwise clear two releases at once.
  it("refuses two release tags in one push", async () => {
    const repo = await makeRepo("two-tags");

    const { code, stderr } = await invoke(
      repo,
      line("refs/tags/v1.2.3", SHA, "refs/tags/v1.2.3") +
        line("refs/tags/v1.2.4", SHA, "refs/tags/v1.2.4"),
    );

    expect(code).toBe(1);
    expect(stderr).toContain("v1.2.3");
    expect(stderr).toContain("v1.2.4");
    expect(stderr).toMatch(/2 release tags/);
  });

  it("refuses two release tags even with a cold cooldown", async () => {
    const repo = await makeRepo("two-tags-cold");
    await setMarker(repo, 48);

    const { code } = await invoke(
      repo,
      line("refs/tags/v3.0.0", SHA, "refs/tags/v3.0.0") +
        line("refs/tags/v3.0.1", SHA, "refs/tags/v3.0.1"),
    );

    expect(code).toBe(1);
  });

  it("allows a batch of one release tag plus branches", async () => {
    const repo = await makeRepo("one-tag-plus-branch");

    const { code } = await invoke(
      repo,
      line("refs/heads/main", SHA, "refs/heads/main") +
        line("refs/tags/v4.0.0", SHA, "refs/tags/v4.0.0"),
    );

    expect(code).toBe(0);
  });

  it("lets the bypass push several tags deliberately", async () => {
    const repo = await makeRepo("two-tags-bypass");

    const { code } = await invoke(
      repo,
      line("refs/tags/v5.0.0", SHA, "refs/tags/v5.0.0") +
        line("refs/tags/v5.0.1", SHA, "refs/tags/v5.0.1"),
      { HQ_ALLOW_TAG_PUSH: "1" },
    );

    expect(code).toBe(0);
  });
});

describe("the newest signal wins", () => {
  // A clone whose own marker is old but which has just fetched a teammate's
  // fresh release tag must not be allowed to release again immediately.
  it("blocks on a fresh fetched tag despite an old marker", async () => {
    const repo = await makeRepo("fresh-tag-old-marker");
    await setMarker(repo, 20);
    await tagAt(repo, "v6.0.0", 0.3);

    const { code, stderr } = await pushRef(repo, "refs/tags/v6.0.1", SHA);

    expect(code).toBe(1);
    expect(stderr).toContain("tag v6.0.0");
  });

  it("blocks on a fresh marker despite an old tag", async () => {
    const repo = await makeRepo("fresh-marker-old-tag");
    await setMarker(repo, 0.3);
    await tagAt(repo, "v6.0.0", 20);

    const { code, stderr } = await pushRef(repo, "refs/tags/v6.0.1", SHA);

    expect(code).toBe(1);
    expect(stderr).toContain("from this clone");
  });

  it("allows when both signals are older than the window", async () => {
    const repo = await makeRepo("both-old");
    await setMarker(repo, 20);
    await tagAt(repo, "v6.0.0", 30);

    expect((await pushRef(repo, "refs/tags/v6.0.1", SHA)).code).toBe(0);
  });
});

describe("a fresh clone falls back to tag dates", () => {
  it("blocks when the newest existing release tag is recent", async () => {
    const repo = await makeRepo("fallback-recent");
    await tagAt(repo, "v3.0.0", 2);

    const { code, stderr } = await pushRef(repo, "refs/tags/v3.0.1", SHA);

    expect(code).toBe(1);
    expect(stderr).toContain("tag v3.0.0");
  });

  it("allows when the newest existing tag is older than the window", async () => {
    const repo = await makeRepo("fallback-old");
    await tagAt(repo, "v3.0.0", 30);

    expect((await pushRef(repo, "refs/tags/v3.0.1", SHA)).code).toBe(0);
  });

  it("allows the very first tag in a repo with no history", async () => {
    const repo = await makeRepo("first-tag");

    expect((await pushRef(repo, "refs/tags/v0.1.0", SHA)).code).toBe(0);
  });

  it("ignores the tag being pushed when it already exists locally", async () => {
    const repo = await makeRepo("self-tag");
    await tagAt(repo, "v4.0.0", 0);

    expect((await pushRef(repo, "refs/tags/v4.0.0", SHA)).code).toBe(0);
  });
});

describe("the cooldown is scoped to its destination", () => {
  // Pushing to a personal fork or a local mirror cannot start THIS repo's
  // release workflow, so it must not spend origin's cooldown.
  const other = "https://example.invalid/fork.git";

  it("does not let a mirror push block the production remote", async () => {
    const repo = await makeRepo("per-remote");

    expect((await pushRef(repo, "refs/tags/v7.0.0", SHA, {}, other)).code).toBe(
      0,
    );
    expect((await pushRef(repo, "refs/tags/v7.0.0", SHA, {}, REMOTE)).code).toBe(
      0,
    );
  });

  it("still paces repeat pushes to the same destination", async () => {
    const repo = await makeRepo("per-remote-same");

    expect((await pushRef(repo, "refs/tags/v7.1.0", SHA, {}, other)).code).toBe(
      0,
    );
    expect((await pushRef(repo, "refs/tags/v7.1.1", SHA, {}, other)).code).toBe(
      1,
    );
  });

  it("keeps separate marker files per destination", async () => {
    const repo = await makeRepo("per-remote-files");

    await pushRef(repo, "refs/tags/v7.2.0", SHA, {}, other);

    expect(existsSync(markerPath(repo, other))).toBe(true);
    expect(existsSync(markerPath(repo, REMOTE))).toBe(false);
  });

  // The marker is per-destination; the tag-date floor deliberately is not. A
  // release tag that exists locally and was created minutes ago means a billed
  // release is probably already running, and the hook cannot tell a harmless
  // bare mirror from a fork that would build it. Blocking is the safe
  // direction, and the bypass is one environment variable away.
  it("paces every destination once a real release tag is that recent", async () => {
    const repo = await makeRepo("per-remote-tag-floor");
    await tagAt(repo, "v7.3.0", 0.3);

    expect((await pushRef(repo, "refs/tags/v7.3.1", SHA, {}, other)).code).toBe(
      1,
    );
    expect(
      (
        await pushRef(repo, "refs/tags/v7.3.1", SHA, {
          HQ_ALLOW_TAG_PUSH: "1",
        }, other)
      ).code,
    ).toBe(0);
  });
});

describe("non-release pushes are untouched", () => {
  it("allows branch pushes inside the window", async () => {
    const repo = await makeRepo("branch-push");
    await setMarker(repo, 0.1);

    expect((await pushRef(repo, "refs/heads/main", SHA)).code).toBe(0);
  });

  it("allows tag deletions inside the window", async () => {
    const repo = await makeRepo("tag-delete");
    await setMarker(repo, 0.1);

    expect((await pushRef(repo, "refs/tags/v5.0.0", ZERO)).code).toBe(0);
  });

  it("allows the colon form of a tag deletion", async () => {
    const repo = await makeRepo("tag-delete-colon");
    await setMarker(repo, 0.1);

    const { code } = await invoke(
      repo,
      line("(delete)", ZERO, "refs/tags/v5.0.0"),
    );

    expect(code).toBe(0);
  });

  it("does not spend the cooldown on a deletion", async () => {
    const repo = await makeRepo("delete-no-marker");

    await pushRef(repo, "refs/tags/v5.0.0", ZERO);

    expect(existsSync(markerPath(repo))).toBe(false);
  });

  it("allows an empty push with no refs", async () => {
    const repo = await makeRepo("empty-push");
    await setMarker(repo, 0.1);

    expect((await invoke(repo, "")).code).toBe(0);
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

  it("resets the cooldown when a bypass releases", async () => {
    // A bypassed release still starts a billed build, so it has to move the
    // window. Otherwise an urgent release now, followed by an ordinary one
    // five hours later, sees a six-hour-old marker and goes out early.
    const repo = await makeRepo("bypass-records");
    await setMarker(repo, 5);

    await pushRef(repo, "refs/tags/v6.1.0", SHA, { HQ_ALLOW_TAG_PUSH: "1" });

    expect(await markerAgeHours(repo)).toBeLessThan(0.1);
    expect((await pushRef(repo, "refs/tags/v6.1.1", SHA)).code).toBe(1);
  });

  it("honours HQ_TAG_PUSH_COOLDOWN_SECONDS", async () => {
    const repo = await makeRepo("custom-window");
    await setMarker(repo, 1);

    expect(
      (
        await pushRef(repo, "refs/tags/v7.0.0", SHA, {
          HQ_TAG_PUSH_COOLDOWN_SECONDS: "600",
        })
      ).code,
    ).toBe(0);

    await setMarker(repo, 1);
    expect(
      (
        await pushRef(repo, "refs/tags/v7.0.0", SHA, {
          HQ_TAG_PUSH_COOLDOWN_SECONDS: `${24 * HOUR}`,
        })
      ).code,
    ).toBe(1);
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
  it("installs hooks through the cross-platform installer", async () => {
    const pkg = JSON.parse(
      await readFile(resolve(rootDir, "package.json"), "utf8"),
    );
    // Not a POSIX shell one-liner: lifecycle scripts run through cmd.exe on
    // Windows, where `/dev/null` and `true` break the install outright.
    expect(pkg.scripts.prepare).toBe("node scripts/install-git-hooks.mjs");
  });
});
