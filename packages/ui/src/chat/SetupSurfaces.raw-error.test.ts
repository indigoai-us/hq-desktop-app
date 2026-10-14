// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import SetupChannelIntro from "./SetupChannelIntro.svelte";
import SetupConnectStep from "./SetupConnectStep.svelte";
import { NO_AI_TOOLS } from "../settings/setup-launch";
import type { SetupProviderStatus } from "./setup-run.js";

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function assertNoRaw(): void {
  expect(host.textContent).not.toContain("boom");
  expect(host.textContent).not.toContain("HTTP 500");
  for (const el of host.querySelectorAll("[title]")) {
    expect(el.getAttribute("title")).not.toContain("boom");
  }
}

describe("SetupChannelIntro create another company", () => {
  it("shows plain copy when the host callback throws, and logs the raw error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = new Error(RAW);
    const ok = <T,>(value: T) => ({ ok: true as const, value });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(SetupChannelIntro, {
      target: host,
      props: {
        settings: { getSetupStatus: async () => ok({ hqFolderPath: "/tmp/HQ" }) },
        shell: {
          detectAiTools: vi.fn(async () => ok({ ...NO_AI_TOOLS })),
          openClaudeCodeLink: vi.fn(async () => ok(undefined)),
          launchClaudeCode: vi.fn(async () => ok(undefined)),
          launchCodexWorkspace: vi.fn(async () => ok(undefined)),
          launchCliInTerminal: vi.fn(async () => ok(undefined)),
        },
        onopenurl: vi.fn(),
        companies: [{ kind: "company", slug: "acme", displayName: "Acme", cloudUid: "cmp_acme" }],
        oncreatecompany: vi.fn(async () => {
          throw raw;
        }),
      } as never,
    });
    await settle();
    host.querySelector<HTMLButtonElement>('[data-testid="setup-create-another-company"]')!.click();
    await settle();
    expect(
      host.querySelector('[data-testid="setup-create-another-company-error"]')?.textContent,
    ).toContain("Could not start a new company. Try again.");
    assertNoRaw();
    expect(warn).toHaveBeenCalledWith("[setup-intro] create company failed", raw);
  });
});

describe("SetupConnectStep sign-in error", () => {
  it("shows plain copy instead of the host's raw error text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const providers: SetupProviderStatus = {
      hqReady: true,
      claudeAvailable: true,
      claudeLoggedIn: false,
      codexAvailable: true,
      codexLoggedIn: false,
    };
    const providerLoginStart = vi.fn(async () => ({ state: "error" as const, message: RAW }));
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(SetupConnectStep, {
      target: host,
      props: {
        api: { providerLoginStart, providerLoginStatus: vi.fn() } as never,
        providers,
        onrefresh: vi.fn(async () => {}),
        onrun: vi.fn(),
      },
    });
    await settle();
    const connect = host.querySelector<HTMLButtonElement>('[data-testid="setup-connect-claude"] button');
    expect(connect).not.toBeNull();
    connect!.click();
    await settle();
    expect(providerLoginStart).toHaveBeenCalled();
    expect(host.textContent).toContain("Could not connect the coding tool. Please try again.");
    assertNoRaw();
    expect(warn).toHaveBeenCalledWith("[setup-connect] sign-in failed", RAW);
  });
});
