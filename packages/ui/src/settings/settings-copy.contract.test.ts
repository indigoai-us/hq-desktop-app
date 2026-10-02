import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Settings copy is plain product language (QA-057, core/policies/hq-no-mannered-prose.md).
 * This strips each settings pane's <script>, <style>, comments, and tags, keeps
 * visible text plus the copy attributes (placeholder, title, aria-label,
 * message, label), and fails if any of it names CSS, design tokens, or other
 * implementation terms.
 */
const ROOT = join(__dirname, "..");
const PANES = [
  ...readdirSync(join(ROOT, "settings"))
    .filter((f) => f.endsWith(".svelte"))
    .map((f) => `settings/${f}`),
  "company/CompanySettingsPage.svelte",
];

/** QA-072: the Project Files New file form, with its own extra terms. */
const NEW_FILE_FORM = "projects/ProjectFilesBody.svelte";
const NEW_FILE_DENYLIST: RegExp[] = [/presign/i, /clipboard/i, /\bpath\b/i];

const DENYLIST: RegExp[] = [
  /currentColor/i,
  /\bchrome\b/i,
  /brand layer/i,
  /\btokens?\b/i,
  /\bprops?\b/i,
  /\bCSS\b/,
  /z-index/i,
  /\b\d+px\b/i,
];

const COPY_ATTR = /\b(?:placeholder|title|aria-label|message|label)="([^"{]*)"/g;

function settingsCopy(source: string): string[] {
  const markup = source
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    // Arrow handlers inside attributes would otherwise end the tag early.
    .replace(/=>/g, "");
  const attrs = [...markup.matchAll(COPY_ATTR)].map((m) => m[1]);
  const text = markup
    .replace(/<[^>]*>/g, "\n")
    .replace(/\{[^}]*\}/g, (expr) => (expr.match(/"[^"]*"|'[^']*'/g) ?? []).join("\n"))
    .split("\n");
  return [...attrs, ...text].map((s) => s.trim()).filter(Boolean);
}

describe("settings copy contract", () => {
  it("strips markup down to visible copy", () => {
    const copy = settingsCopy(
      `<script>const token = 1;</script><p class="note">Accent tints chrome.</p><svg stroke="currentColor"></svg><style>.a{z-index:2}</style>`,
    );
    expect(copy).toEqual(["Accent tints chrome."]);
  });

  for (const pane of PANES) {
    it(`${pane} uses plain product language`, () => {
      const copy = settingsCopy(readFileSync(join(ROOT, pane), "utf8"));
      const hits = copy.filter((line) => DENYLIST.some((re) => re.test(line)));
      expect(hits).toEqual([]);
    });
  }

  it(`${NEW_FILE_FORM} uses plain product language`, () => {
    const copy = settingsCopy(readFileSync(join(ROOT, NEW_FILE_FORM), "utf8"));
    const rules = [...DENYLIST, ...NEW_FILE_DENYLIST];
    const hits = copy.filter((line) => rules.some((re) => re.test(line)));
    expect(hits).toEqual([]);
  });
});
