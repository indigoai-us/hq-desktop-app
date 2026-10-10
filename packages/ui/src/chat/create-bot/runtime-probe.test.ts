import { describe, expect, it } from "vitest";

import { LOCAL_BOT_SETTINGS } from "../local-bot-settings.js";
import {
  probeActionLabel,
  probeCardStatus,
  probeFix,
  probeKey,
  readProbeAnswer,
  SUPPORTED_MODEL_FALLBACKS,
  supportedModelFor,
  type ProbeClass,
} from "./runtime-probe.js";

const CLASSES: ProbeClass[] = ["signed-out", "cli-outdated", "model-unsupported", "transient", "not-installed", "unknown"];

describe("readProbeAnswer", () => {
  it("reads a passing check, keeping the model asked for", () => {
    expect(readProbeAnswer({ ok: true, class: null, runtime: "codex", model: null }, null)).toEqual({
      state: "ready",
      createModel: null,
    });
    expect(readProbeAnswer({ ok: true, class: null, runtime: "codex", model: "gpt-5.5" }, "gpt-5.5")).toEqual({
      state: "ready",
      createModel: "gpt-5.5",
    });
  });

  it("creates on the fallback model when the tool was too old for its default", () => {
    const answer = { ok: true, class: null, modelFallback: { from: "gpt-6-astra", to: "gpt-5.5" } };
    expect(readProbeAnswer(answer, null)).toEqual({ state: "ready", createModel: "gpt-5.5", fellBackFrom: "gpt-6-astra" });
    // A fallback model that is not a model id is ignored.
    expect(readProbeAnswer({ ok: true, modelFallback: { from: "x", to: "--yolo" } }, null)).toEqual({
      state: "ready",
      createModel: null,
    });
  });

  it("reads each failure class, and anything unknown as unknown", () => {
    for (const cls of CLASSES) {
      expect(readProbeAnswer({ ok: false, class: cls }, null)).toEqual({ state: "failed", class: cls });
    }
    expect(readProbeAnswer({ ok: false, class: "weird" }, null)).toEqual({ state: "failed", class: "unknown" });
  });

  it("says unavailable for a CLI without the check, and transient for an unreadable answer", () => {
    expect(readProbeAnswer({ supported: false }, null)).toEqual({ state: "unavailable" });
    expect(readProbeAnswer(null, null)).toEqual({ state: "failed", class: "transient" });
    expect(readProbeAnswer({ bots: [] }, null)).toEqual({ state: "failed", class: "transient" });
  });
});

describe("supported models", () => {
  it("only offers models the bot settings know", () => {
    for (const [runtime, models] of Object.entries(SUPPORTED_MODEL_FALLBACKS)) {
      const known = LOCAL_BOT_SETTINGS[runtime as keyof typeof LOCAL_BOT_SETTINGS].models.map((m) => m.value);
      for (const model of models) expect(known).toContain(model);
    }
  });

  it("moves past models already refused, then runs out", () => {
    expect(supportedModelFor("codex", [null])).toBe("gpt-5.5");
    expect(supportedModelFor("codex", [null, "gpt-5.5"])).toBeNull();
    expect(supportedModelFor("claude", ["claude-sonnet-5"])).toBe("claude-opus-5");
  });

  it("keys checks by runtime and model", () => {
    expect(probeKey("codex", null)).toBe("codex|");
    expect(probeKey("codex", " gpt-5.5 ")).toBe("codex|gpt-5.5");
  });
});

describe("probeFix", () => {
  const all = { canSignIn: true, canUpdate: true, supportedModel: "gpt-5.5", noun: "Mac" };

  it("offers the fix that matches each class", () => {
    expect(probeFix("signed-out", "Codex", all).actions).toEqual(["signin"]);
    expect(probeFix("cli-outdated", "Codex", all).actions).toEqual(["supported-model", "update", "retry"]);
    expect(probeFix("model-unsupported", "Codex", all).actions).toEqual(["supported-model", "retry"]);
    expect(probeFix("transient", "Codex", all).actions).toEqual(["retry"]);
    expect(probeFix("not-installed", "Codex", all).actions).toEqual(["install", "retry"]);
    expect(probeFix("unknown", "Codex", all).actions).toEqual(["retry"]);
  });

  it("drops fixes this screen cannot do", () => {
    const none = { canSignIn: false, canUpdate: false, supportedModel: null, noun: "Mac" };
    expect(probeFix("signed-out", "Codex", none).actions).toEqual(["retry"]);
    expect(probeFix("cli-outdated", "Codex", none).actions).toEqual(["retry"]);
    expect(probeFix("model-unsupported", "Codex", none).actions).toEqual(["retry"]);
    expect(probeFix("not-installed", "Codex", none).actions).toEqual(["retry"]);
  });

  it("uses plain words: no dashes, no commands, and only signed-out talks about signing in", () => {
    for (const cls of CLASSES) {
      const { text } = probeFix(cls, "Codex", all);
      expect(text).not.toMatch(/[\u2013\u2014]/);
      expect(text).not.toMatch(/\bhq [a-z]|\bnpm\b|\bcodex (?:login|exec)/);
      expect(/sign/i.test(text)).toBe(cls === "signed-out");
    }
  });

  it("never labels a failed check as signed in", () => {
    for (const cls of CLASSES) {
      expect(probeCardStatus({ state: "failed", class: cls })).not.toMatch(/signed in/i);
    }
    expect(probeCardStatus({ state: "checking" })).toBe("Checking...");
    expect(probeCardStatus({ state: "ready", createModel: null })).toBe("Ready");
  });

  it("names the model on the switch button", () => {
    expect(probeActionLabel("supported-model", "Codex", "gpt-5.5", "codex")).toBe("Use GPT-5.5");
    expect(probeActionLabel("update", "Codex", null, "codex")).toBe("Update Codex");
  });
});
