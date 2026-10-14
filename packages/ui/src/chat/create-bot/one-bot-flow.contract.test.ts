import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * There is one bot-creation flow in the app: Cloud or Local, then the New bot
 * takeover's step screens. The old wide wizard (step crumbs, preview card,
 * its own footer) is gone from every entry point, so no app source may name
 * it. Tests may still name it to assert it stays gone.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "..");

const OLD_WIZARD = [
  "BotPreviewCard",
  "create-bot-crumb",
  "previewPlacement",
  "flow-primary",
  "flow-crumb",
  'layout: "wizard"',
  'layout="wizard"',
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules") out.push(...sources(path));
    } else if (/\.(svelte|ts|css)$/.test(name) && !/\.test\.ts$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe("one bot-creation flow", () => {
  it("no source names the old wide wizard", () => {
    const hits: string[] = [];
    for (const path of sources(SRC)) {
      const text = readFileSync(path, "utf8");
      for (const needle of OLD_WIZARD) {
        if (text.includes(needle)) hits.push(`${relative(SRC, path)}: ${needle}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("every host mounts CreateBotFlow inside the takeover's card", () => {
    const modal = readFileSync(join(SRC, "chat", "CreateModal.svelte"), "utf8");
    expect(modal).toContain('const sunriseBot = $derived(step === "bot");');
    const settings = readFileSync(join(SRC, "settings", "BotsSettingsPane.svelte"), "utf8");
    expect(settings).toMatch(/<NewBotSunriseShell[\s\S]*<CreateBotFlow[\s\S]*<\/NewBotSunriseShell>/);
  });
});
