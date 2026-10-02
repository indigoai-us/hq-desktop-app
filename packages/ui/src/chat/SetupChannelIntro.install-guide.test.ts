// @vitest-environment happy-dom

/**
 * US-005: the #welcome hero surfaces the guided install path (SetupInstallGuide)
 * when the setup bot cannot start because no coding tool is signed in on this
 * computer. The old dead-end error ("No coding tool is signed in ... yet")
 * stays, but underneath it the host-provided install / sign-in callbacks
 * become the way forward. HQ never handles the user's password.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import SetupChannelIntro from "./SetupChannelIntro.svelte";
import { SETUP_BOT_NO_RUNTIME, type SetupBotLauncher } from "./setup-bot";
import { NO_AI_TOOLS, type AiTools } from "../settings/setup-launch";

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

/** A setupBot launcher whose start() would fail with NO_RUNTIME. The intro
 *  reads the error through the launcher's `error` field, so the guide renders
 *  on next mount without needing to actually click Run Setup. */
const setupBotNoRuntime: SetupBotLauncher = {
  existing: false,
  ready: false,
  starting: false,
  error: SETUP_BOT_NO_RUNTIME,
  start: vi.fn(async () => ({ ok: false as const, reason: SETUP_BOT_NO_RUNTIME })),
};

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

async function render(props: Record<string, unknown>) {
  const shell = makeShell({});
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SetupChannelIntro, {
    target: host,
    props: { settings, shell, setupBot: setupBotNoRuntime, ...props } as never,
  });
  await settle();
  return { shell };
}

describe("SetupChannelIntro - guided install path (US-005)", () => {
  it("renders SetupInstallGuide when NO_RUNTIME error is surfaced and installGuide is wired", async () => {
    const oninstall = vi.fn(async () => ({ ok: true }));
    const onsignin = vi.fn(async () => ({ ok: true }));
    const onrefresh = vi.fn(async () => undefined);
    const onopen = vi.fn(() => undefined);
    await render({
      installGuide: {
        oninstall,
        onsignin,
        onrefresh,
        downloadUrlFor: () => "https://claude.com/download",
        onopen,
      },
    });
    // The dead-end error text still shows...
    expect(host.querySelector('[data-testid="setup-bot-error"]')?.textContent).toContain(
      "signed in",
    );
    // ...but underneath it the guide is mounted with a primary action.
    expect(host.querySelector('[data-testid="setup-install-guide"]')).toBeTruthy();
    expect(
      host.querySelector('[data-testid="setup-install-guide-primary"]')?.textContent,
    ).toBe("Install Claude");
  });

  it("does not render the guided path when the host has not wired installGuide", async () => {
    await render({ installGuide: null });
    expect(host.querySelector('[data-testid="setup-bot-error"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="setup-install-guide"]')).toBeNull();
  });

  it("routes one Install click to the host's oninstall and then its onsignin, with no second click", async () => {
    const oninstall = vi.fn(async () => ({ ok: true as const }));
    const onsignin = vi.fn((_tool: string) => new Promise<{ ok: true }>(() => undefined));
    const onrefresh = vi.fn(async () => undefined);
    await render({
      installGuide: {
        oninstall,
        onsignin,
        onrefresh,
        downloadUrlFor: () => "https://claude.com/download",
        onopen: () => undefined,
      },
    });
    const primary = host.querySelector<HTMLButtonElement>(
      '[data-testid="setup-install-guide-primary"]',
    )!;
    primary.click();
    // The install resolves and the browser sign-in starts by itself.
    await vi.waitFor(() => {
      const state = host.querySelector('[data-testid="setup-install-guide-state"]');
      expect(state?.textContent).toBe("signing-in");
    });
    expect(oninstall).toHaveBeenCalledWith("claude");
    expect(onsignin).toHaveBeenCalledTimes(1);
    expect(onsignin.mock.calls[0]?.[0]).toBe("claude");
    expect(
      host.querySelector('[data-testid="setup-install-guide-primary"]')?.textContent,
    ).toBe("Waiting for sign-in…");
    expect(
      host.querySelector('[data-testid="setup-install-guide-lede"]')?.textContent,
    ).toContain("in your browser");
  });

  it("surfaces a plain reason when install fails and offers a manual download", async () => {
    const oninstall = vi.fn(async () => ({
      ok: false as const,
      reason: "HQ couldn't reach the download server.",
    }));
    const onopen = vi.fn(() => undefined);
    await render({
      installGuide: {
        oninstall,
        onsignin: async () => ({ ok: true as const }),
        onrefresh: async () => undefined,
        downloadUrlFor: () => "https://claude.com/download",
        onopen,
      },
    });
    host
      .querySelector<HTMLButtonElement>('[data-testid="setup-install-guide-primary"]')!
      .click();
    await vi.waitFor(() => {
      const state = host.querySelector('[data-testid="setup-install-guide-state"]');
      expect(state?.textContent).toBe("install-failed");
    });
    expect(
      host.querySelector('[data-testid="setup-install-guide-error"]')?.textContent,
    ).toContain("download server");
    const download = host.querySelector<HTMLButtonElement>(
      '[data-testid="setup-install-guide-download"]',
    )!;
    expect(download.textContent).toContain("Download Claude Code");
    download.click();
    await settle();
    expect(onopen).toHaveBeenCalledWith("https://claude.com/download");
  });
});

describe("SetupChannelIntro - one next step while no coding tool is signed in", () => {
  function guide(overrides: Record<string, unknown> = {}) {
    return {
      oninstall: vi.fn(async () => ({ ok: true as const })),
      onsignin: vi.fn(async () => ({ ok: true as const })),
      onrefresh: vi.fn(async () => undefined),
      downloadUrlFor: () => "https://claude.com/download",
      onopen: () => undefined,
      ...overrides,
    };
  }

  it("drops Retry and the hero button while the guide owns the next step, keeping the step-by-step link", async () => {
    await render({ installGuide: guide() });
    expect(host.querySelector('[data-testid="setup-install-guide"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="setup-bot-retry"]')).toBeNull();
    expect(host.querySelector('[data-testid="setup-run"]')).toBeNull();
    expect(host.querySelector('[data-testid="setup-bot-fallback"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="setup-bot-error"]')?.textContent).not.toContain("Retry");
  });

  it("keeps Retry when the host has no guide to offer", async () => {
    await render({ installGuide: null });
    expect(host.querySelector('[data-testid="setup-bot-retry"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="setup-run"]')).toBeTruthy();
  });

  it("an already signed-in tool shows Continue, and Continue starts the setup bot", async () => {
    const start = vi.fn(async () => ({ ok: true as const, existing: false }));
    await render({
      setupBot: { ...setupBotNoRuntime, start },
      installGuide: guide({ onstatus: vi.fn(async (tool: string) => tool === "claude") }),
    });
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="setup-install-guide-state"]')?.textContent).toBe("done"),
    );
    const primary = host.querySelector<HTMLButtonElement>('[data-testid="setup-install-guide-primary"]')!;
    expect(primary.textContent).toBe("Continue");
    expect(start).not.toHaveBeenCalled();
    primary.click();
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  });

  it("a sign-in finished in the guide starts the setup bot without another click", async () => {
    const start = vi.fn(async () => ({ ok: true as const, existing: false }));
    await render({
      setupBot: { ...setupBotNoRuntime, start },
      installGuide: guide({ onstatus: vi.fn(async () => false) }),
    });
    const primary = () =>
      host.querySelector<HTMLButtonElement>('[data-testid="setup-install-guide-primary"]')!;
    primary().click(); // Install Claude: installs, signs in, then continues by itself
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  });
});
