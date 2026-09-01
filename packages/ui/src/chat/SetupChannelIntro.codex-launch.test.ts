// @vitest-environment happy-dom

// "Open setup in Codex" launch cascade: ChatGPT desktop app's Codex surface
// first (workspace + /setup pre-typed via shell.launchCodexWorkspace),
// terminal CLI fallback (shell.launchCliInTerminal), clipboard-copy last
// resort. Regression for the bug where the button always opened a Terminal.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import SetupChannelIntro from "./SetupChannelIntro.svelte";
import { NO_AI_TOOLS, type AiTools } from "../settings/setup-launch";

const ok = <T,>(value: T) => ({ ok: true as const, value });

function makeShell(tools: Partial<AiTools>, overrides: Record<string, unknown> = {}) {
  return {
    detectAiTools: vi.fn(async () => ok({ ...NO_AI_TOOLS, ...tools })),
    openClaudeCodeLink: vi.fn(async () => ok(undefined)),
    launchClaudeCode: vi.fn(async () => ok(undefined)),
    launchCodexWorkspace: vi.fn(async () => ok(undefined)),
    launchCliInTerminal: vi.fn(async () => ok(undefined)),
    ...overrides,
  };
}

const settings = {
  getSetupStatus: async () => ok({ hqFolderPath: "/tmp/HQ" }),
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function mountAndClickCodex(shell: ReturnType<typeof makeShell>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SetupChannelIntro, {
    target: host,
    props: { settings, shell } as never,
  });
  await tick();
  await tick();
  const btn = host.querySelector<HTMLButtonElement>(
    '[data-testid="setup-launch-codex"]',
  );
  expect(btn, "codex launch button renders").toBeTruthy();
  btn?.click();
  // Let the async launch cascade settle.
  await tick();
  await new Promise((r) => setTimeout(r, 0));
  await tick();
}

describe("SetupChannelIntro codex launch cascade", () => {
  it("opens the ChatGPT desktop app's Codex surface with the workspace and /setup", async () => {
    const shell = makeShell({ codex_desktop: true, codex_cli: true });
    await mountAndClickCodex(shell);
    expect(shell.launchCodexWorkspace).toHaveBeenCalledWith(
      "/tmp/HQ",
      "/setup",
    );
    expect(shell.launchCliInTerminal).not.toHaveBeenCalled();
  });

  it("falls back to the terminal CLI when the desktop launch fails", async () => {
    const shell = makeShell(
      { codex_desktop: true, codex_cli: true },
      {
        launchCodexWorkspace: vi.fn(async () => ({
          ok: false as const,
          reason: "invoke",
          message: "codex app failed",
        })),
      },
    );
    await mountAndClickCodex(shell);
    expect(shell.launchCliInTerminal).toHaveBeenCalledWith({
      path: "/tmp/HQ",
      tool: "codex",
    });
  });

  it("uses the terminal CLI directly when only the CLI is installed", async () => {
    const shell = makeShell({ codex_cli: true });
    await mountAndClickCodex(shell);
    expect(shell.launchCodexWorkspace).not.toHaveBeenCalled();
    expect(shell.launchCliInTerminal).toHaveBeenCalledWith({
      path: "/tmp/HQ",
      tool: "codex",
    });
  });

  it("surfaces the copy-the-prompt last resort when nothing is detected", async () => {
    const shell = makeShell({});
    await mountAndClickCodex(shell);
    expect(shell.launchCodexWorkspace).not.toHaveBeenCalled();
    expect(shell.launchCliInTerminal).not.toHaveBeenCalled();
    const error = host.querySelector(".launch-error");
    expect(error?.textContent).toContain("Codex was not detected");
  });
});
