import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Detail and profile panes follow the Messages profile pane rhythm: a 12px
// 14px header with a hairline, 13px text everywhere, at most a 20px name,
// weight capped at 500, no bordered status pills. Section labels in the
// person and bot profile panes (and the badge views they open) use the mono
// caps label style; every other pane keeps sentence-case labels.
const here = dirname(fileURLToPath(import.meta.url));
const FILES = [
  "BotProfilePane.svelte",
  "UserProfilePane.svelte",
  "../../badges/ProfileBadges.svelte",
  "../../badges/BadgeDetailPane.svelte",
  // The Badges page ("See all"), owner decision 2026-10-08. The card it opens
  // (BadgeCard / BadgeCardModal) is an approved carve-out with its own
  // contract in badges/badge-card.svelte.test.ts.
  "../../badges/BadgesPane.svelte",
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

/** Panes whose section labels are mono caps (designer decision, 2026-10-08). */
const MONO_CAPS_LABELS = new Set([
  "BotProfilePane.svelte",
  "UserProfilePane.svelte",
  "ProfileBadges.svelte",
  "BadgeDetailPane.svelte",
  "BadgesPane.svelte",
]);
const LABEL_TRACKING = "letter-spacing: 0.1em; text-transform: uppercase;";

// 12px is for small chips, such as the role chip under a profile name.
const ALLOWED_SIZES = ["13px", "20px", "12px", "var(--type-ui)", "var(--type-title)", "8px", "9px", "10px"];

describe("detail panes follow the Messages profile pane rhythm", () => {
  for (const file of FILES) {
    const name = file.split("/").pop();
    it(`${name}: text is 13px or a 20px title, weight <= 500, no caps`, () => {
      const raw = styleOf(file);
      const caps = MONO_CAPS_LABELS.has(name ?? "");
      if (caps) {
        expect(raw).toContain(`font: 500 10px/1.4 var(--font-mono, "Geist Mono", monospace); ${LABEL_TRACKING}`);
      }
      // The label style is the only tracked caps allowed, and only in these panes.
      const css = caps ? raw.split(LABEL_TRACKING).join("") : raw;
      const sizes = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((m) =>
        m[1].replace(/\s*!important/, "").trim(),
      );
      // A badge's level under its name is 11px, quieter than the name (owner review 2026-10-08).
      const allowed = name === "ProfileBadges.svelte" || name === "BadgesPane.svelte" ? [...ALLOWED_SIZES, "11px"] : ALLOWED_SIZES;
      expect(sizes.filter((s) => !allowed.includes(s))).toEqual([]);
      expect(css).not.toMatch(/font-weight:\s*(550|600|650|700|bold)/);
      expect(css).not.toMatch(/text-transform:\s*uppercase/);
      expect(css).not.toMatch(/letter-spacing:\s*0\.\d+em/);
      expect(css).not.toMatch(/backdrop-filter:(?!\s*none)/);
      expect(css).not.toMatch(/font:\s*(550|600|650|700)\s/);
    });
  }

  it("text buttons dim on hover without an underline", () => {
    for (const file of [...MONO_CAPS_LABELS].map((f) => FILES.find((x) => x.endsWith(f))!)) {
      const css = styleOf(file);
      expect(css).not.toMatch(/\.link:hover\s*\{[^}]*underline/);
      if (css.includes(".link:hover")) expect(css).toMatch(/\.link:hover\s*\{\s*color:\s*var\(--v4-text-3\)/);
    }
  });

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

  it("the badge tier line matches the description's type size", () => {
    const css = read("../../badges/BadgeDetailPane.svelte");
    expect(css).toMatch(/\.meta, \.crit \{[^}]*font: 400 13px\/1\.45/);
  });

  it("badge levels stay on one line, and a single level doesn't repeat 'Reached'", () => {
    const src = read("../../badges/BadgeDetailPane.svelte");
    expect(src).toMatch(/\.need \{[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis;[^}]*color: var\(--v4-text-3\);/);
    expect(src).toContain("{#if level.current && levels.length > 1}");
  });

  it("profile badges explain themselves in the app's hover card, not the system tooltip", () => {
    const src = read("../../badges/ProfileBadges.svelte");
    expect(src).not.toMatch(/\btitle="/);
    expect(src).toContain('aria-describedby="profile-badge-hc-{item.def.id}"');
    expect(src).toMatch(/\.b:hover \.hc, \.b:focus-visible \.hc \{[^}]*opacity: 1; visibility: visible;/);
  });

  // Smaller than the panel's body text, the level smallest (owner review 2026-10-08).
  it.each(["ProfileBadges.svelte", "BadgesPane.svelte"])("%s: a badge's name is 12px and its level 11px", (file) => {
    const src = read(`../../badges/${file}`);
    expect(src).toMatch(/\n  \.nm \{[^}]*font-size: 12px/);
    expect(src).toMatch(/\n  \.tr \{[^}]*font-size: 11px/);
  });

  it("the Badges page shows progress at the level's size", () => {
    expect(read("../../badges/BadgesPane.svelte")).toMatch(/\n  \.pg \{[^}]*font-size: 11px/);
  });

  it("the bot pane keeps UID copy, scheduled jobs and 30-day usage", () => {
    const src = read("BotProfilePane.svelte");
    expect(src).toContain('data-testid="bot-profile-copy-uid"');
    expect(src).toContain("Scheduled jobs");
    expect(src).toContain('data-testid="bot-profile-usage"');
    expect(src).not.toContain("⌁");
  });
});
