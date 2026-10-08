/**
 * The channel header's filled controls line up as one set (owner review
 * 2026-10-08): the Chat / Details (and Chat / Board / Files) tabs had been
 * 24px tall beside the 28px notify pill and a 29px member count.
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
  it("the notify pill is the 28px reference", () => {
    expect(block("chat/ChannelMuteControl.svelte", ".mute-toggle,\n  .mute-chevron")).toMatch(/height:\s*28px/);
  });

  it.each([".project-tabs", ".member-count-btn"])("%s is 28px tall, border box", (selector) => {
    const body = block("shell/DesktopApp.svelte", selector);
    expect(body).toMatch(/box-sizing:\s*border-box/);
    expect(body).toMatch(/height:\s*28px/);
  });

  it("the tabs fill the bar instead of setting their own height with padding", () => {
    expect(block("shell/DesktopApp.svelte", ".project-tabs")).toMatch(/align-items:\s*stretch/);
    expect(block("shell/DesktopApp.svelte", ".project-tab")).toMatch(/padding:\s*0 10px/);
  });
});
