import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  applyRollbackMarker,
  markBad,
  markBadError,
  normalizeVersion,
  planMarkBad,
  versionToTag,
} from "./release-mark-bad.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "fixtures/latest.json");

describe("release-mark-bad", () => {
  it("normalizes v-prefixed versions", () => {
    expect(normalizeVersion("v0.10.178")).toBe("0.10.178");
    expect(normalizeVersion("0.10.178")).toBe("0.10.178");
    expect(versionToTag("0.10.177")).toBe("v0.10.177");
    expect(() => normalizeVersion("latest")).toThrow(/expected X\.Y\.Z/);
  });

  it("stamps rollback markers onto a latest.json without touching platform URLs", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const marked = applyRollbackMarker(fixture, {
      badVersions: ["v0.10.178"],
      minSupported: "0.10.177",
    });
    expect(marked.version).toBe("0.10.177");
    expect(marked.rollback).toBe(true);
    expect(marked.bad_versions).toEqual(["0.10.178"]);
    expect(marked.min_supported).toBe("0.10.177");
    expect(marked.platforms).toEqual(fixture.platforms);
    expect(marked.notes).toBe(fixture.notes);
  });

  it("plans an unpublish when the bad version is currently GitHub latest", () => {
    const plan = planMarkBad({
      badVersion: "0.10.178",
      goodVersion: "0.10.177",
      currentLatestTag: "v0.10.178",
    });
    expect(plan.goodTag).toBe("v0.10.177");
    expect(plan.badTag).toBe("v0.10.178");
    expect(plan.unpublishBad).toBe(true);
  });

  it("does not unpublish when latest already points at the good build", () => {
    const plan = planMarkBad({
      badVersion: "0.10.178",
      goodVersion: "0.10.177",
      currentLatestTag: "v0.10.177",
    });
    expect(plan.unpublishBad).toBe(false);
  });

  it("refuses to mark a version as its own recovery target", () => {
    expect(() =>
      planMarkBad({
        badVersion: "0.10.177",
        goodVersion: "0.10.177",
        currentLatestTag: "v0.10.177",
      }),
    ).toThrow(/cannot be the same/);
    expect(markBadError("x").message).toMatch(/^release-mark-bad: x$/);
  });

  it("dry-runs against the fixture latest.json without calling gh", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hq-mark-bad-test-"));
    const output = join(dir, "patched.json");
    const script = resolve(here, "release-mark-bad.mjs");
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        script,
        "0.10.178",
        "--dry-run",
        "--fixture",
        fixturePath,
        "--output",
        output,
      ],
      { encoding: "utf8" },
    );
    expect(stdout).toBe("");
    expect(stderr).toContain("dry-run: would upload v0.10.177/latest.json");
    const patched = JSON.parse(await readFile(output, "utf8"));
    expect(patched.rollback).toBe(true);
    expect(patched.bad_versions).toEqual(["0.10.178"]);
    expect(patched.min_supported).toBe("0.10.177");
    expect(patched.version).toBe("0.10.177");
    expect(patched.platforms["darwin-aarch64"].url).toContain("v0.10.177");
  });

  it("markBad helper matches the dry-run CLI against the same fixture", async () => {
    const result = await markBad({
      badVersion: "0.10.178",
      fixturePath,
    });
    expect(result.plan.goodTag).toBe("v0.10.177");
    expect(result.marked.rollback).toBe(true);
    expect(result.marked.bad_versions).toEqual(["0.10.178"]);
  });

  it("rejects a fixture whose version does not match --to", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hq-mark-bad-mismatch-"));
    const fixture = join(dir, "latest.json");
    await writeFile(
      fixture,
      JSON.stringify({
        version: "0.10.176",
        platforms: { "darwin-aarch64": { url: "x", signature: "y" } },
      }),
    );
    await expect(
      markBad({
        badVersion: "0.10.178",
        to: "0.10.177",
        fixturePath: fixture,
      }),
    ).rejects.toThrow(/does not match --to 0\.10\.177/);
  });
});
