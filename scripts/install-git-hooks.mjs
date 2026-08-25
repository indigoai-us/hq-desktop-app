// Point git at .githooks, without clobbering an existing custom hooks path.
//
// Run from the root `prepare` lifecycle script, so `pnpm install` installs the
// release-tag cooldown hook (.githooks/pre-push).
//
// Two things this deliberately is NOT:
//
//   1. It is not a shell one-liner. Package lifecycle scripts run through
//      cmd.exe on Windows, where `/dev/null` is not a path and `true` is not a
//      command — a POSIX one-liner makes `pnpm install` FAIL there rather than
//      quietly skipping. This is plain Node, so it behaves the same everywhere.
//
//   2. It is not an unconditional `git config core.hooksPath .githooks`.
//      `core.hooksPath` is a single repo-wide setting. A clone that already
//      points it somewhere else — Husky, or a developer's own hooks — would
//      lose every pre-commit, commit-msg, and prepare-commit-msg hook it has,
//      because .githooks provides only pre-push. When a different path is
//      already configured we leave it alone and explain how to integrate.
//
// Never fails the install. A missing git, a tarball with no .git, or a
// read-only config is a reason to skip hook installation, not to break
// `pnpm install`.
//
// Covered by scripts/install-git-hooks.test.ts.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOOKS_PATH = ".githooks";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Run git, returning trimmed stdout or null when it fails or is unavailable. */
function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

/**
 * Install the hooks path in `cwd`.
 *
 * Returns one of:
 *   `installed`      — core.hooksPath was unset and now points at .githooks
 *   `already`        — it already pointed at .githooks
 *   `preserved`      — a different custom path is configured; left untouched
 *   `skipped`        — not a git work tree, or git is unavailable
 *   `failed`         — git refused to write the config
 */
export function installGitHooks(cwd = rootDir, log = console.error) {
  if (git(["rev-parse", "--is-inside-work-tree"], cwd) !== "true") {
    return "skipped";
  }

  // `git config` exits non-zero when the key is unset, which `git()` maps to
  // null — exactly the "not configured" case.
  const current = git(["config", "--local", "core.hooksPath"], cwd);

  if (current === HOOKS_PATH) {
    return "already";
  }

  if (current) {
    log(
      `hq: core.hooksPath is already set to "${current}", leaving it alone.\n` +
        `hq: the release-tag cooldown hook is NOT installed. To enable it, either\n` +
        `hq:   git config core.hooksPath ${HOOKS_PATH}\n` +
        `hq: or call ${HOOKS_PATH}/pre-push from your own pre-push hook.`,
    );
    return "preserved";
  }

  if (git(["config", "--local", "core.hooksPath", HOOKS_PATH], cwd) === null) {
    log("hq: could not set core.hooksPath; git hooks were not installed.");
    return "failed";
  }

  return "installed";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // `prepare` passes no argument and gets the repo this script lives in. The
  // optional path argument exists so the tests can drive real throwaway repos.
  installGitHooks(process.argv[2] ? resolve(process.argv[2]) : rootDir);
}
