import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeRepairController, TRY_AGAIN_TEXT, type RuntimeRepairDeps } from "./runtime-repair.svelte.js";
import type { RepairPayload } from "./runtime-repair-model.js";

const RAW = 'Error: spawn codex ENOENT {"code":401,"detail":"HTTP 500 Internal Server Error"}';

function payload(over: Partial<RepairPayload> = {}): RepairPayload {
  return { v: 1, kind: "runtime-repair", class: "signed-out", runtime: "claude", action: "signIn", botName: "scout", ...over };
}

function deps(over: Partial<RuntimeRepairDeps> = {}): RuntimeRepairDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    signIn: vi.fn(async (runtime) => (calls.push(`signIn:${runtime}`), true)),
    update: vi.fn(async (runtime) => (calls.push(`update:${runtime}`), true)),
    setModel: vi.fn(async (bot, model) => (calls.push(`setModel:${bot}:${model}`), true)),
    probe: vi.fn(async (runtime, model) => (calls.push(`probe:${runtime}:${model ?? ""}`), { ok: true, detail: "fine" })),
    send: vi.fn(async (text) => void calls.push(`send:${text}`)),
    ...over,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RuntimeRepairController", () => {
  it("Sign in: runs the tool's sign-in, then the check, then turns the card fixed", async () => {
    const d = deps();
    const c = new RuntimeRepairController(d);
    await c.run("evt_1", payload(), "signIn");
    expect(d.calls).toEqual(["signIn:claude", "probe:claude:"]);
    expect(c.stateFor("evt_1")).toEqual({ phase: "fixed", action: "signIn" });
  });

  it("Update: runs the app's install path for the tool, then the check", async () => {
    const d = deps();
    const c = new RuntimeRepairController(d);
    await c.run("evt_1", payload({ class: "cli-outdated", runtime: "codex", action: "update" }), "update");
    expect(d.calls).toEqual(["update:codex", "probe:codex:"]);
    expect(c.stateFor("evt_1").phase).toBe("fixed");
  });

  it("Use a supported model: sets the suggested model (or the default) on the bot, then checks that model", async () => {
    const d = deps();
    const c = new RuntimeRepairController(d);
    await c.run("evt_1", payload({ class: "model-unsupported", runtime: "codex", suggestedModel: "gpt-5.5" }), "switchModel");
    await c.run("evt_2", payload({ class: "model-unsupported", runtime: "codex" }), "switchModel");
    expect(d.calls).toEqual(["setModel:scout:gpt-5.5", "probe:codex:gpt-5.5", "setModel:scout:default", "probe:codex:"]);
    expect(c.stateFor("evt_1").phase).toBe("fixed");
    expect(c.stateFor("evt_2").phase).toBe("fixed");
  });

  it("checks the model the bot is set to, and the new one after a switch", async () => {
    const d = deps({ botModel: () => "gpt-5.5" });
    const c = new RuntimeRepairController(d);
    await c.run("evt_1", payload({ class: "cli-outdated", runtime: "codex" }), "update");
    await c.run("evt_2", payload({ class: "model-unsupported", runtime: "codex", suggestedModel: "gpt-5" }), "switchModel");
    await c.run("evt_3", payload({ class: "model-unsupported", runtime: "codex" }), "switchModel");
    expect(d.calls).toEqual([
      "update:codex",
      "probe:codex:gpt-5.5",
      "setModel:scout:gpt-5",
      "probe:codex:gpt-5",
      "setModel:scout:default",
      "probe:codex:",
    ]);
  });

  it("Try again: checks the tool, then sends the person's failed message again", async () => {
    const d = deps();
    const c = new RuntimeRepairController(d);
    const send = vi.fn(async () => {});
    await c.run("evt_1", payload({ class: "transient", action: "tryAgain" }), "tryAgain", { retryText: "Sum up the call", send });
    expect(d.calls).toEqual(["probe:claude:"]);
    expect(send).toHaveBeenCalledWith("Sum up the call");
    expect(c.stateFor("evt_1").phase).toBe("fixed");
  });

  it('Try again sends "try again" when the failed message is not known', async () => {
    const d = deps();
    const c = new RuntimeRepairController(d);
    await c.run("evt_1", payload({ class: "transient" }), "tryAgain");
    expect(d.calls).toEqual(["probe:claude:", `send:${TRY_AGAIN_TEXT}`]);
  });

  it("a failing check puts the card back on its problem with a plain line", async () => {
    const d = deps({ probe: vi.fn(async () => ({ ok: false, class: "signed-out", detail: RAW })) });
    const c = new RuntimeRepairController(d);
    await c.run("evt_1", payload(), "signIn");
    expect(c.stateFor("evt_1")).toEqual({ phase: "offered", note: "Claude Code is still signed out. Try again." });
  });

  it("after an action, the note names the problem the check found, not the action that ran", async () => {
    const d = deps({ probe: vi.fn(async () => ({ ok: false, class: "model-unsupported" })) });
    const c = new RuntimeRepairController(d);
    await c.run("evt_1", payload({ class: "cli-outdated", runtime: "codex" }), "update");
    expect(c.stateFor("evt_1").note).toBe("Codex still can't run the model the bot is set to. Use a supported model.");
    expect(c.stateFor("evt_1").note).not.toMatch(/updated/);
    await c.run("evt_2", payload({ class: "signed-out", runtime: "codex" }), "signIn");
    expect(c.stateFor("evt_2").note).toBe("Codex still can't run the model the bot is set to. Use a supported model.");
    // An unknown class falls back to the action's own line.
    const unknown = new RuntimeRepairController(deps({ probe: vi.fn(async () => ({ ok: false, class: "not-installed" })) }));
    await unknown.run("evt_3", payload({ class: "cli-outdated", runtime: "codex" }), "update");
    expect(unknown.stateFor("evt_3").note).toBe("Codex could not be updated. Try again.");
  });

  it("a sign-in that does not finish never runs the check and says so plainly", async () => {
    const d = deps({ signIn: vi.fn(async () => false) });
    const c = new RuntimeRepairController(d);
    await c.run("evt_1", payload(), "signIn");
    expect(d.probe).not.toHaveBeenCalled();
    expect(c.stateFor("evt_1").phase).toBe("offered");
  });

  it("never keeps raw host text: a throwing action, check or send ends on the app's own line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const boom = () => {
      throw new Error(RAW);
    };
    for (const [action, over] of [
      ["signIn", { signIn: vi.fn(async () => boom()) }],
      ["update", { update: vi.fn(async () => boom()) }],
      ["switchModel", { setModel: vi.fn(async () => boom()) }],
      ["tryAgain", { probe: vi.fn(async () => boom()) }],
      ["tryAgain", { send: vi.fn(async () => boom()) }],
    ] as const) {
      const c = new RuntimeRepairController(deps(over as Partial<RuntimeRepairDeps>));
      await c.run("evt", payload(), action);
      const state = c.stateFor("evt");
      expect(state.phase).toBe("offered");
      expect(state.note).toBeTruthy();
      expect(JSON.stringify(state)).not.toMatch(/ENOENT|HTTP|401|Error/);
    }
    expect(warn).toHaveBeenCalled();
  });

  it("Update whose check still says too old switches the card to the one plain step", async () => {
    const d = deps({ probe: vi.fn(async () => ({ ok: false, class: "cli-outdated" })) });
    const c = new RuntimeRepairController(d);
    expect(c.updatePathFor("codex")).toBe("app");
    await c.run("evt_1", payload({ class: "cli-outdated", runtime: "codex" }), "update");
    expect(c.updatePathFor("codex")).toBe("manual");
    expect(c.updatePathFor("claude")).toBe("app");
    expect(c.stateFor("evt_1")).toEqual({ phase: "offered" });
  });

  it("a host with no update path shows the plain step from the start", () => {
    const c = new RuntimeRepairController(deps({ canUpdate: () => false }));
    expect(c.updatePathFor("codex")).toBe("manual");
  });

  it("shows working while the action runs and ignores a second press", async () => {
    let finish: (ok: boolean) => void = () => {};
    const d = deps({ signIn: vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve))) });
    const c = new RuntimeRepairController(d);
    const first = c.run("evt_1", payload(), "signIn");
    expect(c.stateFor("evt_1")).toEqual({ phase: "working", action: "signIn" });
    await c.run("evt_1", payload(), "signIn");
    expect(d.signIn).toHaveBeenCalledTimes(1);
    finish(true);
    await first;
    expect(c.stateFor("evt_1").phase).toBe("fixed");
    // A fixed card does nothing more.
    await c.run("evt_1", payload(), "signIn");
    expect(d.signIn).toHaveBeenCalledTimes(1);
  });

  it("tells the host once a card is fixed", async () => {
    const onfixed = vi.fn();
    const c = new RuntimeRepairController(deps({ onfixed }));
    await c.run("evt_1", payload(), "signIn");
    expect(onfixed).toHaveBeenCalledWith(payload(), "signIn");
  });
});
