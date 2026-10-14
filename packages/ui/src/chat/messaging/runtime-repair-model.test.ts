import { describe, expect, it } from "vitest";

import {
  manualUpdateLine,
  parseProbeResult,
  parseRepairPayload,
  repairCardView,
  repairFailureNote,
  repairPayloadForMessage,
  repairProbeNote,
  type RepairAction,
  type RepairCardView,
  type RepairPayload,
} from "./runtime-repair-model.js";

const BLOCK = {
  v: 1,
  kind: "runtime-repair",
  class: "signed-out",
  runtime: "claude",
  action: "signIn",
  botName: "scout",
  retryOf: "evt_123",
};

function payload(over: Partial<RepairPayload> = {}): RepairPayload {
  return { ...(BLOCK as RepairPayload), ...over };
}

/** Every word a view draws. */
function words(view: RepairCardView): string {
  return [view.title, view.line, view.mark, view.primaryLabel, view.secondaryLabel, view.note].filter(Boolean).join(" | ");
}

describe("parseRepairPayload", () => {
  it("reads a well-formed v1 payload, from an object or JSON text", () => {
    expect(parseRepairPayload(BLOCK)).toEqual(BLOCK);
    expect(parseRepairPayload(JSON.stringify(BLOCK))).toEqual(BLOCK);
    expect(parseRepairPayload({ ...BLOCK, suggestedModel: "opus[1m]" })?.suggestedModel).toBe("opus[1m]");
  });

  it.each([
    ["no payload", null],
    ["text that is not JSON", "{not json"],
    ["an array", [BLOCK]],
    ["another version", { ...BLOCK, v: 2 }],
    ["another kind", { ...BLOCK, kind: "connect" }],
    ["an unknown class", { ...BLOCK, class: "not-installed" }],
    ["an unknown runtime", { ...BLOCK, runtime: "bash" }],
    ["an unknown action", { ...BLOCK, action: "rm" }],
    ["a bot handle with spaces", { ...BLOCK, botName: "my bot" }],
    ["a bot handle that is a flag", { ...BLOCK, botName: "--all" }],
    ["a model that is a flag", { ...BLOCK, suggestedModel: "-rf" }],
    ["a model with a shell character", { ...BLOCK, suggestedModel: "gpt;ls" }],
    ["a retryOf that is not text", { ...BLOCK, retryOf: 42 }],
    ["a retryOf with spaces", { ...BLOCK, retryOf: "evt 1" }],
  ])("draws plain text for %s", (_label, raw) => {
    expect(parseRepairPayload(raw)).toBeNull();
  });
});

describe("repairPayloadForMessage", () => {
  it("reads the runtime-repair block from the message's richContent (the DM transport)", () => {
    expect(repairPayloadForMessage({ richContent: { v: 1, blocks: [BLOCK] } })).toEqual(BLOCK);
    expect(repairPayloadForMessage({ richContent: { v: 1, blocks: [{ kind: "stat" }, BLOCK] } })).toEqual(BLOCK);
  });

  it("also reads metadata.repair, for a server that passes metadata through", () => {
    expect(repairPayloadForMessage({ metadata: { repair: BLOCK } })).toEqual(BLOCK);
  });

  it("answers null when there is no payload or it is malformed, so the plain text draws", () => {
    expect(repairPayloadForMessage(null)).toBeNull();
    expect(repairPayloadForMessage({})).toBeNull();
    expect(repairPayloadForMessage({ richContent: { v: 1, blocks: [{ kind: "stat", items: [] }] } })).toBeNull();
    expect(repairPayloadForMessage({ richContent: { v: 1, blocks: [{ ...BLOCK, class: "bogus" }] } })).toBeNull();
    expect(repairPayloadForMessage({ richContent: "garbage" })).toBeNull();
    expect(repairPayloadForMessage({ metadata: { repair: { ...BLOCK, v: 9 } } })).toBeNull();
  });
});

describe("repairCardView", () => {
  it("signed out: Sign in, with the bot's real name", () => {
    const view = repairCardView(payload(), { phase: "offered" }, "Pickles");
    expect(view.title).toBe("Claude Code is signed out");
    expect(view.line).toBe("Pickles needs Claude Code to reply. Sign in and Pickles picks up your message.");
    expect(view.primaryLabel).toBe("Sign in");
    expect(view.primaryAction).toBe("signIn");
    expect(view.secondaryLabel).toBeNull();
    expect(view.logo.mark).not.toBeNull();
  });

  it("CLI too old: Update, generic glyph for Codex", () => {
    const view = repairCardView(payload({ class: "cli-outdated", runtime: "codex", action: "update" }), { phase: "offered" }, "Pickles");
    expect(view.title).toBe("Codex needs an update");
    expect(view.line).toBe("This version of Codex is too old for Pickles. The update takes about a minute.");
    expect(view.primaryLabel).toBe("Update");
    expect(view.primaryAction).toBe("update");
    expect(view.logo.mark).toBeNull();
  });

  it("CLI too old that the app cannot update: one plain step and Try again, no Update button", () => {
    const view = repairCardView(payload({ class: "cli-outdated", runtime: "codex", action: "update" }), { phase: "offered" }, "Pickles", "manual");
    expect(view.line).toBe(manualUpdateLine("codex"));
    expect(view.line).not.toMatch(/npm|sudo|hq |brew/);
    expect(view.primaryLabel).toBe("Try again");
    expect(view.primaryAction).toBe("tryAgain");
  });

  it("unsupported model: Use a supported model, and a quiet Update <tool>", () => {
    const view = repairCardView(payload({ class: "model-unsupported", action: "switchModel" }), { phase: "offered" }, "Pickles");
    expect(view.title).toBe("Pickles’s model isn’t available");
    expect(view.line).toBe("Claude Code on this Mac can’t run the model Pickles is set to. Switch to one it supports, or update.");
    expect(view.primaryLabel).toBe("Use a supported model");
    expect(view.primaryAction).toBe("switchModel");
    expect(view.secondaryLabel).toBe("Update Claude Code");
    expect(view.secondaryAction).toBe("update");
    // With no app update path the quiet button goes rather than doing nothing.
    expect(repairCardView(payload({ class: "model-unsupported" }), { phase: "offered" }, "Pickles", "manual").secondaryLabel).toBeNull();
  });

  it("transient: Try again", () => {
    const view = repairCardView(payload({ class: "transient", action: "tryAgain" }), { phase: "offered" }, "Pickles");
    expect(view.title).toBe("Pickles couldn’t reply");
    expect(view.line).toBe("Something interrupted Claude Code. Your message is saved.");
    expect(view.primaryLabel).toBe("Try again");
  });

  it("signing in and updating: the spinner label on the mark and the disabled button", () => {
    const signing = repairCardView(payload(), { phase: "working", action: "signIn" }, "Pickles");
    expect(signing.title).toBe("Claude Code");
    expect(signing.mark).toBe("Signing in…");
    expect(signing.primaryLabel).toBe("Signing in…");
    expect(signing.primaryAction).toBeNull();
    expect(signing.line).toBe("Finish in the browser window that just opened.");
    const updating = repairCardView(payload({ class: "cli-outdated", runtime: "codex" }), { phase: "working", action: "update" }, "Pickles");
    expect(updating.title).toBe("Codex");
    expect(updating.mark).toBe("Updating…");
    expect(updating.line).toBe("Updating Codex. Pickles replies as soon as it’s done.");
  });

  it("fixed: You're all set. Send me anything.", () => {
    const view = repairCardView(payload(), { phase: "fixed", action: "signIn" }, "Pickles");
    expect(view.title).toBe("You’re all set");
    expect(view.line).toBe("Send me anything.");
    expect(view.mark).toBe("Signed in");
    expect(view.primaryLabel).toBeNull();
    expect(view.secondaryLabel).toBeNull();
  });

  it("falls back to the bot's handle when it has no display name", () => {
    expect(repairCardView(payload(), { phase: "offered" }, "  ").line).toContain("scout needs");
  });

  it("shows a failure note only as the app's own words", () => {
    const view = repairCardView(payload(), { phase: "offered", note: repairFailureNote("signIn", "claude", "signed-out") }, "Pickles");
    expect(view.note).toBe("Claude Code is still signed out. Try again.");
  });

  it("never draws an em or en dash, a command or a raw error in any state", () => {
    const classes = ["signed-out", "cli-outdated", "model-unsupported", "transient"] as const;
    const actions: RepairAction[] = ["signIn", "update", "switchModel", "tryAgain"];
    for (const cls of classes) {
      for (const runtime of ["claude", "codex", "grok"] as const) {
        const p = payload({ class: cls, runtime });
        const views = [
          repairCardView(p, { phase: "offered" }, "Pickles"),
          repairCardView(p, { phase: "offered" }, "Pickles", "manual"),
          ...actions.map((action) => repairCardView(p, { phase: "working", action }, "Pickles")),
          ...actions.map((action) => repairCardView(p, { phase: "fixed", action }, "Pickles")),
          ...actions.map((action) => repairCardView(p, { phase: "offered", note: repairFailureNote(action, runtime, cls) }, "Pickles")),
          ...actions.map((action) => repairCardView(p, { phase: "offered", note: repairProbeNote(cls, action, runtime) }, "Pickles")),
          ...actions.map((action) => repairCardView(p, { phase: "offered", note: repairProbeNote(null, action, runtime) }, "Pickles")),
        ];
        for (const view of views) {
          const text = words(view);
          expect(text).not.toMatch(/[–—]/);
          expect(text).not.toMatch(/\bhq \w|npm|sudo|error|exit|status \d/i);
        }
      }
    }
  });
});

describe("parseProbeResult", () => {
  it("passes only on ok: true", () => {
    expect(parseProbeResult({ ok: true, detail: "fine" })).toEqual({ ok: true, class: null });
    expect(parseProbeResult({ ok: false, class: "signed-out" })).toEqual({ ok: false, class: "signed-out" });
    expect(parseProbeResult({ ok: false, class: "not-installed" })).toEqual({ ok: false, class: null });
    expect(parseProbeResult({ ok: "true" })).toEqual({ ok: false, class: null });
    expect(parseProbeResult(null)).toEqual({ ok: false, class: null });
    // An hq CLI without `bot probe` answers { supported: false }: a plain failure, no class.
    expect(parseProbeResult({ supported: false })).toEqual({ ok: false, class: null });
  });
});
