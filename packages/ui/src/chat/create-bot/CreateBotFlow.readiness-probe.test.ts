// @vitest-environment happy-dom

/**
 * The readiness check before a local bot is saved.
 *
 * An owner created a local Codex bot. The screen said Codex was signed in,
 * the bot was created, and its first reply was that it could not start: the
 * person's Codex config asked for a model the installed Codex was too old to
 * run. The status read was right about the sign-in and wrong about the bot.
 *
 * These tests pin the fix: the flow runs a real test turn (`hq bot probe`)
 * with the bot's runtime, model and thinking level, only a passing check
 * creates the bot, a failed one shows the matching fix on the same screen,
 * and the card never says "Signed in" while the check says the bot cannot run.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import CreateBotFlow from "./CreateBotFlow.svelte";
import type { RuntimeStatus } from "./runtime-status.js";
import type { ProbeClass, RuntimeProbeInput } from "./runtime-probe.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return host.querySelector<T>(selector);
}

function click(selector: string): void {
  const el = q<HTMLButtonElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  el.click();
}

const SIGNED_IN: RuntimeStatus = { state: "signedIn" };
const SIGNED_OUT: RuntimeStatus = { state: "signedOut" };

type ProbeAnswer = { ok: true; value: unknown } | { ok: false; reason: "error"; message: string };

function passing(extra: Record<string, unknown> = {}): ProbeAnswer {
  return { ok: true, value: { ok: true, class: null, detail: "Codex answered.", runtime: "codex", model: null, durationMs: 900, ...extra } };
}

function failing(cls: ProbeClass): ProbeAnswer {
  return {
    ok: true,
    value: { ok: false, class: cls, detail: "plain detail", runtime: "codex", model: null, durationMs: 1830 },
  };
}

/**
 * Mount the flow with Codex the signed-in tool (as the status read says on
 * the owner's Mac), walk to the coding tool step and let the check land.
 */
async function openCodex(
  probe: (input: RuntimeProbeInput) => Promise<ProbeAnswer>,
  extra: Record<string, unknown> = {},
) {
  const oncreate = vi.fn(async () => undefined);
  const probeBotRuntime = vi.fn(probe);
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CreateBotFlow, {
    target: host,
    props: {
      botRuntimeReady: { claude: false, codex: true, grok: false },
      botRuntimeStatus: { claude: SIGNED_OUT, codex: SIGNED_IN, grok: SIGNED_OUT },
      botWorkers: [],
      existingNames: [],
      botCompanies: [{ slug: "indigo", label: "Indigo" }],
      initialName: "Saturday",
      initialHome: "local",
      oncreate,
      onsignin: () => undefined,
      probeBotRuntime,
      ...extra,
    },
  });
  await settle();
  expect(q('[data-testid="create-bot-sunrise-home"]')).toBeTruthy();
  return { oncreate, probeBotRuntime };
}

function codexCard(): string {
  return q('[data-testid="chat-bot-runtime-codex-status"]')?.textContent?.trim() ?? "";
}

function probeLine(): HTMLElement | null {
  return q('[data-testid="chat-bot-runtime-probe"]');
}

describe("New bot: readiness check before a local bot is saved", () => {
  it("checks the exact runtime and thinking level the bot will use", async () => {
    const { probeBotRuntime } = await openCodex(async () => passing());
    expect(probeBotRuntime).toHaveBeenCalledTimes(1);
    expect(probeBotRuntime).toHaveBeenCalledWith({ runtime: "codex", model: null, effort: "medium" });
  });

  it("creates the bot only after the check passes, and the card says Ready", async () => {
    const { oncreate } = await openCodex(async () => passing());
    expect(codexCard()).toBe("Ready");
    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(oncreate).toHaveBeenCalledTimes(1);
    const [input] = oncreate.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(input.runtime).toBe("codex");
    expect(input).not.toHaveProperty("model");
  });

  it("blocks creation when the check fails (the owner's case) and keeps the person on the fix", async () => {
    const { oncreate } = await openCodex(async () => failing("cli-outdated"));
    expect(codexCard()).toBe("Needs an update");
    expect(probeLine()?.dataset.probeState).toBe("cli-outdated");
    expect(probeLine()?.textContent).toContain("Codex on this");
    expect(probeLine()?.textContent).toContain("too old for this model");
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')?.disabled).toBe(true);

    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(oncreate).not.toHaveBeenCalled();
    expect(q('[data-testid="create-bot-sunrise-home"]')).toBeTruthy();
  });

  const FIXES: Array<[ProbeClass, string[]]> = [
    ["signed-out", ["signin"]],
    ["cli-outdated", ["supported-model", "update", "retry"]],
    ["model-unsupported", ["supported-model", "retry"]],
    ["transient", ["retry"]],
    ["not-installed", ["install", "retry"]],
    ["unknown", ["retry"]],
  ];

  for (const [cls, actions] of FIXES) {
    it(`a ${cls} check shows its fix, never says signed in, and creates nothing`, async () => {
      const { oncreate } = await openCodex(async () => failing(cls), {
        onassistedinstall: vi.fn(async () => ({ kind: "installed" })),
      });
      const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-testid^="chat-bot-runtime-probe-"]')].map(
        (b) => b.dataset.testid?.replace("chat-bot-runtime-probe-", ""),
      );
      expect(buttons).toEqual(actions);
      expect(codexCard()).not.toMatch(/signed in/i);
      expect(probeLine()?.textContent ?? "").not.toMatch(/[\u2013\u2014]|hq bot|diagnostic/);
      // The status read's "Signed in" is nowhere on the screen.
      expect(host.textContent).not.toMatch(/\bSigned in\b/);
      click('[data-testid="chat-bot-create"]');
      await settle();
      expect(oncreate).not.toHaveBeenCalled();
    });
  }

  it("Use a supported model checks again on that model and creates the bot with it", async () => {
    const { oncreate, probeBotRuntime } = await openCodex(async (input) =>
      input.model === "gpt-5.5" ? passing({ model: "gpt-5.5" }) : failing("model-unsupported"),
    );
    expect(q('[data-testid="chat-bot-runtime-probe-supported-model"]')?.textContent).toContain("Use GPT-5.5");
    click('[data-testid="chat-bot-runtime-probe-supported-model"]');
    await settle();
    expect(probeBotRuntime).toHaveBeenLastCalledWith({ runtime: "codex", model: "gpt-5.5", effort: "medium" });
    expect(codexCard()).toBe("Ready");

    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(oncreate).toHaveBeenCalledTimes(1);
    const [input] = oncreate.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(input.model).toBe("gpt-5.5");
  });

  it("a check that only passed on a fallback model creates the bot on that model", async () => {
    const { oncreate } = await openCodex(async () => passing({ modelFallback: { from: "gpt-6-astra", to: "gpt-5.5" } }));
    expect(probeLine()?.textContent).toContain("this bot will use GPT-5.5");
    click('[data-testid="chat-bot-create"]');
    await settle();
    const [input] = oncreate.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(input.model).toBe("gpt-5.5");
  });

  it("Try again checks again, and a passing second check lets the bot be created", async () => {
    let calls = 0;
    const { oncreate } = await openCodex(async () => (++calls === 1 ? failing("transient") : passing()));
    expect(codexCard()).toBe("Didn't answer");
    click('[data-testid="chat-bot-runtime-probe-retry"]');
    await settle();
    expect(calls).toBe(2);
    expect(codexCard()).toBe("Ready");
    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(oncreate).toHaveBeenCalledTimes(1);
  });

  it("Update runs HQ's installer for the tool, then checks again", async () => {
    let calls = 0;
    const onassistedinstall = vi.fn(async () => ({ kind: "installed" }));
    const onrecheckruntimes = vi.fn(async () => undefined);
    await openCodex(async () => (++calls === 1 ? failing("cli-outdated") : passing()), {
      onassistedinstall,
      onrecheckruntimes,
    });
    click('[data-testid="chat-bot-runtime-probe-update"]');
    await settle(10);
    expect(onassistedinstall).toHaveBeenCalledWith("codex");
    expect(onrecheckruntimes).toHaveBeenCalled();
    expect(calls).toBe(2);
    expect(codexCard()).toBe("Ready");
  });

  it("signed out: Sign in opens the tool's sign-in", async () => {
    const onsignin = vi.fn(async () => undefined);
    await openCodex(async () => failing("signed-out"), { onsignin });
    expect(codexCard()).toBe("Sign in first");
    click('[data-testid="chat-bot-runtime-probe-signin"]');
    await settle();
    expect(onsignin).toHaveBeenCalledWith("codex");
  });

  it("shows Checking Codex while the check runs, and Create waits for it", async () => {
    let answer!: (value: ProbeAnswer) => void;
    const { oncreate } = await openCodex(() => new Promise<ProbeAnswer>((resolve) => (answer = resolve)));
    expect(codexCard()).toBe("Checking...");
    expect(probeLine()?.textContent?.trim()).toBe("Checking Codex...");
    expect(host.textContent).not.toMatch(/\bSigned in\b/);

    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(q('[data-testid="chat-bot-create"]')?.textContent).toBe("Checking Codex...");
    expect(oncreate).not.toHaveBeenCalled();

    answer(passing());
    await settle();
    expect(oncreate).toHaveBeenCalledTimes(1);
  });

  it("a check that cannot be reached counts as not answering, and creates nothing", async () => {
    const { oncreate } = await openCodex(async () => ({ ok: false, reason: "error", message: "boom" }));
    expect(probeLine()?.dataset.probeState).toBe("transient");
    expect(probeLine()?.textContent).not.toContain("boom");
    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(oncreate).not.toHaveBeenCalled();
  });

  it("an hq CLI without the check falls back to the sign-in status, as before", async () => {
    const { oncreate } = await openCodex(async () => ({ ok: true, value: { supported: false } }));
    expect(codexCard()).toBe("Signed in");
    expect(probeLine()).toBeNull();
    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(oncreate).toHaveBeenCalledTimes(1);
  });

  it("a tool the status read says is signed out is not checked; its own Sign in stays", async () => {
    const { probeBotRuntime } = await openCodex(async () => passing(), {
      botRuntimeReady: { claude: false, codex: false, grok: false },
      botRuntimeStatus: { claude: SIGNED_OUT, codex: SIGNED_OUT, grok: SIGNED_OUT },
    });
    expect(probeBotRuntime).not.toHaveBeenCalled();
  });

  it("a host without the check keeps today's behaviour", async () => {
    const oncreate = vi.fn(async () => undefined);
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(CreateBotFlow, {
      target: host,
      props: {
        botRuntimeReady: { claude: false, codex: true, grok: false },
        botRuntimeStatus: { claude: SIGNED_OUT, codex: SIGNED_IN, grok: SIGNED_OUT },
        botWorkers: [],
        existingNames: [],
        initialName: "Saturday",
        initialHome: "local",
        oncreate,
      },
    });
    await settle();
    expect(codexCard()).toBe("Signed in");
    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(oncreate).toHaveBeenCalledTimes(1);
  });
});
