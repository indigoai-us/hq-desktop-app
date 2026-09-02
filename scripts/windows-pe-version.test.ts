import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as ResEdit from "resedit";
import {
  applyVersionToResourceEntries,
  parseAppVersion,
  patchPeVersionBuffer,
} from "./windows-pe-version.mjs";

describe("parseAppVersion", () => {
  it.each([
    ["0.10.175", { major: 0, minor: 10, patch: 175, revision: 0, text: "0.10.175" }],
    ["0.10.175.1", { major: 0, minor: 10, patch: 175, revision: 1, text: "0.10.175.1" }],
    ["1.2.3-beta.1", { major: 1, minor: 2, patch: 3, revision: 0, text: "1.2.3-beta.1" }],
  ])("parses %s", (version, expected) => {
    expect(parseAppVersion(version)).toEqual(expected);
  });

  it.each(["0.10", "v0.10.175", "00.10.175", ""])("rejects %s", (version) => {
    expect(() => parseAppVersion(version)).toThrow("Unsupported app version");
  });
});

describe("applyVersionToResourceEntries", () => {
  it("stamps FileVersion and ProductVersion on a new VERSIONINFO block", () => {
    const entries: unknown[] = [];
    const created = ResEdit.Resource.VersionInfo.create({
      lang: 1033,
      fixedInfo: {},
      strings: [
        {
          lang: 1033,
          codepage: 1200,
          values: { FileDescription: "HQ" },
        },
      ],
    });
    created.outputToResourceEntries(entries as never);

    expect(applyVersionToResourceEntries(entries as never, "0.10.175")).toBe(1);

    const patched = ResEdit.Resource.VersionInfo.fromEntries(entries as never)[0];
    const values = patched.getStringValues({ lang: 1033, codepage: 1200 });
    expect(values.ProductVersion).toBe("0.10.175");
    expect(values.FileVersion).toBe("0.10.175");
    expect(values.FileDescription).toBe("HQ");
    expect(patched.fixedInfo.fileVersionMS).toBe((0 << 16) | 10);
    expect(patched.fixedInfo.fileVersionLS).toBe((175 << 16) | 0);
    expect(patched.fixedInfo.productVersionMS).toBe((0 << 16) | 10);
    expect(patched.fixedInfo.productVersionLS).toBe((175 << 16) | 0);
  });

  it("replaces a previous version including a longer target string", () => {
    const entries: unknown[] = [];
    const created = ResEdit.Resource.VersionInfo.create({
      lang: 1033,
      fixedInfo: {},
      strings: [{ lang: 1033, codepage: 1200, values: {} }],
    });
    created.setFileVersion("0.10.9.0");
    created.setProductVersion("0.10.9.0");
    created.outputToResourceEntries(entries as never);

    applyVersionToResourceEntries(entries as never, "0.10.10");

    const patched = ResEdit.Resource.VersionInfo.fromEntries(entries as never)[0];
    const values = patched.getStringValues({ lang: 1033, codepage: 1200 });
    expect(values.ProductVersion).toBe("0.10.10");
    expect(values.FileVersion).toBe("0.10.10");
  });
});

describe("patchPeVersionBuffer", () => {
  it("rejects a buffer that is not a PE", () => {
    expect(() => patchPeVersionBuffer(Buffer.from("not a pe"), "0.10.175")).toThrow();
  });
});

describe("windows-pe-version CLI", () => {
  it("requires --exe and --version", async () => {
    const { main } = await import("./windows-pe-version.mjs");
    await expect(main([])).rejects.toThrow("--exe is required");
    await expect(main(["--exe", "missing.exe"])).rejects.toThrow("--version is required");
  });

  it("rejects a missing executable", async () => {
    const { main } = await import("./windows-pe-version.mjs");
    const directory = await mkdtemp(join(tmpdir(), "hq-pe-version-"));
    await expect(
      main(["--exe", join(directory, "absent.exe"), "--version", "0.10.175"]),
    ).rejects.toThrow();
  });

  it("rejects a non-PE file", async () => {
    const { main } = await import("./windows-pe-version.mjs");
    const directory = await mkdtemp(join(tmpdir(), "hq-pe-version-"));
    const exePath = join(directory, "notes.txt");
    await writeFile(exePath, "hello");
    await expect(main(["--exe", exePath, "--version", "0.10.175"])).rejects.toThrow();
    await expect(readFile(exePath, "utf8")).resolves.toBe("hello");
  });
});
