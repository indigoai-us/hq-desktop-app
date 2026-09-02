// The synthetic versions the Windows installer E2E installs and upgrades to.
//
// Two build jobs run in parallel and each derives these numbers independently
// on its own runner, so the derivation has to be deterministic and total. A
// silent disagreement of one patch would publish a bridge installer the E2E job
// never looks for, surfacing as "installer was not produced" with no hint that
// two jobs had simply computed different numbers.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  deriveInstallerE2eVersions,
  readBaseVersion,
} from "./windows-e2e-versions.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(rootDir, "scripts/windows-e2e-versions.mjs");

describe("deriveInstallerE2eVersions", () => {
  it("walks the patch forward twice", () => {
    expect(deriveInstallerE2eVersions("0.9.8")).toEqual({
      base: "0.9.8",
      bridge: "0.9.9",
      target: "0.9.10",
    });
  });

  it("carries no rollover: the patch is a plain integer, not a digit", () => {
    // 0.9.9 -> 0.9.10 -> 0.9.11, never 0.10.0. NSIS file names embed the
    // version verbatim, so the E2E job's glob has to match this exactly.
    expect(deriveInstallerE2eVersions("0.9.9").bridge).toBe("0.9.10");
    expect(deriveInstallerE2eVersions("0.9.99").target).toBe("0.9.101");
  });

  it("keeps major and minor untouched", () => {
    expect(deriveInstallerE2eVersions("12.34.56")).toEqual({
      base: "12.34.56",
      bridge: "12.34.57",
      target: "12.34.58",
    });
  });

  it("rejects a prerelease base rather than guessing at it", () => {
    // A prerelease base would make the bridge and target ambiguous, and the
    // MSI overlay already has its own X.Y.Z-beta.N mapping. Fail loudly.
    for (const bad of [
      "0.9.8-beta.1",
      "0.9.8-beta",
      "0.9",
      "0.9.8.1",
      "v0.9.8",
      "",
    ]) {
      expect(() => deriveInstallerE2eVersions(bad)).toThrow(
        /Expected stable X\.Y\.Z base version/,
      );
    }
  });

  it("rejects leading zeroes, which NSIS would not round-trip", () => {
    expect(() => deriveInstallerE2eVersions("0.09.8")).toThrow();
  });
});

describe("the CLI entrypoint", () => {
  function run(): Promise<{ stdout: string; code: number }> {
    return new Promise((resolvePromise) => {
      execFile(
        process.execPath,
        [scriptPath],
        { cwd: rootDir },
        (error, stdout) => {
          resolvePromise({
            stdout,
            code: error ? ((error as { code?: number }).code ?? 1) : 0,
          });
        },
      );
    });
  }

  it("emits GITHUB_OUTPUT lines for the checked-out app version", async () => {
    const { stdout, code } = await run();
    const expected = deriveInstallerE2eVersions(readBaseVersion(rootDir));

    expect(code).toBe(0);
    expect(stdout).toBe(
      `base=${expected.base}\nbridge=${expected.bridge}\ntarget=${expected.target}\n`,
    );
  });

  it("reads the same manifest the build jobs stamp", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(rootDir, "apps/sync/package.json"), "utf8"),
    );

    expect(readBaseVersion(rootDir)).toBe(manifest.version);
  });
});
