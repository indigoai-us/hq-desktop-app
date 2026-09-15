import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs helper without type declarations
import { injectBaseProbeMain } from "./sync-cancel-base-probe-main.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = "    // BASE PROBE\n";

describe("sync cancel base probe injection", () => {
  it("lands in the menubar app's main when the webdriver main comes first", async () => {
    const main = await readFile(resolve(rootDir, "apps/sync/src-tauri/src/main.rs"), "utf8");
    const out = injectBaseProbeMain(main, PROBE);
    const probeAt = out.indexOf(PROBE);
    const appMainAt = out.indexOf('#[cfg(not(feature = "meet-native-webdriver"))]\nfn main() {');
    expect(appMainAt).toBeGreaterThanOrEqual(0);
    expect(probeAt).toBeGreaterThan(appMainAt);
    const webdriverMainAt = out.indexOf('#[cfg(feature = "meet-native-webdriver")]\nfn main() {');
    if (webdriverMainAt >= 0) expect(probeAt).toBeGreaterThan(webdriverMainAt);
  });

  it("uses the only main in an older base", () => {
    const out = injectBaseProbeMain("fn helper() {}\n\nfn main() {\n    run();\n}\n", PROBE);
    expect(out).toBe(`fn helper() {}\n\nfn main() {\n${PROBE}\n    run();\n}\n`);
  });

  it("fails loudly when there is no main", () => {
    expect(() => injectBaseProbeMain("fn helper() {}\n", PROBE)).toThrow(/insertion marker/);
  });
});
