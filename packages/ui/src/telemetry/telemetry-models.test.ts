// OWNER-R29: usage by exact model within each family, from the
// /v1/telemetry/me totals.tokensByModel shape (placeholder numbers).
import { describe, expect, it } from "vitest";
import { exactModels, formatMoney, modelFamilies, nameModel } from "./telemetry-models";

const b = (input: number, output = 0, w = 0, r = 0) => ({ inputTokens: input, outputTokens: output, cacheCreationTokens: w, cacheReadTokens: r });
export const TOKENS_BY_MODEL = {
  "claude-opus-4-5-20251101": b(1000, 100, 10, 5000),
  "claude-opus-5-5": b(9000, 900),
  "claude-opus-4-1-20250805": b(10),
  "claude-sonnet-4-6": b(500),
  "claude-sonnet-4-5-20250929": b(400),
  "claude-haiku-4-5-20251001": b(300),
  "claude-fable-5-1": b(2000),
  "claude-fable-5": b(20),
  "gpt-5.5-codex": b(3000),
  "gpt-5.1-codex-max": b(100),
  "codex-mini-latest": b(50),
  "gpt-5.6-sol": b(800),
  "gpt-4o": b(70),
  "o3": b(60),
  "grok-4.7": b(700),
  "grok-code-fast-1": b(90),
  "<synthetic>": b(5),
  "mystery-model-x": b(40),
  "zero-model": b(0),
};

describe("OWNER-R29 exact models", () => {
  it("maps every fixture id to a readable name or falls through to its raw id", () => {
    const named = Object.fromEntries(Object.keys(TOKENS_BY_MODEL).map((id) => [id, nameModel(id)]));
    expect(named["claude-opus-4-5-20251101"]).toMatchObject({ name: "Opus 4.5", family: "Opus", provider: "Anthropic" });
    expect(named["claude-opus-5-5"]).toMatchObject({ name: "Opus 5.5", family: "Opus" });
    expect(named["claude-fable-5-1"]).toMatchObject({ name: "Fable 5.1", family: "Fable" });
    expect(named["claude-fable-5"]).toMatchObject({ name: "Fable 5" });
    expect(named["gpt-5.5-codex"]).toMatchObject({ name: "GPT-5.5 Codex", family: "OpenAI Codex", provider: "OpenAI" });
    expect(named["codex-mini-latest"]).toMatchObject({ name: "Codex Mini Latest", family: "OpenAI Codex" });
    expect(named["gpt-5.6-sol"]).toMatchObject({ name: "GPT-5.6 Sol", family: "OpenAI GPT" });
    expect(named["o3"]).toMatchObject({ family: "OpenAI GPT" });
    expect(named["grok-4.7"]).toMatchObject({ name: "Grok 4.7", family: "Grok", provider: "xAI" });
    expect(named["<synthetic>"]).toMatchObject({ name: "System" });
    expect(named["mystery-model-x"]).toMatchObject({ name: "mystery-model-x", family: "Other" });
    // An OpenAI chat model never lands under a Codex label.
    expect(named["gpt-4o"]!.family).not.toMatch(/Codex/);
    for (const [id, n] of Object.entries(named)) expect(n.name, id).toBeTruthy();
  });

  it("lists exact models by tokens, keeps unknown ids, drops empty rows, and groups by family", () => {
    const models = exactModels(TOKENS_BY_MODEL);
    expect(models[0]).toMatchObject({ id: "claude-opus-5-5", total: 9900, input: 9000, output: 900 });
    expect(models.map((m) => m.id)).toContain("mystery-model-x");
    expect(models.map((m) => m.id)).not.toContain("zero-model");
    const families = modelFamilies(models);
    const opus = families.find((f) => f.family === "Opus")!;
    expect(opus.models.map((m) => m.id)).toEqual(["claude-opus-5-5", "claude-opus-4-5-20251101", "claude-opus-4-1-20250805"]);
    expect(opus.total).toBe(9900 + 6110 + 10);
    expect(families.map((f) => f.family)).toContain("Other");
    // Cost only where the existing list-price rule applies (Claude); empty for the rest.
    expect(opus.costUsd).toBeGreaterThan(0);
    expect(families.find((f) => f.family === "Grok")!.costUsd).toBeNull();
    expect(families.find((f) => f.family === "Fable")!.costUsd).toBeNull();
  });

  it("formats money with thousands separators and leaves an empty cost empty", () => {
    expect(formatMoney(87079.38)).toBe("$87,079.38");
    expect(formatMoney(null)).toBe("");
  });
});
