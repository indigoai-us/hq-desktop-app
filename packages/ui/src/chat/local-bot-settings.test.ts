import { describe, expect, it } from "vitest";

import { LOCAL_BOT_SETTINGS, modelChoicesFor, modelUpdateHint, thinksWithLine } from "./local-bot-settings.js";

describe("modelChoicesFor", () => {
  it("offers Claude Code's default first, then specific versions newest first", () => {
    expect(modelChoicesFor({ runtime: "claude", model: undefined })).toEqual([
      { value: "", label: "Claude Code's default" },
      { value: "claude-opus-5-5", label: "Opus 5.5" },
      { value: "claude-opus-5", label: "Opus 5" },
      { value: "claude-sonnet-5", label: "Sonnet 5" },
      { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
    ]);
  });

  it("never offers the opus/sonnet/haiku aliases for a new pick", () => {
    const values = modelChoicesFor({ runtime: "claude", model: "claude-opus-5-5" }).map((c) => c.value);
    for (const alias of ["opus", "sonnet", "haiku"]) expect(values).not.toContain(alias);
  });

  it("keeps a saved legacy alias with its friendly label", () => {
    const choices = modelChoicesFor({ runtime: "claude", model: "sonnet" });
    expect(choices.at(-1)).toEqual({ value: "sonnet", label: "Sonnet (latest in Claude Code)" });
    expect(choices.filter((c) => c.value === "sonnet")).toHaveLength(1);
    expect(choices.map((c) => c.value)).not.toContain("opus");
  });

  it("keeps any other saved model as its raw id", () => {
    expect(modelChoicesFor({ runtime: "grok", model: " grok-beta-x " }).at(-1)).toEqual({
      value: "grok-beta-x",
      label: "grok-beta-x",
    });
  });

  it("lists current Codex and Grok versions, newest first", () => {
    expect(modelChoicesFor({ runtime: "codex" }).map((c) => c.value)).toEqual(["", "gpt-6-astra", "gpt-5.5"]);
    expect(modelChoicesFor({ runtime: "codex" })[1]?.label).toBe("GPT-6 Astra");
    expect(modelChoicesFor({ runtime: "grok" }).map((c) => c.value)).toEqual(["", "grok-4.7", "grok-4.6", "grok-4.5"]);
    expect(modelChoicesFor({ runtime: "grok" })[1]?.label).toBe("Grok 4.7");
  });

  it("has no duplicate values within a runtime's offered and legacy models", () => {
    for (const settings of Object.values(LOCAL_BOT_SETTINGS)) {
      const values = [...settings.models, ...(settings.legacyModels ?? [])].map((c) => c.value);
      expect(new Set(values).size).toBe(values.length);
      expect(values).not.toContain("");
    }
  });
});

describe("thinksWithLine", () => {
  it("names the specific version", () => {
    expect(thinksWithLine({ runtime: "claude", model: "claude-opus-5-5", effort: "medium" })).toBe(
      "Opus 5.5 · thinking Medium",
    );
  });

  it("names a saved legacy alias plainly", () => {
    expect(thinksWithLine({ runtime: "claude", model: "opus", effort: "high" })).toBe(
      "Opus (latest in Claude Code) · thinking High",
    );
  });

  it("falls back to the tool's default", () => {
    expect(thinksWithLine({ runtime: "codex", model: undefined, effort: undefined })).toBe(
      "Codex's default · thinking Medium",
    );
  });
});

describe("modelUpdateHint", () => {
  it("names the tool to update when a specific model is chosen", () => {
    expect(modelUpdateHint("claude", "claude-opus-5-5")).toBe(
      "If a bot can't start with this model, update Claude Code.",
    );
    expect(modelUpdateHint("codex", "gpt-6-astra")).toBe("If a bot can't start with this model, update Codex.");
    expect(modelUpdateHint("grok", "grok-4.7")).toBe("If a bot can't start with this model, update Grok.");
  });

  it("stays quiet for the tool's default", () => {
    expect(modelUpdateHint("claude", "")).toBeNull();
    expect(modelUpdateHint("claude", "  ")).toBeNull();
    expect(modelUpdateHint("claude", null)).toBeNull();
  });
});
