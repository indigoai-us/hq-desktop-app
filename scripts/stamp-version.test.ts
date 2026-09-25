import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assertValidVersion, patchInfoPlist, renderVersionTxt, stampBundle } from "./stamp-version.mjs";

const SAMPLE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleShortVersionString</key>
	<string>0.0.0</string>
	<key>CFBundleVersion</key>
	<string>0.0.0</string>
	<key>CFBundleIdentifier</key>
	<string>ai.indigo.hq-sync-menubar</string>
</dict>
</plist>
`;

describe("stamp-version", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true });
  });

  it("rejects a non-semver version", () => {
    expect(() => assertValidVersion("not-a-version")).toThrow();
    expect(() => assertValidVersion("1.2.3")).not.toThrow();
    expect(() => assertValidVersion("1.2.3-beta.4")).not.toThrow();
  });

  it("renders version.txt with a trailing newline", () => {
    expect(renderVersionTxt("1.2.3")).toBe("1.2.3\n");
  });

  it("patches both plist version keys and leaves everything else byte-identical", () => {
    const patched = patchInfoPlist(SAMPLE_PLIST, "1.2.3");
    expect(patched).toContain("<key>CFBundleShortVersionString</key>\n\t<string>1.2.3</string>");
    expect(patched).toContain("<key>CFBundleVersion</key>\n\t<string>1.2.3</string>");
    expect(patched).toContain("ai.indigo.hq-sync-menubar");
    expect(patched.split("\n").length).toBe(SAMPLE_PLIST.split("\n").length);
  });

  it("throws if a required plist key is missing", () => {
    const broken = SAMPLE_PLIST.replace("CFBundleVersion", "SomethingElse");
    expect(() => patchInfoPlist(broken, "1.2.3")).toThrow(/CFBundleVersion/);
  });

  it("stamps a bundle: writes version.txt and patches Info.plist on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stamp-version-"));
    cleanup.push(dir);
    const plistPath = join(dir, "Info.plist");
    await import("node:fs/promises").then((fs) => fs.writeFile(plistPath, SAMPLE_PLIST, "utf8"));

    await stampBundle({ version: "2.3.4", resourcesDir: dir, infoPlistPath: plistPath });

    expect(await readFile(join(dir, "version.txt"), "utf8")).toBe("2.3.4\n");
    expect(await readFile(plistPath, "utf8")).toContain("<string>2.3.4</string>");
  });
});
