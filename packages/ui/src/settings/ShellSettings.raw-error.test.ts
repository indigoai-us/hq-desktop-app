// @vitest-environment happy-dom

/**
 * AUDIT-3: a failed profile read or save never puts the service's own text on
 * screen. Settings shows plain copy with a way to try again; the raw text is
 * logged.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount, flushSync, tick } from "svelte";

import type { PlatformAdapter } from "@hq/platform";
import ShellSettings from "./ShellSettings.svelte";

const RAW = '[invoke] profile HTTP 500 Internal Server Error: {"message":"boom"}';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

const profile = {
  initial: "A",
  fullName: "Ada Lovelace",
  displayName: "",
  email: "ada@example.com",
  verified: true,
};

async function settle(): Promise<void> {
  await tick();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

function mountWith(identity: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ShellSettings, {
    target: host,
    props: {
      profile,
      adapter: { isAvailable: () => false, identity } as unknown as PlatformAdapter,
    },
  });
}

describe("Settings profile raw error text", () => {
  it("a failed profile read shows plain copy and a retry, not the service text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mountWith({ getProfile: async () => ({ ok: false, reason: "error", message: RAW }) });
    await settle();

    const alert = host.querySelector('[data-testid="settings-profile-error"]');
    expect(alert?.textContent).toContain("Couldn’t load all profile fields. Try again.");
    expect(host.textContent).not.toContain("HTTP 500");
    expect(host.querySelector('[data-testid="settings-profile-retry"]')).not.toBeNull();
    expect(warn).toHaveBeenCalledWith("[settings] profile read failed", RAW);
  });

  it("a failed profile save shows plain copy, not the service text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mountWith({
      getProfile: async () => ({ ok: true, value: { profile: {} } }),
      updateProfile: async () => ({ ok: false, reason: "error", message: RAW }),
    });
    await settle();
    const nameInput = host.querySelector(
      '[data-testid="settings-display-name-input"]',
    ) as HTMLInputElement;
    nameInput.value = "Ada L";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    host.querySelector<HTMLButtonElement>('[data-testid="settings-profile-save"]')!.click();
    await settle();

    const alert = host.querySelector('[data-testid="settings-profile-error"]');
    expect(alert?.textContent).toContain("Couldn't save your profile. Try again.");
    expect(host.textContent).not.toContain("HTTP 500");
    expect(warn).toHaveBeenCalledWith("[settings] profile save failed", RAW);
  });
});
