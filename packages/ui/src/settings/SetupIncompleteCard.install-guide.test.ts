// @vitest-environment happy-dom

/**
 * US-005 wiring: when no coding tool is installed AND no signed-in launcher
 * path exists, the SetupIncompleteCard renders the guided install path
 * (SetupInstallGuide) instead of the dead-end "Open in Claude Code" fallback.
 * When a tool IS present, the card falls back to the existing launches.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import SetupIncompleteCard from "./SetupIncompleteCard.svelte";
import { NO_AI_TOOLS } from "./setup-launch";

const ok = <T,>(value: T) => ({ ok: true as const, value });

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
    await Promise.resolve();
  }
}

interface Opts {
  claudeInstalled?: boolean;
  installGuideOn?: boolean;
}

async function render(opts: Opts = {}): Promise<{
  oninstall: ReturnType<typeof vi.fn>;
  onsignin: ReturnType<typeof vi.fn>;
}> {
  const aiTools = {
    ...NO_AI_TOOLS,
    claude_cli: opts.claudeInstalled ?? false,
    any: Boolean(opts.claudeInstalled),
  };
  const settings = {
    getSetupStatus: async () => ok({ hqRootValid: false, configured: false, hqFolderPath: "/tmp/HQ" }),
  };
  const shell = {
    detectAiTools: vi.fn(async () => ok(aiTools)),
    openClaudeCodeLink: vi.fn(async () => ok(undefined)),
    launchClaudeCode: vi.fn(async () => ok(undefined)),
    launchCliInTerminal: vi.fn(async () => ok(undefined)),
  };
  const oninstall = vi.fn(async () => ({ ok: true }));
  const onsignin = vi.fn(async () => ({ ok: true }));

  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SetupIncompleteCard, {
    target: host,
    props: {
      settings: settings as never,
      shell: shell as never,
      setupBot: null,
      installGuide: opts.installGuideOn === false
        ? null
        : {
            oninstall,
            onsignin,
            onrefresh: async () => undefined,
            downloadUrlFor: () => "https://download.example/claude",
            onopen: () => undefined,
          },
    },
  });
  await settle();
  return { oninstall, onsignin };
}

describe("SetupIncompleteCard - guided install path (US-005)", () => {
  it("renders the guided install when no coding tool is installed and installGuide is provided", async () => {
    await render({ claudeInstalled: false });
    const guide = host.querySelector('[data-testid="setup-install-guide"]');
    expect(guide).toBeTruthy();
    // The dead-end launches are still visible as a secondary option, but the
    // guided path is the primary way through.
    expect(host.querySelector('[data-testid="setup-install-guide-primary"]')?.textContent).toBe(
      "Install Claude",
    );
  });

  it("does not render the guided install when a coding tool is already present", async () => {
    await render({ claudeInstalled: true });
    expect(host.querySelector('[data-testid="setup-install-guide"]')).toBeNull();
    // The existing launches remain, so the card is not empty.
    expect(host.querySelector('[data-testid="setup-open-claude"]')).toBeTruthy();
  });

  it("does not render the guided install when the host has not wired it in (opt-in prop)", async () => {
    await render({ claudeInstalled: false, installGuideOn: false });
    expect(host.querySelector('[data-testid="setup-install-guide"]')).toBeNull();
  });

  it("routes a click on Install through the caller's oninstall, then the caller's onsignin - HQ never asks for the password itself", async () => {
    const { oninstall, onsignin } = await render({ claudeInstalled: false });
    const primary = host.querySelector<HTMLButtonElement>('[data-testid="setup-install-guide-primary"]')!;
    primary.click();
    await vi.waitFor(() => expect(onsignin).toHaveBeenCalledTimes(1));
    expect(oninstall).toHaveBeenCalledWith("claude");
    // Install and sign-in are one step: the sign-in follows with no second click.
    expect(onsignin.mock.calls[0]?.[0]).toBe("claude");
  });
});
