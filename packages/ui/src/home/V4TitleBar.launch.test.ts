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

function makeAdapter(
  tools: Partial<AiTools>,
  caps: { localFiles?: boolean; hqFolderPath?: string } = {},
) {
  const shell = {
    detectAiTools: vi.fn(async () => ok({ ...NO_AI_TOOLS, ...tools })),
    openClaudeCodeLink: vi.fn(async (_url: string) => ok(undefined)),
    launchClaudeCode: vi.fn(async () => ok(undefined)),
    launchCodexWorkspace: vi.fn(async (..._args: [string, string?]) =>
      ok(undefined),
    ),
    launchCliInTerminal: vi.fn(
      async (_args: Record<string, unknown>) => ok(undefined),
    ),
  };
  return {
    kind: "desktop" as const,
    capabilities: {
      hasWindowControls: true,
      localFiles: caps.localFiles ?? true,
    },
    isAvailable: () => false,
    shell,
    files: {
      revealInFinder: vi.fn(async (_path: string) => ok(undefined)),
      revealHqRoot: vi.fn(async () => ok(undefined)),
    },
    settings: {
      getSetupStatus: vi.fn(async () =>
        ok({ hqFolderPath: caps.hqFolderPath ?? "/tmp/HQ" }),
      ),
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

async function mountBar(
  adapter: ReturnType<typeof makeAdapter>,
  extraProps: Record<string, unknown> = {},
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(V4TitleBar, {
    target: host,
    props: {
      adapter,
      version: "0.0.0-test",
      syncState: "idle",
      watchedCount: 0,
      ...extraProps,
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
  it("offers a labeled host create action without launching an external tool", async () => {
    const onselect = vi.fn();
    const adapter = makeAdapter({});
    await mountBar(adapter, { primaryAction: { label: "New session", onselect } });
    const button = host.querySelector<HTMLButtonElement>('[data-testid="titlebar-primary-action"]');
    expect(button?.textContent).toContain("New session");
    button?.click();
    expect(onselect).toHaveBeenCalledTimes(1);
    expect(adapter.shell.launchCodexWorkspace).not.toHaveBeenCalled();
  });

  it("does not expose creation when the host has no session capability", async () => {
    await mountBar(makeAdapter({}));
    expect(host.querySelector('[data-testid="titlebar-primary-action"]')).toBeNull();
  });
  it("applies the shared window-controls inset so tokens.css owns height and gutter", async () => {
    await mountBar(makeAdapter({}));
    const header = host.querySelector<HTMLElement>(".v4-titlebar");
    expect(header).toBeTruthy();
    expect(header?.classList.contains("has-window-controls")).toBe(true);
  });

  it("keeps Launch but no longer renders the folder, console, meetings, or files icons (console-rail US-003)", async () => {
    await mountBar(makeAdapter({}));
    expect(host.querySelector('[data-testid="titlebar-launch"]')).toBeTruthy();
    for (const id of [
      "titlebar-meetings",
      "titlebar-console",
      "titlebar-reveal-folder",
      "titlebar-files",
    ]) {
      expect(host.querySelector(`[data-testid="${id}"]`), id).toBeNull();
    }
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
    const menu = host.querySelector('[data-testid="titlebar-launch-menu"]');
    expect(menu).toBeTruthy();
    // Regression (owner bug, beta.10): the menu surface must be the
    // near-opaque popover-strong convention, not a glass/translucent token —
    // nested backdrop-filter is neutered outside the titlebar's backdrop
    // root, so a translucent surface lets the channel toolbar read through.
    expect(menu?.classList.contains("v4-popover-strong-surface")).toBe(true);
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
    // Strict arity: no second (prompt) argument at all, so the Rust command
    // receives None and never fires the delayed codex://threads/new?prompt=
    // deep link.
    expect(adapter.shell.launchCodexWorkspace.mock.calls[0]).toEqual([
      "/tmp/HQ",
    ]);
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
    // Terminal launches carry ONLY path + tool — no prompt key of any kind.
    expect(
      Object.keys(
        adapter.shell.launchCliInTerminal.mock.calls[0]?.[0] ?? {},
      ).sort(),
    ).toEqual(["path", "tool"]);
  });

  it("shows Not installed with Install when a tool is missing", async () => {
    const adapter = makeAdapter({});
    await mountBar(adapter);
    host
      .querySelector<HTMLButtonElement>('[data-testid="titlebar-launch"]')
      ?.click();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    await tick();
    const missing = host.querySelector(
      '[data-testid="titlebar-launch-claude-missing"]',
    );
    expect(missing?.textContent).toContain("Not installed");
    expect(
      host.querySelector('[data-testid="titlebar-launch-claude-install"]')
        ?.textContent,
    ).toContain("Install");
    expect(adapter.shell.openClaudeCodeLink).not.toHaveBeenCalled();
    expect(
      host.querySelector('[data-testid="titlebar-launch-folder"]')?.textContent,
    ).toContain("/tmp/HQ");
  });
});

describe("V4TitleBar back/forward controls", () => {
  it("places compact buttons beside the date, outside the drag region", async () => {
    await mountBar(makeAdapter({}));
    const date = host.querySelector('[data-testid="titlebar-day-date"]');
    const cluster = host.querySelector('[data-testid="titlebar-history"]');
    const back = host.querySelector<HTMLButtonElement>(
      '[data-testid="titlebar-back"]',
    );
    const forward = host.querySelector<HTMLButtonElement>(
      '[data-testid="titlebar-forward"]',
    );
    expect(date).toBeTruthy();
    expect(cluster).toBeTruthy();
    expect(back).toBeTruthy();
    expect(forward).toBeTruthy();
    expect(
      date!.compareDocumentPosition(cluster!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(cluster?.getAttribute("data-tauri-drag-region")).toBe("false");
    expect(cluster?.hasAttribute("data-no-drag")).toBe(true);
    expect(back?.closest("[data-no-drag]")).toBe(cluster);
  });

  it("disables both endpoints with accessible names and destination hover labels", async () => {
    const onback = vi.fn();
    const onforward = vi.fn();
    await mountBar(makeAdapter({}), {
      canGoBack: false,
      canGoForward: false,
      onback,
      onforward,
    });
    const back = host.querySelector<HTMLButtonElement>(
      '[data-testid="titlebar-back"]',
    );
    const forward = host.querySelector<HTMLButtonElement>(
      '[data-testid="titlebar-forward"]',
    );
    expect(back?.disabled).toBe(true);
    expect(forward?.disabled).toBe(true);
    expect(back?.getAttribute("aria-label")).toBe("Back");
    expect(forward?.getAttribute("aria-label")).toBe("Forward");
    expect(back?.getAttribute("title")).toBe("Back");
    expect(forward?.getAttribute("title")).toBe("Forward");
    back?.click();
    forward?.click();
    expect(onback).not.toHaveBeenCalled();
    expect(onforward).not.toHaveBeenCalled();
  });

  it("clicks Back then Forward and shows destination hover labels", async () => {
    const onback = vi.fn();
    const onforward = vi.fn();
    await mountBar(makeAdapter({}), {
      canGoBack: true,
      canGoForward: true,
      backLabel: "Channel",
      forwardLabel: "Meetings",
      onback,
      onforward,
    });
    const back = host.querySelector<HTMLButtonElement>(
      '[data-testid="titlebar-back"]',
    );
    const forward = host.querySelector<HTMLButtonElement>(
      '[data-testid="titlebar-forward"]',
    );
    expect(back?.disabled).toBe(false);
    expect(forward?.disabled).toBe(false);
    expect(back?.getAttribute("title")).toBe("Channel");
    expect(forward?.getAttribute("title")).toBe("Meetings");
    back?.click();
    forward?.click();
    expect(onback).toHaveBeenCalledTimes(1);
    expect(onforward).toHaveBeenCalledTimes(1);
  });

  it("keeps history buttons flex-fixed so they survive minimum width", async () => {
    await mountBar(makeAdapter({}));
    const cluster = host.querySelector<HTMLElement>(
      '[data-testid="titlebar-history"]',
    );
    expect(cluster).toBeTruthy();
    expect(getComputedStyle(cluster!).flexShrink).toBe("0");
  });
});
