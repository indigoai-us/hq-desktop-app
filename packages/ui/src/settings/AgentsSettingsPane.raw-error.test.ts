// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { flushSync, mount, unmount } from "svelte";
import { failure, ok, type PlatformAdapter } from "@hq/platform";
import AgentsSettingsPane from "./AgentsSettingsPane.svelte";

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

function render(sessions: Record<string, unknown>): void {
  const adapter = { sessions } as unknown as PlatformAdapter;
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(AgentsSettingsPane, { target: host, props: { adapter } });
}

function expectNoRaw(): void {
  expect(host.textContent ?? "").not.toContain("boom");
  expect(host.textContent ?? "").not.toContain("HTTP 500");
  for (const el of host.querySelectorAll("[title]")) {
    expect(el.getAttribute("title") ?? "").not.toContain("boom");
  }
}

const preflightOk = vi.fn(async () =>
  ok({ claudeAvailable: true, claudeLoggedIn: false, codexAvailable: false, grokAvailable: false }),
);

async function clickButton(label: string): Promise<void> {
  let btn: HTMLButtonElement | undefined;
  await vi.waitFor(() => {
    flushSync();
    btn = [...host.querySelectorAll("button")].find(
      (b) => b.textContent?.includes(label) && !b.disabled,
    );
    expect(btn).toBeDefined();
  });
  btn!.click();
}

describe("AgentsSettingsPane raw errors (AUDIT-3c)", () => {
  it("preflight failure shows plain copy, logs raw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render({ preflight: vi.fn(async () => failure("http-500", RAW)) });
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="settings-agents-error"]')?.textContent).toContain(
        "Couldn't read AI tool status. Try again.",
      );
    });
    expectNoRaw();
    expect(warn).toHaveBeenCalledWith("[agents-settings] preflight failed", RAW);
  });

  it("sign-in start failure shows plain copy, logs raw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render({ preflight: preflightOk, loginStart: vi.fn(async () => failure("spawn", RAW)) });
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain("Connect");
    });
    await clickButton("Connect");
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain("Couldn't open sign-in. Try again");
    });
    expectNoRaw();
    expect(warn).toHaveBeenCalledWith("[agents-settings] sign-in start failed", RAW);
  });

  it("sign-in status failure shows plain copy, logs raw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render({
      preflight: preflightOk,
      loginStart: vi.fn(async () => ok({ state: "failed", message: RAW })),
    });
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain("Connect");
    });
    await clickButton("Connect");
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain("Sign-in did not complete. Try again.");
    });
    expectNoRaw();
    expect(warn).toHaveBeenCalledWith("[agents-settings] sign-in did not complete", RAW);
  });

  it("sign-in poll failure shows plain copy, logs raw", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render({
      preflight: preflightOk,
      loginStart: vi.fn(async () => ok({ state: "waiting" })),
      loginStatus: vi.fn(async () => failure("http-500", RAW)),
    });
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain("Connect");
    });
    await clickButton("Connect");
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain("Finish signing in");
    });
    await vi.advanceTimersByTimeAsync(1600);
    vi.useRealTimers();
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain("Couldn't check sign-in. Try again.");
    });
    expectNoRaw();
    expect(warn).toHaveBeenCalledWith("[agents-settings] sign-in status failed", RAW);
  });

  it("install failure shows plain copy, logs raw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render({
      preflight: vi.fn(async () => ok({ claudeAvailable: false, codexAvailable: false, grokAvailable: false })),
      installProvider: vi.fn(async () => failure("spawn", RAW)),
    });
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain("Install");
    });
    await clickButton("Install");
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain("Install failed. Check your network and try again.");
    });
    expectNoRaw();
    expect(warn).toHaveBeenCalledWith("[agents-settings] install failed", RAW);
  });
});
