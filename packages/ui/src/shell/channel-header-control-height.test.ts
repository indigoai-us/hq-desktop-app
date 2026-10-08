/**
 * The channel header's filled controls line up as one set (owner review
 * 2026-10-08): the Chat / Details (and Chat / Board / Files) tabs had been
 * 24px tall beside the 28px notify pill and a 29px member count. All three
 * now read the app's one button height, --hq-btn-h (button-standard.css).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");
const block = (file: string, selector: string) => {
  const css = readFileSync(join(src, file), "utf8");
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`\\n\\s*${esc}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
};

describe("channel header control height", () => {
  it("the notify pill reads the standard button height", () => {
    expect(block("chat/ChannelMuteControl.svelte", ".mute-toggle,\n  .mute-chevron")).toMatch(/height:\s*var\(--hq-btn-h\)/);
    expect(block("chat/ChannelMuteControl.svelte", ".mute-toggle")).toMatch(/width:\s*var\(--hq-btn-h\)/);
  });

  it.each([".project-tabs", ".member-count-btn"])("%s reads the standard button height, border box", (selector) => {
    const body = block("shell/DesktopApp.svelte", selector);
    expect(body).toMatch(/box-sizing:\s*border-box/);
    expect(body).toMatch(/height:\s*var\(--hq-btn-h\)/);
  });

  it("the tabs fill the bar instead of setting their own height with padding", () => {
    expect(block("shell/DesktopApp.svelte", ".project-tabs")).toMatch(/align-items:\s*stretch/);
    expect(block("shell/DesktopApp.svelte", ".project-tab")).toMatch(/padding:\s*0 10px/);
  });
});
