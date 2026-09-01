// @vitest-environment happy-dom

// Titlebar "Launch" menu: opens the HQ folder in Claude Code / Codex
// (ChatGPT) / Grok Build via the SAME cascades SetupChannelIntro uses
// (settings/launch-actions.ts), but as a PLAIN launch — no `/setup`
// prompt pre-typed. Covers: placement (left of the meetings icon),
// dropdown open, and per-item adapter dispatch.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import V4TitleBar from "./V4TitleBar.svelte";
import { NO_AI_TOOLS, type AiTools } from "../settings/setup-launch";

const ok = <T,>(value: T) => ({ ok: true as const, value });

function makeAdapter(tools: Partial<AiTools>) {
  const shell = {
    detectAiTools: vi.fn(async () => ok({ ...NO_AI_TOOLS, ...tools })),
    openClaudeCodeLink: vi.fn(async (_url: string) => ok(undefined)),
    launchClaudeCode: vi.fn(async () => ok(undefined)),
    launchCodexWorkspace: vi.fn(async () => ok(undefined)),
    launchCliInTerminal: vi.fn(async () => ok(undefined)),
  };
  return {
    kind: "desktop" as const,
    capabilities: { hasWindowControls: true },
    isAvailable: () => false,
    shell,
    settings: {
      getSetupStatus: vi.fn(async () => ok({ hqFolderPath: "/tmp/HQ" })),
    },
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function mountBar(adapter: ReturnType<typeof makeAdapter>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(V4TitleBar, {
    target: host,
    props: {
      adapter,
      version: "0.0.0-test",
      syncState: "idle",
      watchedCount: 0,
    } as never,
  });
  await tick();
}

async function openMenuAndClick(
  adapter: ReturnType<typeof makeAdapter>,
  itemTestId: string,
) {
  await mountBar(adapter);
  host
    .querySelector<HTMLButtonElement>('[data-testid="titlebar-launch"]')
    ?.click();
  await tick();
  const item = host.querySelector<HTMLButtonElement>(
    `[data-testid="${itemTestId}"]`,
  );
  expect(item, `${itemTestId} renders`).toBeTruthy();
  item?.click();
  // Let the async folder fetch + launch cascade settle.
  await tick();
  await new Promise((r) => setTimeout(r, 0));
  await tick();
}

describe("V4TitleBar Launch menu", () => {
  it("renders the Launch button immediately to the LEFT of the meetings icon", async () => {
    await mountBar(makeAdapter({}));
    const launch = host.querySelector('[data-testid="titlebar-launch"]');
    const meetings = host.querySelector('[data-testid="titlebar-meetings"]');
    expect(launch).toBeTruthy();
    expect(meetings).toBeTruthy();
    // DOM order: Launch precedes Meetings in the same actions cluster.
    expect(
      launch!.compareDocumentPosition(meetings!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("opens a dropdown with the three tool items", async () => {
    await mountBar(makeAdapter({}));
    expect(
      host.querySelector('[data-testid="titlebar-launch-menu"]'),
    ).toBeNull();
    host
      .querySelector<HTMLButtonElement>('[data-testid="titlebar-launch"]')
      ?.click();
    await tick();
    expect(
      host.querySelector('[data-testid="titlebar-launch-menu"]'),
    ).toBeTruthy();
    for (const key of ["claude", "codex", "grok"]) {
      expect(
        host.querySelector(`[data-testid="titlebar-launch-${key}"]`),
        `${key} item renders`,
      ).toBeTruthy();
    }
  });

  it("Claude Code: desktop deep link opens the folder WITHOUT a q prompt", async () => {
    const adapter = makeAdapter({ claude_desktop: true });
    await openMenuAndClick(adapter, "titlebar-launch-claude");
    expect(adapter.shell.openClaudeCodeLink).toHaveBeenCalledTimes(1);
    const url = adapter.shell.openClaudeCodeLink.mock.calls[0]?.[0] ?? "";
    expect(url).toContain("claude://code/new");
    expect(url).toContain(encodeURIComponent("/tmp/HQ"));
    expect(url).not.toContain("q=");
  });

  it("Claude Code: CLI fallback launches the folder in a terminal", async () => {
    const adapter = makeAdapter({ claude_cli: true });
    await openMenuAndClick(adapter, "titlebar-launch-claude");
    expect(adapter.shell.launchClaudeCode).toHaveBeenCalledWith("/tmp/HQ");
  });

  it("Codex: ChatGPT desktop app opens the workspace with NO prompt", async () => {
    const adapter = makeAdapter({ codex_desktop: true, codex_cli: true });
    await openMenuAndClick(adapter, "titlebar-launch-codex");
    expect(adapter.shell.launchCodexWorkspace).toHaveBeenCalledWith("/tmp/HQ");
    expect(adapter.shell.launchCliInTerminal).not.toHaveBeenCalled();
  });

  it("Codex: CLI-only machines launch codex in a terminal", async () => {
    const adapter = makeAdapter({ codex_cli: true });
    await openMenuAndClick(adapter, "titlebar-launch-codex");
    expect(adapter.shell.launchCliInTerminal).toHaveBeenCalledWith({
      path: "/tmp/HQ",
      tool: "codex",
    });
  });

  it("Grok Build launches the grok CLI in a terminal", async () => {
    const adapter = makeAdapter({ grok_cli: true });
    await openMenuAndClick(adapter, "titlebar-launch-grok");
    expect(adapter.shell.launchCliInTerminal).toHaveBeenCalledWith({
      path: "/tmp/HQ",
      tool: "grok",
    });
  });

  it("shows a per-item error and keeps the menu open when a launch fails", async () => {
    const adapter = makeAdapter({});
    // No tools detected at all → prompt-free "not detected" copy (no /setup).
    await openMenuAndClick(adapter, "titlebar-launch-claude");
    const error = host.querySelector(
      '[data-testid="titlebar-launch-claude-error"]',
    );
    expect(error?.textContent).toContain("Claude Code was not detected");
    expect(error?.textContent).not.toContain("/setup");
    expect(
      host.querySelector('[data-testid="titlebar-launch-menu"]'),
    ).toBeTruthy();
  });
});
