// @vitest-environment happy-dom

/**
 * A coding tool can report itself signed in while that sign-in is dead, so
 * setup fails with "Failed to authenticate" and the Connect step used to
 * offer nothing but "Run Setup with …". Tools the host knows are stale offer
 * "Sign in again" (a forced vendor sign-in), and every connected tool keeps a
 * quiet way back to one, so the step is never a dead end.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import SetupConnectStep from "./SetupConnectStep.svelte";
import type { SetupProviderStatus, SetupProviderTool } from "./setup-run.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const PROVIDERS: SetupProviderStatus = {
  hqReady: true,
  claudeAvailable: true,
  claudeLoggedIn: true,
  codexAvailable: true,
  codexLoggedIn: true,
};

function render(staleTools: SetupProviderTool[], onsignedin = vi.fn()) {
  const providerLoginStart = vi.fn(async () => ({ state: "connected" as const }));
  const providerLoginStatus = vi.fn(async () => ({ state: "connected" as const }));
  const onrefresh = vi.fn(async () => {});
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SetupConnectStep, {
    target: host,
    props: {
      api: { providerLoginStart, providerLoginStatus } as never,
      providers: PROVIDERS,
      onrefresh,
      staleTools,
      onsignedin,
      onrun: vi.fn(),
    },
  });
  return { providerLoginStart, onrefresh, onsignedin };
}

const q = (sel: string) => host.querySelector<HTMLButtonElement>(sel);

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

describe("SetupConnectStep with a stale sign-in", () => {
  it("offers a forced sign-in for a tool whose sign-in is known dead", async () => {
    const { providerLoginStart, onsignedin } = render(["claude"]);
    await settle();

    expect(host.querySelector('[data-testid="setup-connect-claude"]')?.textContent).toContain("Sign-in expired");
    expect(q('[data-testid="setup-connect-claude-run"]')).toBeNull();
    // The healthy tool keeps its run button and a quiet way back to a sign-in.
    expect(q('[data-testid="setup-connect-codex-run"]')).not.toBeNull();
    expect(q('[data-testid="setup-connect-codex-reauth-quiet"]')?.textContent).toContain("Sign in again");

    q('[data-testid="setup-connect-claude-reauth"]')!.click();
    await settle();
    expect(providerLoginStart).toHaveBeenCalledWith("claude", { force: true });
    await settle();
    expect(onsignedin).toHaveBeenCalledWith("claude");
    // Signed in again here: the row goes back to offering the run.
    expect(q('[data-testid="setup-connect-claude-run"]')).not.toBeNull();
  });

  it("a plain connect never forces, so a good account is not replaced", async () => {
    const { providerLoginStart } = render([]);
    await settle();
    expect(q('[data-testid="setup-connect-claude-reauth"]')).toBeNull();

    q('[data-testid="setup-connect-claude-reauth-quiet"]')!.click();
    await settle();
    expect(providerLoginStart).toHaveBeenCalledWith("claude", { force: true });
  });
});
