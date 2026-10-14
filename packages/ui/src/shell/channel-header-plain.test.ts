/**
 * Owner decision (2026-10-08): the 6px bot-setup artwork strip under the
 * header of bot channels is removed; every channel gets the same plain header.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "DesktopApp.svelte"), "utf8");

describe("channel header", () => {
  it("draws no artwork strip for bot channels", () => {
    expect(src).not.toContain("agent-channel-wallpaper");
  });
});
