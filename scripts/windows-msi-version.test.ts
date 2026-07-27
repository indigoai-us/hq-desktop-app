import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveWindowsMsiVersion,
  writeWindowsMsiVersionConfig,
} from "./windows-msi-version.mjs";

describe("Windows MSI release version", () => {
  it.each([
    ["0.10.35", "0.10.35"],
    ["0.10.35-beta.1", "0.10.35"],
    ["0.10.35-beta.42", "0.10.35"],
    ["0.10.35-alpha.0", "0.10.35"],
  ])("maps strict app version %s to WiX ProductVersion %s", (appVersion, expected) => {
    expect(deriveWindowsMsiVersion(appVersion)).toBe(expected);
  });

  it.each([
    "0.10",
    "v0.10.35-beta.1",
    "0.10.35-beta",
    "0.10.35-beta.x",
    "0.10.35-rc.1",
    "00.10.35",
    "0.010.35",
    "0.10.035",
  ])("rejects unsupported app version %s", (appVersion) => {
    expect(() => deriveWindowsMsiVersion(appVersion)).toThrow(
      "Unsupported app version",
    );
  });

  it.each([
    ["256.0.0", "major"],
    ["0.256.0", "minor"],
    ["0.0.65536", "patch"],
  ])("rejects WiX %s overflow", (appVersion, field) => {
    expect(() => deriveWindowsMsiVersion(appVersion)).toThrow(
      `Windows MSI ${field}`,
    );
  });

  it("writes a Tauri overlay without changing the app/updater SemVer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hq-msi-version-"));
    const outputPath = join(directory, "tauri.windows.msi-version.conf.json");

    await writeWindowsMsiVersionConfig(outputPath, "0.10.35-beta.1");

    await expect(readFile(outputPath, "utf8")).resolves.toBe(
      `${JSON.stringify(
        {
          bundle: {
            windows: {
              wix: {
                version: "0.10.35",
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
  });
});
