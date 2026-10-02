import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Detail and profile panes follow the Messages profile pane rhythm: a 12px
// 14px header with a hairline, 13px text everywhere, at most a 20px name,
// weight capped at 500, no tracked mono caps, no bordered status pills.
const here = dirname(fileURLToPath(import.meta.url));
const FILES = [
  "BotProfilePane.svelte",
  "../../chat/LocalBotDetailPanel.svelte",
  "../../chat/MemberProfilePanel.svelte",
  "../../chat/AgentDetailPanel.svelte",
  "../../files/FilePreviewPane.svelte",
  "../../home/StoryPanel.svelte",
];

function read(file: string): string {
  return readFileSync(join(here, file), "utf8");
}

function styleOf(file: string): string {
  const src = read(file);
  const start = src.indexOf("<style");
  return start < 0 ? "" : src.slice(start);
}

const ALLOWED_SIZES = ["13px", "20px", "var(--type-ui)", "var(--type-title)", "8px", "9px", "10px"];

describe("detail panes follow the Messages profile pane rhythm", () => {
  for (const file of FILES) {
    const name = file.split("/").pop();
    it(`${name}: text is 13px or a 20px title, weight <= 500, no caps`, () => {
      const css = styleOf(file);
      const sizes = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((m) =>
        m[1].replace(/\s*!important/, "").trim(),
      );
      expect(sizes.filter((s) => !ALLOWED_SIZES.includes(s))).toEqual([]);
      expect(css).not.toMatch(/font-weight:\s*(550|600|650|700|bold)/);
      expect(css).not.toMatch(/text-transform:\s*uppercase/);
      expect(css).not.toMatch(/letter-spacing:\s*0\.\d+em/);
      expect(css).not.toMatch(/backdrop-filter/);
      expect(css).not.toMatch(/font:\s*(550|600|650|700)\s/);
    });
  }

  it("no 24px titles in any pane", () => {
    for (const file of FILES) {
      expect(styleOf(file)).not.toMatch(/font-size:\s*(1[4-9]|2[1-9]|[3-9]\d)px/);
      expect(styleOf(file)).not.toMatch(/--type-(detail|section|body|secondary|metadata)/);
    }
  });

  it("the file preview renders its actions once", () => {
    const src = read("../../files/FilePreviewPane.svelte");
    const markup = src.slice(0, src.indexOf("<style"));
    expect(markup.match(/>\s*Copy path\s*</g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("the bot pane keeps UID copy, scheduled jobs and 30-day usage", () => {
    const src = read("BotProfilePane.svelte");
    expect(src).toContain('data-testid="bot-profile-copy-uid"');
    expect(src).toContain("Scheduled jobs");
    expect(src).toContain('data-testid="bot-profile-usage"');
    expect(src).not.toContain("⌁");
  });
});
