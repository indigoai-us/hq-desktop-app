import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { compareShellKeys, parseArgs } from "./verify-shell-key.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("./verify-shell-key.mjs", import.meta.url));
const A = "a".repeat(64);
const B = "b".repeat(64);

describe("compareShellKeys", () => {
  it("passes when every bundle carries its recomputed key", () => {
    expect(
      compareShellKeys([
        { label: "macOS", expected: A, actual: `${A}\n` },
        { label: "Windows x64", expected: B, actual: B },
      ]),
    ).toEqual({ ok: true, errors: [] });
  });

  it("fails on a stale key in any one bundle", () => {
    const result = compareShellKeys([
      { label: "macOS", expected: A, actual: A },
      { label: "Windows arm64", expected: A, actual: B },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Windows arm64");
  });

  it("fails when a bundle has no key file or an empty one", () => {
    expect(compareShellKeys([{ label: "x64", expected: A, actual: null }]).ok).toBe(false);
    expect(compareShellKeys([{ label: "x64", expected: A, actual: " \n" }]).ok).toBe(false);
  });

  it("fails when the recomputed key is malformed", () => {
    expect(compareShellKeys([{ label: "x64", expected: "", actual: "" }]).ok).toBe(false);
    expect(compareShellKeys([{ label: "x64", expected: "abc", actual: "abc" }]).ok).toBe(false);
  });

  it("fails when nothing was checked", () => {
    expect(compareShellKeys([]).ok).toBe(false);
  });
});

describe("parseArgs", () => {
  it("parses repeated --check triplets", () => {
    expect(parseArgs(["--check", "mac", A, "/a", "--check", "win", B, "/b"])).toEqual([
      { label: "mac", expected: A, file: "/a" },
      { label: "win", expected: B, file: "/b" },
    ]);
  });

  it("rejects a truncated triplet", () => {
    expect(() => parseArgs(["--check", "mac", A])).toThrow();
  });
});

describe("CLI", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("exits 0 on a match and 1 on a mismatch or missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verify-shell-key-"));
    cleanup.push(dir);
    await writeFile(join(dir, "k.txt"), `${A}\n`);
    await expect(execFileAsync("node", [SCRIPT, "--check", "mac", A, join(dir, "k.txt")])).resolves.toBeTruthy();
    await expect(execFileAsync("node", [SCRIPT, "--check", "mac", B, join(dir, "k.txt")])).rejects.toMatchObject({ code: 1 });
    await expect(execFileAsync("node", [SCRIPT, "--check", "mac", A, join(dir, "missing.txt")])).rejects.toMatchObject({ code: 1 });
  });
});
