// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount, flushSync, tick } from "svelte";

import type { PlatformAdapter } from "@hq/platform";
import ShellSettings from "./ShellSettings.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const profile = {
  initial: "A",
  fullName: "Ada Lovelace",
  // Common real case: session has a fullName but no explicit displayName.
  displayName: "",
  email: "ada@example.com",
  verified: true,
};

/** Minimal adapter exposing just the identity profile surface ShellSettings uses. */
function adapterWith(updateImpl: () => Promise<unknown>): PlatformAdapter {
  return {
    isAvailable: () => false,
    identity: {
      getProfile: async () => ({
        ok: true as const,
        value: { profile: null, entityName: "Ada Lovelace" },
      }),
      updateProfile: updateImpl,
    },
  } as unknown as PlatformAdapter;
}

function saveButton(): HTMLButtonElement | null {
  return host.querySelector('[data-testid="settings-profile-save"]');
}

describe("ShellSettings profile editing — dirty state", () => {
  it("is not dirty on load even when displayName is empty but fullName is set", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ShellSettings, {
      target: host,
      props: {
        profile,
        adapter: adapterWith(async () => ({
          ok: true,
          value: { profile: {} },
        })),
      },
    });
    // Let onMount's getProfile promise settle.
    await tick();
    await Promise.resolve();
    flushSync();
    expect(saveButton()?.disabled).toBe(true);
  });

  it("enables Save after a name edit, then disables + shows Saved after save", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const update = vi.fn(async () => ({
      ok: true as const,
      value: { profile: { displayName: "Ada L" } },
    }));
    component = mount(ShellSettings, {
      target: host,
      props: { profile, adapter: adapterWith(update) },
    });
    await tick();
    await Promise.resolve();
    flushSync();

    const nameInput = host.querySelector(
      '[data-testid="settings-display-name-input"]',
    ) as HTMLInputElement;
    nameInput.value = "Ada L";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(saveButton()?.disabled).toBe(false);

    saveButton()!.click();
    // Await the updateProfile promise chain.
    await tick();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Ada L" }),
    );
    expect(saveButton()?.disabled).toBe(true);
    expect(
      host.querySelector('[data-testid="settings-profile-saved"]'),
    ).not.toBeNull();
  });
});
