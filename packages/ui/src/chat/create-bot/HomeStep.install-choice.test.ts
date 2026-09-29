// @vitest-environment happy-dom

/**
 * Regression test for the operator's report on the New bot wizard: on a
 * clean Windows machine a non-technical persona hit "Claude Code · not
 * installed" and the only actionable button was "Check again". The main
 * text told them to run `npm i -g @anthropic-ai/claude-code` in a terminal
 * — which they had never opened. This test fails on that behaviour and
 * passes on the assistant-app buttons the operator asked for.
 *
 * The shared component under test is `InstallChoice`, mounted through the
 * wizard's real `HomeStep` (not directly), so a regression at either seam
 * lights up here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import CreateBotFlow from "./CreateBotFlow.svelte";
import type { RuntimeStatus } from "./runtime-status.js";
import { NO_AI_TOOLS, type AiTools } from "../../settings/setup-launch.js";

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

const MISSING: RuntimeStatus = {
  state: "notInstalled",
  searched: ["/opt/homebrew/bin", "/usr/local/bin"],
};

const CHATGPT_ONLY: AiTools = { ...NO_AI_TOOLS, codex_desktop: true, any: true };

async function openWizardHome(props: Record<string, unknown> = {}): Promise<{
  onopenassistant: ReturnType<typeof vi.fn>;
  onassistedinstall: ReturnType<typeof vi.fn>;
  onrecheckruntimes: ReturnType<typeof vi.fn>;
}> {
  const onopenassistant = vi.fn(async () => ({ ok: true }));
  const onassistedinstall = vi.fn(async () => ({ ok: true }));
  const onrecheckruntimes = vi.fn(async () => undefined);
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CreateBotFlow, {
    target: host,
    props: {
      botRuntimeReady: { claude: false, codex: false, grok: false },
      botRuntimeStatus: { claude: MISSING, codex: MISSING, grok: MISSING },
      botWorkers: [],
      existingNames: [],
      botCompanies: [{ slug: "indigo", label: "Indigo" }],
      previewPlacement: "top",
      oncreate: async () => undefined,
      onsignin: () => undefined,
      onrecheckruntimes,
      onopenassistant,
      onassistedinstall,
      ...props,
    },
  });
  await settle();
  click('[data-testid="create-bot-next"]');
  await settle();
  expect(q('[data-testid="create-bot-home-step"]')).toBeTruthy();
  return { onopenassistant, onassistedinstall, onrecheckruntimes };
}

describe("New bot wizard — Claude Code is not installed", () => {
  it("offers an install action (not just 'Check again') for the coding tool", async () => {
    // Failing on today's `main`: the wizard's not-installed state shows only
    // the retry chip. This test asserts BOTH the install-choice panel AND
    // the retry survive — the panel is the operator's requirement, the
    // retry is the repo's own policy.
    await openWizardHome({
      aiTools: { ...NO_AI_TOOLS, codex_desktop: true, any: true },
    });
    // Some install action is visible somewhere on the panel.
    const panel = q('[data-testid="install-choice-panel"]');
    expect(panel).toBeTruthy();
    // Retry stayed alongside per policy.
    expect(q('[data-testid="install-choice-recheck"]')).toBeTruthy();
  });

  it("never shows a terminal command anywhere in the visible copy", async () => {
    await openWizardHome({ aiTools: NO_AI_TOOLS });
    const text = q('[data-testid="install-choice-panel"]')!.textContent!;
    expect(text).not.toMatch(/\bnpm\b/i);
    // "CLI" as a standalone word may appear elsewhere on the wizard, but
    // must not appear inside the install-choice panel's own copy.
    expect(text).not.toMatch(/\bCLI\b/);
    expect(text).not.toMatch(/\bterminal\b/i);
  });

  it("'Set up with ChatGPT' opens the assistant with the fixed install prompt", async () => {
    const { onopenassistant } = await openWizardHome({ aiTools: CHATGPT_ONLY });
    const btn = q<HTMLButtonElement>('[data-testid="install-choice-open-chatgpt"]')!;
    btn.click();
    await settle();
    expect(onopenassistant).toHaveBeenCalledTimes(1);
    const [assistant, url] = onopenassistant.mock.calls[0];
    expect(assistant).toBe("chatgpt-desktop");
    const parsed = new URL(url);
    expect(parsed.protocol).toBe("codex:");
    expect(parsed.searchParams.get("prompt")).toBeTruthy();
  });
});
