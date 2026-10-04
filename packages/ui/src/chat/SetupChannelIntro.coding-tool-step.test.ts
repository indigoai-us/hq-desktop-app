// @vitest-environment happy-dom

// The #welcome coding-tool step does one thing: get Claude Code or Codex
// installed and signed in. It used to also offer "Set up with Claude /
// ChatGPT" assistant-app buttons inside the guide and an "Already use Claude
// Code or Codex?" card that told people to type /setup in their tool. Both are
// gone from this step (the setup bot offers "Continue in Claude/Codex" itself).
// These tests pin that they stay gone for every combination of tools.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import SetupChannelIntro from "./SetupChannelIntro.svelte";
import { SETUP_BOT_NO_RUNTIME, type SetupBotLauncher } from "./setup-bot";
import { NO_AI_TOOLS, type AiTools } from "../settings/setup-launch";

const ok = <T,>(value: T) => ({ ok: true as const, value });

function makeShell(tools: Partial<AiTools>) {
  return {
    detectAiTools: vi.fn(async () => ok({ ...NO_AI_TOOLS, ...tools, any: true })),
    openClaudeCodeLink: vi.fn(async () => ok(undefined)),
    launchClaudeCode: vi.fn(async () => ok(undefined)),
    launchCodexWorkspace: vi.fn(async () => ok(undefined)),
    launchCliInTerminal: vi.fn(async () => ok(undefined)),
  };
}

const settings = { getSetupStatus: async () => ok({ hqFolderPath: "/tmp/HQ" }) };
const readyBot = { existing: false, ready: true, starting: false, error: null, start: vi.fn() };
const noRuntimeBot: SetupBotLauncher = {
  existing: false,
  ready: false,
  starting: false,
  error: SETUP_BOT_NO_RUNTIME,
  start: vi.fn(async () => ({ ok: false as const, reason: SETUP_BOT_NO_RUNTIME })),
};

function installGuide() {
  return {
    oninstall: vi.fn(async () => ({ ok: true })),
    onsignin: vi.fn(async () => ({ ok: true })),
    onrefresh: vi.fn(async () => undefined),
    downloadUrlFor: () => "https://claude.com/download",
    onopen: vi.fn(() => undefined),
    // A host still passes this; the step must not render it.
    onopenassistant: vi.fn(async () => ({ ok: true })),
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.clearAllMocks();
});

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function render(tools: Partial<AiTools>, props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SetupChannelIntro, {
    target: host,
    props: { settings, shell: makeShell(tools), ...props } as never,
  });
  await settle();
}

const q = (sel: string) => host.querySelector<HTMLElement>(sel);

function expectNoOtherWayThrough(): void {
  expect(q('[data-testid="setup-elsewhere"]')).toBeNull();
  expect(q('[data-testid="setup-elsewhere-claude"]')).toBeNull();
  expect(q('[data-testid="setup-elsewhere-codex"]')).toBeNull();
  expect(q('[data-testid="install-choice-panel"]')).toBeNull();
  expect(host.textContent).not.toContain("Already use Claude Code or Codex?");
  expect(host.textContent).not.toContain("Set up with Claude");
  expect(host.textContent).not.toContain("Set up with ChatGPT");
  expect(host.textContent).not.toContain("type /setup");
}

const TOOL_STATES: Array<[string, Partial<AiTools>]> = [
  ["nothing installed", {}],
  ["Claude desktop app only", { claude_desktop: true }],
  ["Claude Code CLI only", { claude_cli: true }],
  ["Claude Code CLI and desktop app", { claude_cli: true, claude_desktop: true }],
  ["ChatGPT app only", { codex_desktop: true }],
  ["Codex CLI only", { codex_cli: true }],
  ["Codex CLI and ChatGPT app", { codex_cli: true, codex_desktop: true }],
  [
    "everything",
    { claude_cli: true, claude_desktop: true, codex_cli: true, codex_desktop: true },
  ],
];

describe("SetupChannelIntro - the coding-tool step does one thing", () => {
  for (const [label, tools] of TOOL_STATES) {
    it(`${label}: no "set up elsewhere" card next to Run Setup`, async () => {
      await render(tools, { setupBot: readyBot });
      expect(q('[data-testid="setup-run"]')).not.toBeNull();
      expectNoOtherWayThrough();
    });

    it(`${label}: the install guide offers install/sign-in only, on both tabs`, async () => {
      await render(tools, { setupBot: noRuntimeBot, installGuide: installGuide() });
      expect(q('[data-testid="setup-install-guide"]')).not.toBeNull();
      expect(q('[data-testid="setup-install-guide-primary"]')).not.toBeNull();
      expect(q('[data-testid="setup-bot-fallback"]')).not.toBeNull();
      expectNoOtherWayThrough();

      q('[data-testid="setup-install-guide-pick-codex"]')!.click();
      await settle();
      expect(q('[data-testid="setup-install-guide"]')!.dataset.tool).toBe("codex");
      expectNoOtherWayThrough();
    });
  }
});
