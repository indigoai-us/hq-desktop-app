// AUDIT-2-08: Settings used 10-12px mono for plain values. Mono stays only for
// paths and versions (HQ folder, sync log path, app / interface / HQ Core /
// HQ CLI versions) at 13px; everything else (email, status words, last sync, counts,
// the opacity readout, the recording-company select) is 13px sans.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const FILES = ["PrototypeSettingsPanes.svelte", "ShellSettings.svelte", "settings-chrome.css"];

function read(file: string): { markup: string; rules: Array<{ sel: string; body: string }> } {
  const text = readFileSync(join(here, file), "utf8");
  const i = file.endsWith(".css") ? 0 : text.lastIndexOf("<style");
  return {
    markup: text.slice(0, i),
    rules: [...text.slice(i).matchAll(/([^{}]*)\{([^}]*)\}/g)].map((m) => ({
      sel: m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim(),
      body: m[2],
    })),
  };
}

describe("Settings mono (AUDIT-2-08)", () => {
  for (const file of FILES) {
    it(`${file}: mono only on .mono-path, at 13px`, () => {
      const monoRules = read(file).rules.filter((r) => /font-family:\s*var\(--font-mono/.test(r.body));
      for (const r of monoRules) {
        expect(r.sel, file).toMatch(/\.mono-path$/);
        expect(r.body, r.sel).toMatch(/font-size:\s*13px/);
      }
    });

    it(`${file}: no 11-12px value text`, () => {
      const small = read(file).rules.filter(
        (r) => /^\.(mono|val|range-val|mono-select|mono-path)\b/.test(r.sel) && /font-size:\s*1[12]px/.test(r.body),
      );
      expect(small.map((r) => r.sel)).toEqual([]);
    });
  }

  it("mono-path marks only paths and versions", () => {
    const { markup } = read("PrototypeSettingsPanes.svelte");
    const uses = [...markup.matchAll(/mono-path[^>]*>\s*([^<]{0,40})/g)].map((m) => m[0]);
    expect(uses).toHaveLength(6);
    expect(markup).toMatch(/class:mono-path=\{!!formatHqFolderMeta\(hqFolder\)\}/);
    expect(markup).toMatch(/class:mono-path=\{!!coreVersion\}/);
    expect(markup).toMatch(/class:mono-path=\{!!cliVersion\}/);
    expect(markup).toMatch(/class="sd mono-path">Log: \{liveSync\.daemonLogPath\}/);
    expect(markup).toMatch(/class="sd mono-path">v\{appVersion\}/);
    expect(markup).toMatch(/class="sd mono-path" data-testid="settings-ui-version">Interface \{uiVersion\}/);
  });
});
