/**
 * Meetings follows the Messages type grammar (console-rail design lane 8):
 * one 20px/500 title, 13px for everything else, weight at most 500, no
 * tracked mono caps, no bordered status pills, no backdrop-filter. Reads the
 * component styles as source so a regression fails before it ships.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const FILES = [
  "MeetingsPage.svelte",
  "MeetingsStatesBody.svelte",
  "MeetingsToolbarControls.svelte",
  "PasteLinkBox.svelte",
  "CalendarPanel.svelte",
  "MeetingsAgenda.svelte",
  "LiveTranscriptBody.svelte",
  "LiveTranscriptDoor.svelte",
  "../../../../apps/sync/src/components/MeetingsWindow.svelte",
].map((f) => [f, resolve(here, f)] as const);

function styleOf(path: string): string {
  const src = readFileSync(path, "utf8");
  const i = src.indexOf("<style>");
  expect(i, `${path} has a style block`).toBeGreaterThan(-1);
  return src.slice(i).replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("Meetings type and chrome contract", () => {
  for (const [name, path] of FILES) {
    describe(name, () => {
      const css = styleOf(path);

      it("caps weight at 500", () => {
        expect(css).not.toMatch(/font-weight:\s*(600|650|700|800|bold)\b/);
      });

      it("uses no tracked caps", () => {
        expect(css).not.toMatch(/text-transform:\s*uppercase/);
        expect(css).not.toMatch(/letter-spacing:\s*[1-9]|letter-spacing:\s*0\.\d+(em|px)/);
      });

      it("uses only 13px text, or the 20px title token", () => {
        const sizes = [...css.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => Number(m[1]));
        expect(sizes.filter((n) => n !== 13)).toEqual([]);
        const fallbacks = [...css.matchAll(/font-size:\s*var\(--type-[a-z-]+,\s*([0-9.]+)px\)/g)].map((m) => Number(m[1]));
        expect(fallbacks.filter((n) => n !== 13 && n !== 20)).toEqual([]);
      });

      it("keeps mono off UI text", () => {
        expect(css).not.toMatch(/font-family:\s*var\(--font-mono/);
      });

      it("has no backdrop-filter", () => {
        expect(css).not.toMatch(/backdrop-filter/);
      });
    });
  }

  it("draws no 24px or bold page titles on the rail page", () => {
    const css = styleOf(resolve(here, "MeetingsStatesBody.svelte"));
    expect(css).toMatch(/\.toolbar h1, \.crumb b \{[^}]*font-size: var\(--type-title, 20px\); font-weight: 500;/);
    expect(css).toMatch(/\.next h2 \{[^}]*font-size: 13px; font-weight: 500;/);
  });

  it("renders status as plain text, not a bordered pill", () => {
    for (const f of ["MeetingsStatesBody.svelte", "PasteLinkBox.svelte"]) {
      const chip = styleOf(resolve(here, f)).match(/\.chip \{([^}]*)\}/)?.[1] ?? "";
      expect(chip, f).not.toMatch(/border:\s*1px/);
    }
    const pill = styleOf(resolve(here, "MeetingsAgenda.svelte")).match(/\.pill \{([^}]*)\}/)?.[1] ?? "";
    expect(pill).toMatch(/border:\s*0/);
  });

  it("sizes buttons at the one button standard (titlebar pill)", () => {
    for (const f of ["MeetingsStatesBody.svelte", "PasteLinkBox.svelte", "CalendarPanel.svelte"]) {
      const btn = styleOf(resolve(here, f)).match(/\.btn \{([^}]*)\}/)?.[1] ?? "";
      expect(btn, f).toMatch(/height:\s*var\(--hq-btn-h\)/);
    }
  });
});

describe("AUDIT-2 Meetings sidepane type", () => {
  it("keeps the sidepane title and rows at 13px (no 14px+ text)", () => {
    const css = styleOf(resolve(here, "MeetingsSidepane.svelte"));
    const sizes = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    expect(sizes.filter((px) => px > 13)).toEqual([]);
  });
});
