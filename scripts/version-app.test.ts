import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { main, readVersionFromVersionsToml } from "./version-app";

describe("version-app", () => {
  it("parses the app version from versions.toml", async () => {
    const versionsToml = [
      "[product]",
      'name = "HQ Sync"',
      'version = "1.2.3"',
      'base_crate = "hq-sync-menubar"',
      "",
    ].join("\n");

    expect(readVersionFromVersionsToml(versionsToml)).toBe("1.2.3");
  });

  it("detects mismatched app files in check mode without writing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "version-app-"));
    await writeFixture(rootDir, "0.1.0");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const status = await main(["--check", "--root", rootDir]);
      const messages = error.mock.calls.map((call) => call.join(" "));

      expect(status).toBe(1);
      expect(messages).toContain("App version files differ from versions.toml (0.9.2):");
      expect(messages).toContain("- apps/sync/package.json");
      expect(messages).toContain("- apps/sync/src-tauri/tauri.conf.json");
      expect(messages).toContain("- apps/sync/src-tauri/Cargo.toml");
      expect(messages).toContain("- apps/sync/src-tauri/Cargo.lock");
    } finally {
      error.mockRestore();
    }

    await expect(readFile(join(rootDir, "apps/sync/package.json"), "utf8"))
      .resolves.toContain('"version": "0.1.0"');
  });

  it("stamps versions.toml and every app file from --set-version", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "version-app-"));
    await writeFixture(rootDir, "0.9.2");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      expect(await main(["--set-version", "1.4.0", "--root", rootDir])).toBe(0);
      expect(log.mock.calls.map((call) => call.join(" "))).toContain(
        "Stamped app version 1.4.0 in 5 file(s).",
      );
    } finally {
      log.mockRestore();
    }

    // versions.toml is the source the release workflow validates against, so
    // it has to move too — not just the four files derived from it.
    await expect(readFile(join(rootDir, "versions.toml"), "utf8"))
      .resolves.toContain('version = "1.4.0"');
    await expect(readFile(join(rootDir, "apps/sync/package.json"), "utf8"))
      .resolves.toContain('"version": "1.4.0"');
    await expect(readFile(join(rootDir, "apps/sync/src-tauri/tauri.conf.json"), "utf8"))
      .resolves.toContain('"version": "1.4.0"');
    await expect(readFile(join(rootDir, "apps/sync/src-tauri/Cargo.toml"), "utf8"))
      .resolves.toContain('version = "1.4.0"');
    await expect(readFile(join(rootDir, "apps/sync/src-tauri/Cargo.lock"), "utf8"))
      .resolves.toContain('name = "hq-sync-menubar"\nversion = "1.4.0"');
  });

  it("stamps a prerelease version", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "version-app-"));
    await writeFixture(rootDir, "0.9.2");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      expect(await main(["--set-version", "1.4.0-beta.2", "--root", rootDir])).toBe(0);
    } finally {
      log.mockRestore();
    }

    await expect(readFile(join(rootDir, "versions.toml"), "utf8"))
      .resolves.toContain('version = "1.4.0-beta.2"');
    await expect(readFile(join(rootDir, "apps/sync/src-tauri/Cargo.toml"), "utf8"))
      .resolves.toContain('version = "1.4.0-beta.2"');
  });

  it("leaves only the [product] version alone in other versions.toml tables", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "version-app-"));
    await writeFixture(rootDir, "0.9.2");
    await writeFile(
      join(rootDir, "versions.toml"),
      [
        "[product]",
        'name = "HQ Sync"',
        'version = "0.9.2"',
        'base_crate = "hq-sync-menubar"',
        "",
        "[updater]",
        'version = "schema-1"',
        "",
      ].join("\n"),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      expect(await main(["--set-version", "1.4.0", "--root", rootDir])).toBe(0);
    } finally {
      log.mockRestore();
    }

    const versionsToml = await readFile(join(rootDir, "versions.toml"), "utf8");
    expect(versionsToml).toContain('version = "1.4.0"');
    expect(versionsToml).toContain('version = "schema-1"');
  });

  it("rejects a version that is not semver", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "version-app-"));
    await writeFixture(rootDir, "0.9.2");

    await expect(main(["--set-version", "v1.4.0", "--root", rootDir]))
      .rejects.toThrow("--set-version expects X.Y.Z or X.Y.Z-prerelease, got: v1.4.0");

    // A rejected version must not leave the tree half-stamped.
    await expect(readFile(join(rootDir, "versions.toml"), "utf8"))
      .resolves.toContain('version = "0.9.2"');
  });

  it("rejects --set-version without a value", async () => {
    await expect(main(["--set-version"])).rejects.toThrow("--set-version requires a version");
  });
});

async function writeFixture(rootDir: string, appVersion: string): Promise<void> {
  await mkdir(join(rootDir, "apps/sync/src-tauri"), { recursive: true });

  await writeFile(
    join(rootDir, "versions.toml"),
    [
      "[product]",
      'name = "HQ Sync"',
      'version = "0.9.2"',
      'base_crate = "hq-sync-menubar"',
      "",
    ].join("\n"),
  );

  await writeFile(
    join(rootDir, "apps/sync/package.json"),
    `${JSON.stringify({ name: "hq-sync", version: appVersion, private: true }, null, 2)}\n`,
  );

  await writeFile(
    join(rootDir, "apps/sync/src-tauri/tauri.conf.json"),
    `${JSON.stringify({ productName: "HQ", version: appVersion, identifier: "ai.indigo.hq-sync-menubar" }, null, 2)}\n`,
  );

  await writeFile(
    join(rootDir, "apps/sync/src-tauri/Cargo.toml"),
    [
      "[package]",
      'name = "hq-sync-menubar"',
      `version = "${appVersion}"`,
      'edition = "2021"',
      "",
    ].join("\n"),
  );

  await writeFile(
    join(rootDir, "apps/sync/src-tauri/Cargo.lock"),
    [
      "# This file is automatically @generated by Cargo.",
      "version = 4",
      "",
      "[[package]]",
      'name = "hmac"',
      'version = "0.13.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      "",
      "[[package]]",
      'name = "hq-sync-menubar"',
      `version = "${appVersion}"`,
      "dependencies = []",
      "",
    ].join("\n"),
  );
}
