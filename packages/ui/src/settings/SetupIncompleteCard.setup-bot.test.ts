// @vitest-environment happy-dom

/**
 * Home's "Finish setting up HQ" card with the setup bot (bots v2, step 3):
 * the primary action opens the setup bot's conversation when one exists, and
 * otherwise creates it — the same path #welcome takes. With no coding tool
 * signed in there is nothing to create, so the card keeps today's tool
 * launches as the way through.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import SetupIncompleteCard from "./SetupIncompleteCard.svelte";
import { SETUP_BOT_COPY, type SetupBotLauncher } from "../chat/setup-bot";
import { NO_AI_TOOLS } from "./setup-launch";

const ok = <T,>(value: T) => ({ ok: true as const, value });

const settings = {
  // hqRootValid false = setup never finished, which is when the card shows.
  getSetupStatus: async () => ok({ hqRootValid: false, configured: false, hqFolderPath: "/tmp/HQ" }),
};

const shell = {
  detectAiTools: vi.fn(async () => ok({ ...NO_AI_TOOLS })),
  openClaudeCodeLink: vi.fn(async () => ok(undefined)),
  launchClaudeCode: vi.fn(async () => ok(undefined)),
  launchCliInTerminal: vi.fn(async () => ok(undefined)),
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.clearAllMocks();
});

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function render(setupBot: SetupBotLauncher | null): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SetupIncompleteCard, {
    target: host,
    props: { settings: settings as never, shell: shell as never, setupBot },
  });
  await settle();
  expect(host.querySelector('[data-testid="setup-incomplete-card"]')).toBeTruthy();
}

describe("SetupIncompleteCard with a setup bot", () => {
  it("opens the setup bot's conversation when one already exists", async () => {
    const start = vi.fn(async () => ({ ok: true as const, existing: true }));
    await render({ existing: true, ready: true, start });

    const primary = host.querySelector<HTMLButtonElement>('[data-testid="setup-open-bot"]')!;
    expect(primary.textContent?.trim()).toBe(SETUP_BOT_COPY.open);
    primary.click();
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    // The tool launches stay as a secondary way in, never the headline.
    expect(host.querySelector('[data-testid="setup-open-claude"]')?.classList.contains("primary")).toBe(false);
  });

  it("offers to create the setup bot when a coding tool is signed in, and says why if it fails", async () => {
    const start = vi.fn(async () => ({ ok: false as const, reason: "Claude Code is not signed in." }));
    await render({ existing: false, ready: true, start });

    const primary = host.querySelector<HTMLButtonElement>('[data-testid="setup-open-bot"]')!;
    expect(primary.textContent?.trim()).toBe(SETUP_BOT_COPY.create);
    primary.click();
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="setup-card-bot-error"]')?.textContent).toContain("not signed in"),
    );
    // Nothing is a dead end: the tool launches are still there.
    expect(host.querySelector('[data-testid="setup-open-claude"]')).toBeTruthy();
  });

  it("falls back to the tool launches when no coding tool is signed in", async () => {
    const start = vi.fn(async () => ({ ok: true as const, existing: false }));
    await render({ existing: false, ready: false, start });

    expect(host.querySelector('[data-testid="setup-open-bot"]')).toBeNull();
    const claude = host.querySelector<HTMLButtonElement>('[data-testid="setup-open-claude"]')!;
    expect(claude.classList.contains("primary")).toBe(true);
    expect(host.querySelector('[data-testid="setup-open-codex"]')).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
  });

  it("without a launcher at all, the card is exactly what it was", async () => {
    await render(null);
    expect(host.querySelector('[data-testid="setup-open-bot"]')).toBeNull();
    expect(host.querySelector('[data-testid="setup-open-claude"]')?.classList.contains("primary")).toBe(true);
  });
});
