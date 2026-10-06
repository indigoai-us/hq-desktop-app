// Provider colors for My Telemetry: every model family the page can show maps
// to a provider token, shades inside a provider are distinct, and the chart,
// legend and Models table draw with those tokens (source contract).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VIZ_SLOTS, mixParts, modelShadeOpacity, vizColor, vizOrder, vizSlotFor } from "./telemetry-colors";
import { modelDisplayName } from "./telemetry-me";
import { exactModels, modelFamilies, nameModel } from "./telemetry-models";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

// Ids shaped like the real /v1/telemetry/me data: 6 families, 18 models.
const REAL_IDS = [
  "claude-opus-4-5-20251101", "claude-opus-5-5", "claude-opus-4-1",
  "claude-sonnet-4-6", "claude-sonnet-4-5-20250929", "claude-3-5-sonnet-20241022",
  "claude-haiku-4-5-20251001", "claude-3-haiku-20240307",
  "claude-fable-5-1", "claude-fable-5",
  "gpt-5.5-codex", "gpt-5.1-codex-max", "codex-mini-latest",
  "gpt-5.6-sol", "o3",
  "grok-4.7", "grok-code-fast-1", "grok-4-fast-reasoning",
];

/** Token values declared in one CSS block of viz-tokens.css. */
function blockTokens(css: string, selectorStart: string): Map<string, string> {
  const at = css.indexOf(selectorStart);
  expect(at, `block ${selectorStart}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  return new Map([...body.matchAll(/(--viz-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

describe("telemetry provider colors", () => {
  it("resolves every model family in the data to a provider token", () => {
    const families = modelFamilies(exactModels(Object.fromEntries(REAL_IDS.map((id) => [id, { inputTokens: 1 }]))));
    expect(families.map((f) => f.family).sort()).toEqual(["Fable", "Grok", "Haiku", "OpenAI", "Opus", "Sonnet"]);
    for (const f of families) {
      const slot = vizSlotFor(f.family);
      expect(slot.provider, f.family).not.toBe("neutral");
      expect(slot.provider).toBe({ Anthropic: "anthropic", OpenAI: "openai", xAI: "xai" }[f.provider]);
      for (const m of f.models) expect(vizSlotFor(m.family).provider).toBe(slot.provider);
    }
    // The chart's band labels (modelDisplayName) land on the same providers.
    for (const id of REAL_IDS) {
      expect(vizSlotFor(modelDisplayName(id)).provider, id).toBe(vizSlotFor(nameModel(id).family).provider);
    }
  });

  it("resolves one family name and one color per model id on every surface", () => {
    const usage = exactModels(Object.fromEntries(REAL_IDS.map((id) => [id, { inputTokens: 1 }])));
    const tableFamily = new Map(modelFamilies(usage).flatMap((f) => f.models.map((m) => [m.id, f.family] as const)));
    for (const id of REAL_IDS) {
      const family = vizSlotFor(id);
      // Stat row and chart/legend band label.
      const band = modelDisplayName(id);
      // Models table family row and By-model row.
      const table = tableFamily.get(id)!;
      const row = usage.find((m) => m.id === id)!.family;
      expect([band, table, row], id).toEqual([family.label, family.label, family.label]);
      expect(new Set([vizColor(band), vizColor(table), vizColor(row), vizColor(id)]).size, id).toBe(1);
    }
  });

  it("puts gpt-*, o-series and codex ids in the one blue OpenAI family", () => {
    for (const id of ["gpt-5.6-sol", "gpt-4o", "o3", "gpt-5.5-codex", "gpt-5.1-codex-max", "codex-mini-latest"]) {
      expect(modelDisplayName(id), id).toBe("OpenAI");
      expect(nameModel(id).family, id).toBe("OpenAI");
      expect(vizColor(id), id).toBe("var(--viz-openai)");
    }
    // Legacy labels resolve the same way; there is no separate Codex hue.
    for (const label of ["Codex", "OpenAI Codex", "OpenAI GPT"]) expect(vizColor(label)).toBe("var(--viz-openai)");
    expect(VIZ_SLOTS.filter((s) => s.provider === "openai")).toHaveLength(1);
    expect(read("../common/viz-tokens.css")).not.toMatch(/--viz-openai-\d|#047857|#258e6a/);
  });

  it("keeps System, Other and unknown ids neutral", () => {
    for (const label of ["System", "Other", "Other / unattributed", "mystery-9", ""]) {
      expect(vizSlotFor(label).provider).toBe("neutral");
      expect(vizColor(label)).toBe("var(--viz-neutral)");
    }
  });

  it("gives each slot its own token with distinct light and dark values", () => {
    const css = read("../common/viz-tokens.css");
    // System and Other share the neutral; every other family has its own token.
    const tokens = [...new Set(VIZ_SLOTS.map((s) => s.token))];
    expect(tokens.length).toBe(VIZ_SLOTS.length - 1);
    for (const selector of [":root,\n:root[data-force-theme=\"light\"]", ":root:not([data-force-theme=\"light\"])", ".dark,\n:root[data-force-theme=\"dark\"]"]) {
      const block = blockTokens(css, selector);
      const values = tokens.map((t) => block.get(t));
      expect(values.every((v) => /^#[0-9a-f]{6}$/i.test(v ?? "")), selector).toBe(true);
      // Shades are distinct: no two slots share a color.
      expect(new Set(values).size, selector).toBe(values.length);
    }
    // Inside a provider the shades step: every pair differs.
    const light = blockTokens(css, ":root,\n:root[data-force-theme=\"light\"]");
    for (const provider of ["anthropic", "openai", "xai"]) {
      const shades = VIZ_SLOTS.filter((s) => s.provider === provider).map((s) => light.get(s.token));
      expect(new Set(shades).size).toBe(shades.length);
    }
  });

  it("orders labels by provider then shade, Other last, and keeps ties stable", () => {
    expect(vizOrder(["Other", "Grok", "Haiku", "OpenAI", "Sonnet", "Fable", "Opus", "System"], (l) => l)).toEqual([
      "Opus", "Sonnet", "Fable", "Haiku", "OpenAI", "Grok", "System", "Other",
    ]);
  });

  it("parses the stat-row model mix in either word order", () => {
    expect(mixParts("Opus 38% · OpenAI 26% · Fable 18%")).toEqual([
      { label: "Opus", share: "38%" },
      { label: "OpenAI", share: "26%" },
      { label: "Fable", share: "18%" },
    ]);
    expect(mixParts("38% Opus · 61% Sonnet")).toEqual([
      { label: "Opus", share: "38%" },
      { label: "Sonnet", share: "61%" },
    ]);
    expect(mixParts("")).toEqual([]);
  });

  it("lightens smaller models inside a family", () => {
    expect([0, 1, 2, 3, 9].map(modelShadeOpacity)).toEqual([1, 0.7, 0.5, 0.36, 0.36]);
  });
});

describe("TelemetryView draws with the provider tokens (source contract)", () => {
  const src = read("./TelemetryView.svelte");

  it("colors chart stacks, legend, share bars and the model mix from telemetry-colors", () => {
    expect(src).toContain('import "../common/viz-tokens.css";');
    expect(src).toMatch(/<i data-band=\{band\.label\}[^>]*style:background=\{band\.color\}/);
    expect(src).toMatch(/data-legend=\{label\}><ProviderMark provider=\{vizSlotFor\(label\)\.provider\} color=\{vizColor\(label\)\} \/>/);
    // Provider marks replace the plain color dots before every name.
    expect(src).not.toContain('class="dot"');
    expect(src.match(/<ProviderMark /g)!.length).toBeGreaterThanOrEqual(6);
    expect(src).toMatch(/style:width="\{sharePercent\(f\.total, tokenTotal\)\}%" style:background=\{vizColor\(f\.family\)\}/);
    expect(src).toMatch(/mixParts\(snapshot\.modelMix\)/);
    // No grey opacity ramp on stacks any more.
    expect(src).not.toMatch(/style:opacity=\{band\.opacity\}/);
    expect(src).not.toContain("bandOpacity(");
  });

  it("keeps Skills bars neutral with one quiet accent", () => {
    expect(src).toContain('<span class="bar quiet">');
    expect(src).toMatch(/\.bar\.quiet i \{ background: var\(--viz-quiet\); \}/);
  });
});
