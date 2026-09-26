import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  archiveName,
  buildInnerManifest,
  buildPointer,
  pack,
  prunePlan,
  selectBaseRelease,
  sha256Hex,
  shellKeysFor,
  uiVersionFor,
} from "./ui-bundle.mjs";

const SCRIPT = fileURLToPath(new URL("./ui-bundle.mjs", import.meta.url));
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

describe("ui-bundle", () => {
  it("derives a ui version from the base version, time, and sha", () => {
    expect(uiVersionFor("0.10.330", "abcdef1234", new Date("2026-09-26T10:15:00.123Z"))).toBe(
      "0.10.330+ui.20260926T101500Z.abcdef1",
    );
    expect(() => uiVersionFor("latest", "x")).toThrow(/SemVer/);
  });

  it("names archives without '+', which GitHub rewrites", () => {
    expect(archiveName("0.10.330+ui.1")).toBe("ui-0.10.330_ui.1.tar.gz");
  });

  it("requires shell keys and dedupes them", () => {
    expect(() => buildInnerManifest({ uiVersion: "0.10.330+ui.1", shellKeys: [] })).toThrow(/shell-key/);
    const m = buildInnerManifest({ uiVersion: "0.10.330+ui.1", shellKeys: [KEY_A, KEY_A, KEY_B], createdAt: "t" });
    expect(m).toEqual({ uiVersion: "0.10.330+ui.1", shellKeys: [KEY_A, KEY_B], createdAt: "t" });
    expect(() => buildInnerManifest({ uiVersion: "../x", shellKeys: [KEY_A] })).toThrow(/invalid/);
  });

  it("packs dist with the inner manifest and records the archive sha256", () => {
    const root = mkdtempSync(join(tmpdir(), "ui-bundle-test-"));
    const dist = join(root, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "<html></html>");
    writeFileSync(join(dist, "assets", "app.js"), "1");
    const out = join(root, "out");
    const { archive, manifest } = pack({ dist, uiVersion: "0.10.330+ui.1", shellKeys: [KEY_A], out, createdAt: "t" });
    expect(manifest.sha256).toBe(sha256Hex(readFileSync(archive)));
    expect(JSON.parse(readFileSync(join(out, "ui-manifest.json"), "utf8")).shellKeys).toEqual([KEY_A]);
    const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
    expect(listing).toContain("hq-ui-manifest.json");
    expect(listing).toMatch(/dist\/index\.html/);
    expect(listing).toMatch(/dist\/assets\/app\.js/);
    expect(listing).not.toMatch(/\._/);
  });

  it("refuses to pack without index.html", () => {
    const root = mkdtempSync(join(tmpdir(), "ui-bundle-test-"));
    mkdirSync(join(root, "dist"));
    expect(() => pack({ dist: join(root, "dist"), uiVersion: "0.10.330+ui.1", shellKeys: [KEY_A], out: root })).toThrow(/index\.html/);
  });

  it("builds the pointer an app polls", () => {
    const manifest = { uiVersion: "0.10.330+ui.1", shellKeys: [KEY_A], sha256: "c".repeat(64), size: 10, createdAt: "t" };
    const pointer = buildPointer({ manifest, signature: "c2ln\n", url: "https://x/ui.tar.gz", channel: "beta" });
    expect(pointer).toEqual({
      channel: "beta",
      uiVersion: "0.10.330+ui.1",
      shellKeys: [KEY_A],
      sha256: "c".repeat(64),
      size: 10,
      createdAt: "t",
      url: "https://x/ui.tar.gz",
      signature: "c2ln",
    });
    expect(() => buildPointer({ manifest, signature: "s", url: "http://x", channel: "beta" })).toThrow(/https/);
    expect(() => buildPointer({ manifest, signature: "s", url: "https://x", channel: "nightly" })).toThrow(/channel/);
    expect(() => buildPointer({ manifest, signature: " ", url: "https://x", channel: "beta" })).toThrow(/signature/);
    expect(() => buildPointer({ manifest, signature: "s", url: "file:///tmp/x", channel: "beta" })).toThrow(/https/);
    expect(buildPointer({ manifest, signature: "s", url: "file:///tmp/x", channel: "beta", allowLocal: true }).url).toBe("file:///tmp/x");
  });

  it("selects the base release per channel, skipping drafts and non-version tags", () => {
    const releases = [
      { tag_name: "ui-updates", prerelease: true, published_at: "2026-09-27" },
      { tag_name: "shell-cache", prerelease: true, published_at: "2026-09-26" },
      { tag_name: "v0.10.331-beta.1", prerelease: true, published_at: "2026-09-25T12:00:00Z" },
      { tag_name: "v0.10.332", draft: true, prerelease: false, published_at: null },
      { tag_name: "v0.10.330", prerelease: false, published_at: "2026-09-25T10:00:00Z" },
      { tag_name: "v0.10.329", prerelease: false, published_at: "2026-09-24T10:00:00Z" },
    ];
    expect(selectBaseRelease(releases, "stable")).toEqual({ tag: "v0.10.330", version: "0.10.330" });
    expect(selectBaseRelease([releases], "beta")).toEqual({ tag: "v0.10.331-beta.1", version: "0.10.331-beta.1" });
    expect(() => selectBaseRelease([], "stable")).toThrow(/no published release/);
  });

  it("collects shell keys from the base manifest plus extras", () => {
    expect(shellKeysFor({ shellKeys: [KEY_A] }, [KEY_B, KEY_A])).toEqual([KEY_A, KEY_B]);
    expect(shellKeysFor(null, [KEY_B])).toEqual([KEY_B]);
    expect(() => shellKeysFor(null, [])).toThrow(/no shell keys/);
    expect(() => shellKeysFor({ shellKeys: ["nope"] })).toThrow(/not a shell key/);
  });

  it("prunes old ui-updates archives but keeps referenced ones and pointers", () => {
    const assets = [
      { name: "ui-latest-beta.json", created_at: "2026-09-30" },
      { name: "ui-3.tar.gz", created_at: "2026-09-29" },
      { name: "ui-3.tar.gz.sig", created_at: "2026-09-29" },
      { name: "ui-2.tar.gz", created_at: "2026-09-28" },
      { name: "ui-2.tar.gz.sig", created_at: "2026-09-28" },
      { name: "ui-1.tar.gz", created_at: "2026-09-27" },
      { name: "ui-1.tar.gz.sig", created_at: "2026-09-27" },
    ];
    expect(prunePlan(assets, 1)).toEqual(["ui-2.tar.gz", "ui-2.tar.gz.sig", "ui-1.tar.gz", "ui-1.tar.gz.sig"]);
    expect(prunePlan(assets, 1, ["ui-1.tar.gz"])).toEqual(["ui-2.tar.gz", "ui-2.tar.gz.sig"]);
    expect(prunePlan(assets, 10)).toEqual([]);
  });

  it("CLI: version and keys", () => {
    const v = execFileSync("node", [SCRIPT, "version", "--app-version", "0.10.330", "--sha", "1234567890", "--now", "2026-09-26T00:00:00Z"], { encoding: "utf8" });
    expect(v.trim()).toBe("0.10.330+ui.20260926T000000Z.1234567");
    const root = mkdtempSync(join(tmpdir(), "ui-bundle-cli-"));
    writeFileSync(join(root, "m.json"), JSON.stringify({ shellKeys: [KEY_A] }));
    const keys = execFileSync("node", [SCRIPT, "keys", "--manifest", join(root, "m.json"), "--extra", KEY_B], { encoding: "utf8" });
    expect(keys.trim().split("\n")).toEqual([KEY_A, KEY_B]);
  });
});
