// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import SetupChannelIntro from "./SetupChannelIntro.svelte";
import { NO_AI_TOOLS } from "../settings/setup-launch";

const ok = <T,>(value: T) => ({ ok: true as const, value });

const shell = {
  detectAiTools: vi.fn(async () => ok({ ...NO_AI_TOOLS })),
  openClaudeCodeLink: vi.fn(async () => ok(undefined)),
  launchClaudeCode: vi.fn(async () => ok(undefined)),
  launchCodexWorkspace: vi.fn(async () => ok(undefined)),
  launchCliInTerminal: vi.fn(async () => ok(undefined)),
};

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

async function settle(): Promise<void> {
  await tick();
  await Promise.resolve();
  await tick();
}

async function mountIntro(props: Record<string, unknown> = {}): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SetupChannelIntro, {
    target: host,
    props: { settings, shell, ...props } as never,
  });
  await settle();
}

describe("ready first action", () => {
  it("keeps the existing welcome action when the rollout is off", async () => {
    await mountIntro();

    expect(host.querySelector('[data-testid="ready-first-action"]')).toBeNull();
    expect(host.querySelector('[data-testid="setup-run"]')).not.toBeNull();
  });

  it("records shown and clicked, then starts the real-use sync path", async () => {
    const onstartsync = vi.fn(async () => ok(undefined));
    const actions: string[] = [];
    const onAction = (event: Event) => {
      const action = (event as CustomEvent<{ action?: unknown }>).detail?.action;
      if (typeof action === "string") actions.push(action);
    };
    window.addEventListener("hq:desktop-post-ready-action", onAction);

    await mountIntro({ readyFirstActionEnabled: true, readyFirstActionReady: true, onstartsync });
    expect(host.querySelector('[data-testid="ready-first-action"]')).not.toBeNull();
    expect(actions).toContain("ready_first_action_shown");

    (host.querySelector('[data-testid="ready-first-action"]') as HTMLButtonElement).click();
    await settle();

    expect(actions).toContain("ready_first_action_clicked");
    expect(onstartsync).toHaveBeenCalledOnce();
    window.removeEventListener("hq:desktop-post-ready-action", onAction);
  });

  it("keeps setup primary before the ready marker", async () => {
    const onstartsync = vi.fn(async () => ok(undefined));
    const actions: string[] = [];
    const onAction = (event: Event) => {
      const action = (event as CustomEvent<{ action?: unknown }>).detail?.action;
      if (typeof action === "string") actions.push(action);
    };
    window.addEventListener("hq:desktop-post-ready-action", onAction);

    await mountIntro({
      readyFirstActionEnabled: true,
      readyFirstActionReady: false,
      onstartsync,
    });

    expect(host.querySelector('[data-testid="ready-first-action"]')).toBeNull();
    expect(
      (host.querySelector('[data-testid="setup-run"]') as HTMLButtonElement | null)?.getAttribute(
        "data-variant",
      ),
    ).toBe("primary");
    expect(actions).not.toContain("ready_first_action_shown");
    window.removeEventListener("hq:desktop-post-ready-action", onAction);
  });
});
