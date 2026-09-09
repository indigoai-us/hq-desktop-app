import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// The menubar app's notification banner (`dm-banner` webview window) leaked a
// renderer handle set per window build, and the window was rebuilt on every
// show after a dismiss. With macOS's 256 soft open-file limit the process hit
// EMFILE after ~28 builds and every realtime-sync child spawn failed. These
// pin the lifecycle rules that keep the app under the limit:
//   1. dismiss hides the banner window; it never closes (destroys) it,
//   2. show routes creation through the single-flight helper,
//   3. the meeting poller caps banners per poll,
//   4. main() raises the open-file soft limit before Tauri starts.

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriSrc = resolve(rootDir, "apps/sync/src-tauri/src");

let banner = "";
let meetings = "";
let main = "";

function between(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`Missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

beforeAll(async () => {
  [banner, meetings, main] = await Promise.all([
    readFile(resolve(tauriSrc, "commands/banner.rs"), "utf8"),
    readFile(resolve(tauriSrc, "commands/meetings.rs"), "utf8"),
    readFile(resolve(tauriSrc, "main.rs"), "utf8"),
  ]);
});

describe("banner window lifecycle contract", () => {
  it("hides the banner window on dismiss instead of destroying it", () => {
    const dismiss = between(banner, "fn dismiss_banner_inner(", "\n}\n");
    expect(dismiss).toContain("window.hide()");
    expect(dismiss).not.toContain("window.close()");
    expect(dismiss).not.toContain("window.destroy()");
  });

  it("never closes the banner window anywhere in the banner module", () => {
    // `close()` on the dm-banner WebviewWindow tears down the webview whose
    // renderer handles are never returned; there must be no such call site.
    expect(banner).not.toMatch(/\bwindow\.close\(\)/);
  });

  it("routes banner window creation through the single-flight helper", () => {
    const show = between(banner, "pub async fn show_banner(", "\n}\n");
    expect(show).toContain("get_or_create_serialized(");
    // The builder must only be reachable through that helper.
    expect(show).not.toContain("WebviewWindowBuilder::new(");
    expect(banner).toContain("static BANNER_WINDOW_CREATE");
  });

  it("caps how many unattributed-meeting banners a single poll may raise", () => {
    const poll = between(meetings, "pub async fn poll_unattributed_once(", "\n}\n");
    expect(poll).toContain("cap_unattributed_notifications(");
    expect(poll).toContain("UNATTRIBUTED_BANNER_CAP_PER_POLL");
  });

  it("raises the open-file soft limit before Tauri starts", () => {
    const mainFn = between(main, "fn main() {", "tauri::Builder::default()");
    expect(mainFn).toContain("fd_limit::raise_open_file_limit()");
    expect(main).toContain("mod fd_limit;");
  });
});
