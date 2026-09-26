import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseAssetName, selectAssetsToDelete } from "./prune-shell-cache.mjs";

const SCRIPT = fileURLToPath(new URL("./prune-shell-cache.mjs", import.meta.url));
const key = (n: number) => n.toString(16).padStart(64, "0");
const asset = (target: string, n: number, day: number) => ({
  name: `shell-${target}-${key(n)}.${target === "macos" ? "tar.gz" : "tar"}`,
  updated_at: `2026-09-${String(day).padStart(2, "0")}T00:00:00Z`,
});

describe("parseAssetName", () => {
  it("recognises all three targets and ignores anything else", () => {
    expect(parseAssetName(`shell-macos-${key(1)}.tar.gz`)).toEqual({ target: "macos", key: key(1) });
    expect(parseAssetName(`shell-windows-arm64-${key(2)}.tar`)).toEqual({ target: "windows-arm64", key: key(2) });
    expect(parseAssetName("notes.txt")).toBeNull();
    expect(parseAssetName(`shell-macos-${key(1)}.zip`)).toBeNull();
  });
});

describe("selectAssetsToDelete", () => {
  it("keeps the newest N for the target and deletes the rest", () => {
    const assets = Array.from({ length: 9 }, (_, i) => asset("windows-x64", i + 1, i + 1));
    const doomed = selectAssetsToDelete(assets, { target: "windows-x64", keep: 6 });
    expect(doomed).toEqual([3, 2, 1].map((n) => asset("windows-x64", n, n).name));
  });

  it("never touches other targets or unknown assets", () => {
    const assets = [
      ...Array.from({ length: 8 }, (_, i) => asset("macos", i + 1, i + 1)),
      asset("windows-x64", 50, 1),
      { name: "README.txt", updated_at: "2020-01-01T00:00:00Z" },
    ];
    const doomed = selectAssetsToDelete(assets, { target: "macos", keep: 6 });
    expect(doomed).toHaveLength(2);
    expect(doomed.every((n) => n.startsWith("shell-macos-"))).toBe(true);
  });

  it("never deletes the protected (current) key even if it is old", () => {
    const assets = Array.from({ length: 8 }, (_, i) => asset("windows-arm64", i + 1, i + 1));
    const doomed = selectAssetsToDelete(assets, { target: "windows-arm64", keep: 6, protectKey: key(1) });
    expect(doomed).toEqual([asset("windows-arm64", 2, 2).name]);
  });

  it("deletes nothing at or under the limit", () => {
    const assets = Array.from({ length: 6 }, (_, i) => asset("macos", i + 1, i + 1));
    expect(selectAssetsToDelete(assets, { target: "macos", keep: 6 })).toEqual([]);
  });

  it("rejects an unknown target or a non-positive keep", () => {
    expect(() => selectAssetsToDelete([], { target: "linux", keep: 6 })).toThrow();
    expect(() => selectAssetsToDelete([], { target: "macos", keep: 0 })).toThrow();
  });
});

describe("CLI", () => {
  it("reads assets JSON on stdin and prints names to delete", async () => {
    const assets = Array.from({ length: 7 }, (_, i) => asset("macos", i + 1, i + 1));
    const out = await new Promise<string>((resolve, reject) => {
      const child = execFile("node", [SCRIPT, "--target", "macos", "--keep", "6"], (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      );
      child.stdin!.end(JSON.stringify(assets));
    });
    expect(out.trim()).toBe(asset("macos", 1, 1).name);
  });
});
