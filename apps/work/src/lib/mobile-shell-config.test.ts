import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Config guards for the mobile native shell.
 *
 * `svelte.config.js` selects the server hook on `process.env.TAURI`: set means
 * the empty Tauri hook, unset means the Cognito/session web hook plus the
 * hosted route handlers. So a mobile command that forgets `TAURI=1` silently
 * runs the phone against the WEB auth path, which the static mobile build does
 * not ship. That is invisible until sign-in fails on a device, so it is pinned
 * here instead.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "../..");

const pkg = JSON.parse(readFileSync(resolve(APP, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const conf = JSON.parse(
  readFileSync(resolve(APP, "src-tauri/tauri.conf.json"), "utf8"),
) as { build: Record<string, string>; identifier: string };
/**
 * Dependency lines only. The Cargo.toml comment deliberately NAMES the
 * desktop-only crates it excludes, so a naive substring search over the whole
 * file matches the prose that documents their absence and reports the opposite
 * of the truth.
 */
const cargoDeps = readFileSync(resolve(APP, "src-tauri/Cargo.toml"), "utf8")
  .split("\n")
  .map((line) => line.split("#")[0].trim())
  .filter(Boolean)
  .join("\n");

/** `pnpm foo` -> the body of the `foo` script. */
function scriptBehind(command: string): string {
  const name = command.replace(/^(pnpm|npm run|yarn)\s+/, "").trim();
  const body = pkg.scripts[name];
  expect(body, `package.json has no "${name}" script`).toBeDefined();
  return body;
}

describe("mobile shell config", () => {
  it("builds the shared source with the Tauri flag set", () => {
    expect(scriptBehind(conf.build.beforeBuildCommand)).toContain("TAURI=1");
  });

  it("runs the dev server with the Tauri flag set", () => {
    // Without this the phone gets src/hooks.server (web Cognito) instead of
    // src/hooks.tauri.
    expect(scriptBehind(conf.build.beforeDevCommand)).toContain("TAURI=1");
  });

  it("serves the same static output the desktop host consumes", () => {
    expect(conf.build.frontendDist).toBe("../build");
  });

  it("keeps the identifier HQ already records for the Work app", () => {
    expect(conf.identifier).toBe("ai.indigo.hq-work");
  });

  it.each([
    "tray-icon",
    "window-vibrancy",
    "tauri-plugin-global-shortcut",
    "tauri-plugin-single-instance",
    "macos-private-api",
    "rfd",
  ])("does not depend on the desktop-only %s", (dep) => {
    // None of these build for iOS or Android.
    expect(cargoDeps).not.toContain(dep);
  });
});
