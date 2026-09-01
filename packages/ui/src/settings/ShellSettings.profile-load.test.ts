// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount, flushSync, tick } from "svelte";

import type { PlatformAdapter } from "@hq/platform";
import ShellSettings from "./ShellSettings.svelte";
import { PROFILE_SKELETON_DELAY_MS } from "./shell-settings-model.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function adapterWithGetProfile(
  getProfile: () => Promise<unknown>,
): PlatformAdapter {
  return {
    isAvailable: () => false,
    identity: { getProfile },
  } as unknown as PlatformAdapter;
}

function mountSettings(getProfile: () => Promise<unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ShellSettings, {
    target: host,
    props: {
      profile: null,
      adapter: adapterWithGetProfile(getProfile),
    },
  });
}

describe("ShellSettings profile pane load states", () => {
  it("does not show EmptyState while getProfile is pending, then shows the skeleton after the delay", async () => {
    vi.useFakeTimers();
    const pending = deferred<unknown>();
    mountSettings(() => pending.promise);
    await tick();
    flushSync();

    expect(
      host.querySelector('[data-testid="settings-profile-empty"]'),
    ).toBeNull();
    expect(
      host.querySelector('[data-testid="settings-profile-skeleton"]'),
    ).toBeNull();

    await vi.advanceTimersByTimeAsync(PROFILE_SKELETON_DELAY_MS);
    flushSync();

    expect(
      host.querySelector('[data-testid="settings-profile-empty"]'),
    ).toBeNull();
    expect(
      host.querySelector('[data-testid="settings-profile-skeleton"]'),
    ).not.toBeNull();
  });

  it("shows a retry state on getProfile failure, then renders the pane after a successful retry", async () => {
    const getProfile = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        reason: "error",
        message: "network",
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { profile: { displayName: "Ada Lovelace" } },
      });
    mountSettings(getProfile);
    await tick();
    await Promise.resolve();
    flushSync();

    expect(
      host.querySelector('[data-testid="settings-profile-retry-state"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('[data-testid="settings-profile-empty"]'),
    ).toBeNull();
    expect(host.textContent).toContain("Couldn't load your profile.");

    host.querySelector<HTMLButtonElement>(
      '[data-testid="settings-profile-retry"]',
    )!.click();
    await tick();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();

    expect(getProfile).toHaveBeenCalledTimes(2);
    expect(
      host.querySelector('[data-testid="settings-profile-pane"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('[data-testid="settings-profile-retry-state"]'),
    ).toBeNull();
  });

  it("renders the full profile pane from a fetched displayName when the profile prop is null", async () => {
    mountSettings(async () => ({
      ok: true,
      value: { profile: { displayName: "Ada Lovelace" } },
    }));
    await tick();
    await Promise.resolve();
    flushSync();

    expect(
      host.querySelector('[data-testid="settings-profile-pane"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('[data-testid="settings-profile-empty"]'),
    ).toBeNull();
    expect(host.textContent).toContain("Ada Lovelace");
  });

  it("renders EmptyState only when getProfile succeeds with no displayName or entityName", async () => {
    mountSettings(async () => ({
      ok: true,
      value: { profile: null },
    }));
    await tick();
    await Promise.resolve();
    flushSync();

    expect(
      host.querySelector('[data-testid="settings-profile-empty"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('[data-testid="settings-profile-pane"]'),
    ).toBeNull();
    expect(
      host.querySelector('[data-testid="settings-profile-retry-state"]'),
    ).toBeNull();
  });
});
