// @vitest-environment happy-dom

// "Already use Claude Code or Codex?" — the other way through setup, shown on
// #welcome next to Run Setup when setup is a bot. It lists only the coding
// tools found on this Mac, opens them with /setup ready, and stays hidden
// when none are installed.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import SetupChannelIntro from "./SetupChannelIntro.svelte";
import { NO_AI_TOOLS, type AiTools } from "../settings/setup-launch";
import { SETUP_ELSEWHERE_COPY } from "./setup-bot";

const ok = <T,>(value: T) => ({ ok: true as const, value });

function makeShell(tools: Partial<AiTools>) {
  return {
    detectAiTools: vi.fn(async () => ok({ ...NO_AI_TOOLS, ...tools })),
    openClaudeCodeLink: vi.fn(async () => ok(undefined)),
    launchClaudeCode: vi.fn(async () => ok(undefined)),
    launchCodexWorkspace: vi.fn(async () => ok(undefined)),
    launchCliInTerminal: vi.fn(async () => ok(undefined)),
  };
}

const settings = { getSetupStatus: async () => ok({ hqFolderPath: "/tmp/HQ" }) };
const setupBot = { existing: false, ready: true, starting: false, error: null, start: vi.fn() };

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function render(tools: Partial<AiTools>, props: Record<string, unknown> = {}) {
  const shell = makeShell(tools);
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SetupChannelIntro, { target: host, props: { settings, shell, setupBot, ...props } as never });
  for (let i = 0; i < 4; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
  return shell;
}

const q = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

describe("SetupChannelIntro — set up in your coding tool instead", () => {
  it("shows the panel with the Launch-button hint and only the tools on this Mac", async () => {
    await render({ claude_cli: true });
    const panel = q("setup-elsewhere");
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain(SETUP_ELSEWHERE_COPY.title);
    expect(panel!.textContent).toMatch(/Launch button in the top right/);
    expect(panel!.textContent).toContain("/setup");
    expect(q("setup-elsewhere-claude")).not.toBeNull();
    expect(q("setup-elsewhere-codex")).toBeNull();
    expect(q("setup-elsewhere-grok")).toBeNull();
  });

  it("opens Codex with the HQ folder and /setup", async () => {
    const shell = await render({ codex_cli: true, codex_desktop: true });
    q("setup-elsewhere-codex")!.click();
    for (let i = 0; i < 3; i += 1) {
      await tick();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(shell.launchCodexWorkspace).toHaveBeenCalledWith("/tmp/HQ", "/setup");
  });

  it("stays hidden when no coding tool is installed", async () => {
    await render({});
    expect(q("setup-elsewhere")).toBeNull();
    expect(q("setup-run")).not.toBeNull();
  });

  it("is not shown on the older scripted setup path (no setup bot)", async () => {
    await render({ claude_cli: true }, { setupBot: null });
    expect(q("setup-elsewhere")).toBeNull();
  });
});
