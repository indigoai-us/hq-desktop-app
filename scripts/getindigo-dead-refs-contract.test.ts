// Guard: no shipped file may reference retired getindigo.ai hosts outside an
// explicit allowlist of historical lines.
//
// Wave 2 of the getindigo.ai deprecation removed every present-tense reference
// to `downloads.getindigo.ai` from MIGRATION.md (the old prose replaced with
// `hqforwork.com/install`). If any tracked file re-introduces the string
// without being added to the allowlist below, this test fails.
//
// Model: `scripts/install-git-hooks.test.ts` (vitest + spawnSync). Any scan
// error is treated as a test failure so a broken `git` invocation cannot mask
// a real regression.

import { spawnSync } from "node:child_process";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Explicit allowlist. Each entry is a `path:line` string against `git grep -n`
// output. Only add here for genuine historical prose that MUST retain the
// retired host name (e.g. a sentence recording what the OLD installer used).
// An empty allowlist means: no tracked file may mention the host at all.
const HISTORICAL_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // (none — every present-tense reference was migrated in wave 2a.)
]);

// This test file itself must appear as an occurrence in the grep output
// (because it contains the literal string as data). Exclude the test file's
// own path from the offender list.
const TEST_RELATIVE_PATH = relative(
  rootDir,
  fileURLToPath(import.meta.url),
).replaceAll("\\", "/");

const RETIRED_HOSTS: readonly string[] = ["downloads.getindigo.ai"];

describe("getindigo.ai wave-2a dead-reference guard", () => {
  for (const host of RETIRED_HOSTS) {
    it(`no tracked file references ${host} outside the allowlist`, () => {
      const result = spawnSync(
        "git",
        ["-C", rootDir, "grep", "-n", "-F", "--", host],
        { encoding: "utf8" },
      );

      // `git grep` exits 0 on match, 1 on no match, other on error.
      // Treat any error (missing git, corrupt repo, etc.) as a failure.
      if (result.error) {
        throw new Error(
          `git grep failed for ${host}: ${result.error.message}`,
        );
      }
      if (result.status !== 0 && result.status !== 1) {
        throw new Error(
          `git grep exited ${result.status} for ${host}: ${result.stderr}`,
        );
      }

      const offenders = (result.stdout || "")
        .split("\n")
        .filter(Boolean)
        .filter((line) => {
          // Line format: "path:lineno:content".
          const idx = line.indexOf(":");
          if (idx < 0) return true;
          const rest = line.slice(idx + 1);
          const idx2 = rest.indexOf(":");
          if (idx2 < 0) return true;
          const path = line.slice(0, idx);
          const lineno = rest.slice(0, idx2);
          // The test file itself contains the string as data — skip it.
          if (path === TEST_RELATIVE_PATH) return false;
          return !HISTORICAL_ALLOWLIST.has(`${path}:${lineno}`);
        });

      expect(offenders, `unexpected references to ${host}:\n${offenders.join("\n")}`).toEqual(
        [],
      );
    });
  }
});
