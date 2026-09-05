import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MOBILE_REDIRECT_URI } from "./mobile-auth";

/**
 * The sign-in callback crosses four files that cannot import each other: the
 * TypeScript flow, the iOS Info.plist, the AndroidManifest, and the Cognito app
 * client (`repos/private/hq-pro/infra/cognito.ts`, out of reach here). Cognito
 * rejects any redirect_uri not on its registered list, and the OS routes the
 * callback only to an app that claims the scheme — so a change to one of them
 * alone produces a sign-in that opens the browser and never comes back, with
 * nothing wrong in any log.
 *
 * The iOS half is pinned in `src-tauri/Info.ios.plist`, NOT in the generated
 * `gen/apple/.../Info.plist`: `tauri ios build` rewrites that file on every
 * run, so an edit there is gone by the time the app is packaged. It was, once
 * — the scheme was committed, reviewed, and simply absent from the built
 * bundle. Tauri merges `Info.ios.plist` in for exactly this reason.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const NATIVE = resolve(HERE, "../../src-tauri");

const redirect = new URL(MOBILE_REDIRECT_URI);
/** "hqmobile" — URL#protocol keeps the colon. */
const SCHEME = redirect.protocol.replace(/:$/, "");
/** "auth" — a custom-scheme URL puts the first path segment in the host. */
const HOST = redirect.host;

function native(path: string): string {
  return readFileSync(resolve(NATIVE, path), "utf8");
}

describe("the mobile sign-in callback is claimed on every layer", () => {
  it("is the callback URL registered on the Cognito app client", () => {
    // Pinned literally: this string is chosen by hq-pro's infra, not here.
    // Changing it requires a Cognito deploy, so a silent edit is a bug.
    expect(MOBILE_REDIRECT_URI).toBe("hqmobile://auth");
  });

  it("is claimed by the iOS bundle, from the file the build does not overwrite", () => {
    const plist = native("Info.ios.plist");
    expect(plist).toContain("<key>CFBundleURLSchemes</key>");
    expect(plist).toContain(`<string>${SCHEME}</string>`);
  });

  it("does not disagree with the generated plist the build writes back", () => {
    // `tauri ios build` regenerates gen/apple/.../Info.plist from
    // tauri.conf.json + Info.ios.plist and commits the merged result back to
    // the source tree. So the generated file is OUTPUT: it may carry the key,
    // but only with the same value. A generated plist that claims a different
    // scheme means someone hand-edited it and the next build will drop that
    // edit — which is exactly how the scheme went missing from a packaged
    // build once already.
    const generated = native("gen/apple/hq-work-mobile_iOS/Info.plist");
    if (!generated.includes("CFBundleURLTypes")) return;
    const claimed = [...generated.matchAll(/<string>([\w.-]+)<\/string>/g)]
      .map((m) => m[1])
      .filter((value) => value === SCHEME);
    expect(claimed, "the generated plist claims a different scheme").toEqual([
      SCHEME,
    ]);
  });

  it("is claimed by the Android activity", () => {
    const manifest = native("gen/android/app/src/main/AndroidManifest.xml");
    expect(manifest).toContain(
      `<data android:scheme="${SCHEME}" android:host="${HOST}" />`,
    );
    // Without BROWSABLE the browser's redirect cannot reach the app at all.
    expect(manifest).toContain(
      '<category android:name="android.intent.category.BROWSABLE" />',
    );
  });

  it("is claimed by the desktop half of the deep-link plugin config", () => {
    const conf = JSON.parse(native("tauri.conf.json")) as {
      plugins?: { "deep-link"?: { desktop?: { schemes?: string[] } } };
    };
    expect(conf.plugins?.["deep-link"]?.desktop?.schemes).toContain(SCHEME);
  });

  it("has the native permissions the flow calls", () => {
    // Missing either one fails at runtime with a permission denial, on the
    // device only — the web and unit builds never exercise this path.
    const cap = JSON.parse(native("capabilities/default.json")) as {
      permissions: string[];
    };
    expect(cap.permissions).toContain("deep-link:default");
    expect(cap.permissions).toContain("opener:allow-open-url");
  });

  it("initialises both plugins in the Rust shell", () => {
    const lib = native("src/lib.rs");
    expect(lib).toContain("tauri_plugin_deep_link::init()");
    expect(lib).toContain("tauri_plugin_opener::init()");
  });

  it("depends on both crates", () => {
    const cargo = native("Cargo.toml")
      .split("\n")
      .map((line) => line.split("#")[0].trim())
      .filter(Boolean)
      .join("\n");
    expect(cargo).toContain("tauri-plugin-deep-link");
    expect(cargo).toContain("tauri-plugin-opener");
  });
});
