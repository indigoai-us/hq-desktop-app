// Guard: no tracked file may reference retired getindigo.ai hosts outside an
// explicit allowlist of historical lines.
//
// Wave 2a of the getindigo.ai deprecation restored the historical planning
// lines in MIGRATION.md (which recorded downloads.getindigo.ai as the planned
// updater host, never launched) and annotated them "(retired, never launched)".
// All present-tense guidance now points to the correct current host.
//
// Model: test/infra/wave1-docs-domain-migration.test.ts in hq-pro.
// Scan errors are treated as failures so a broken git invocation cannot mask
// a real regression.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Explicit allowlist. Each entry is a historical line that must stay in its
// file. Format: { file (path from repo root), needle (exact substring), reason }.
// A stale-allowlist assertion confirms every entry still exists in its file,
// so a removed line causes a loud failure rather than a silent pass.
const HISTORICAL_ALLOWLIST = [
  {
    file: "MIGRATION.md",
    needle: "downloads.getindigo.ai/hq-desktop-app/{stable,beta,alpha}/latest.json",
    reason:
      "Locked decision 3 and Goals bullet - original planning artifact recording the intended updater domain; never deployed.",
  },
  {
    file: "MIGRATION.md",
    needle: "downloads.getindigo.ai/hq-desktop-app/stable/latest.json",
    reason:
      "Section 8 updater endpoints code block - planned stable channel URL; never deployed.",
  },
  {
    file: "MIGRATION.md",
    needle: "downloads.getindigo.ai/hq-desktop-app/beta/latest.json",
    reason:
      "Section 8 updater endpoints code block - planned beta channel URL; never deployed.",
  },
  {
    file: "MIGRATION.md",
    needle: "downloads.getindigo.ai/hq-desktop-app/alpha/latest.json",
    reason:
      "Section 8 updater endpoints code block - planned alpha channel URL; never deployed.",
  },
  {
    file: "MIGRATION.md",
    needle:
      "downloads.getindigo.ai/hq-desktop-app` (retired, never launched), generate manifests",
    reason:
      "Migration phase table row 8 - historical reference to planned endpoint host.",
  },
  {
    file: "MIGRATION.md",
    needle:
      "The `downloads.getindigo.ai` endpoints below were planned but never launched or deployed.",
    reason:
      "2026-09-27 dated note in section 8 explaining the planned vs actual updater host.",
  },
  {
    file: "CHANGELOG.md",
    needle:
      "The script targeted `updates.hq-installer.getindigo.ai` (NXDOMAIN); no workflow or package.json script invoked it.",
    reason:
      "Wave 2a changelog entry recording the retired domain. Historical record of what was removed.",
  },
];

const RETIRED_HOSTS: readonly string[] = [
  "downloads.getindigo.ai",
  "updates.hq-installer.getindigo.ai",
];

// This test file itself mentions the host as search data - exclude it from the
// offender list.
const TEST_RELATIVE_PATH = relative(
  rootDir,
  fileURLToPath(import.meta.url),
).replaceAll("\\", "/");

describe("getindigo.ai wave-2a dead-reference guard", () => {
  it("allowlist entries still exist in their files (stale-allowlist check)", () => {
    for (const entry of HISTORICAL_ALLOWLIST) {
      const filePath = join(rootDir, entry.file);
      expect(
        existsSync(filePath),
        `Allowlist file missing: ${entry.file}`,
      ).toBe(true);
      const content = readFileSync(filePath, "utf8");
      expect(
        content.includes(entry.needle),
        `Stale allowlist: "${entry.needle}" not found in ${entry.file}`,
      ).toBe(true);
    }
  });

  for (const host of RETIRED_HOSTS) {
    it(`no tracked file references ${host} outside the allowlist`, () => {
      const result = spawnSync(
        "git",
        ["-C", rootDir, "grep", "-n", "-F", "--", host],
        { encoding: "utf8" },
      );

      // git grep exits 0 on match, 1 on no match, 128+ on error.
      if (result.error) {
        throw new Error(`git grep failed for ${host}: ${result.error.message}`);
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
          // git grep line format: file:lineno:content
          const colonIdx = line.indexOf(":");
          if (colonIdx === -1) return true;
          const filePart = line.slice(0, colonIdx);
          // Skip this test file itself (it contains the host string as data).
          if (filePart === TEST_RELATIVE_PATH) return false;
          const rest = line.slice(colonIdx + 1);
          return !HISTORICAL_ALLOWLIST.some(
            (entry) =>
              filePart === entry.file.replaceAll("\\", "/") &&
              rest.includes(entry.needle),
          );
        });

      expect(
        offenders,
        `unexpected references to ${host}:\n${offenders.join("\n")}`,
      ).toHaveLength(0);
    });
  }
});
