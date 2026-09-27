import { execFile } from "node:child_process";
import { mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { GITHUB_ASSET_LIMIT_BYTES, MAX_SHELL_ARCHIVE_BYTES, checkArchiveSize } from "./shell-archive.mjs";

const SCRIPT = fileURLToPath(new URL("./shell-archive.mjs", import.meta.url));
const run = promisify(execFile);

describe("checkArchiveSize", () => {
  it("caps archives at 1.8 GiB, under GitHub's 2 GiB asset limit", () => {
    expect(MAX_SHELL_ARCHIVE_BYTES).toBe(Math.floor(1.8 * 1024 ** 3));
    expect(MAX_SHELL_ARCHIVE_BYTES).toBeLessThan(GITHUB_ASSET_LIMIT_BYTES);
  });

  it("accepts an archive at or under the cap", () => {
    expect(checkArchiveSize("a.tar.zst", MAX_SHELL_ARCHIVE_BYTES).ok).toBe(true);
    expect(checkArchiveSize("a.tar.zst", 500 * 1024 ** 2)).toEqual({ ok: true, message: "a.tar.zst: 524288000 bytes (500.0 MiB)" });
  });

  it("rejects the size of the uncompressed Windows x64 shell that GitHub refused", () => {
    const result = checkArchiveSize("shell-windows-x64.tar", 2_146_621_440);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("2146621440 bytes");
    expect(result.message).toContain("HTTP 422");
  });

  it("rejects an empty archive and invalid sizes", () => {
    expect(checkArchiveSize("a", 0).ok).toBe(false);
    expect(() => checkArchiveSize("a", -1)).toThrow(/invalid size/);
  });
});

describe("shell-archive.mjs check-size CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "shell-archive-"));

  it("passes a real file under the cap", async () => {
    const file = join(dir, "small.tar.zst");
    writeFileSync(file, "x".repeat(1024));
    const { stdout } = await run("node", [SCRIPT, "check-size", file]);
    expect(stdout).toContain("1024 bytes");
  });

  it("fails a real file over --max-bytes with a clear error", async () => {
    const file = join(dir, "big.tar.zst");
    writeFileSync(file, "");
    truncateSync(file, 4096);
    await expect(run("node", [SCRIPT, "check-size", file, "--max-bytes", "2048"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("over the 2048-byte"),
    });
  });

  it("fails when the archive is missing", async () => {
    await expect(run("node", [SCRIPT, "check-size", join(dir, "missing")])).rejects.toMatchObject({ code: 1 });
  });
});
