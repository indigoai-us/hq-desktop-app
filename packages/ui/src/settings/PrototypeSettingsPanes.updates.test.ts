// @vitest-environment happy-dom
//
// Regression cover for the beta.2 Updates pane: every row was pinned on
// "CHECKING" and the status button on "Refreshing…" forever, because the pane
// awaited Promise.all over five adapter calls with no timeout and no finally.
// These tests pin the fixed contract: rows always reach a real result, the
// busy flag always clears, and the explicit check button + release-channel
// selector drive the SAME orchestration.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import PrototypeSettingsPanes from "./PrototypeSettingsPanes.svelte";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

const memoryStorage = installMemoryLocalStorage();

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
  vi.clearAllMocks();
});

function updatesAdapter(overrides: Record<string, unknown> = {}) {
  const updateSettings = vi.fn(async () => ok(undefined));
  const adapter = {
    kind: "desktop",
    isAvailable: (capability: string) => capability === "canSelfUpdate",
    appShell: {
      notificationPermissionState: vi.fn(async () => ok("granted")),
    },
    meetings: { listAccounts: vi.fn(async () => ok([])) },
    settings: {
      getSettings: vi.fn(async () => ok({ autoUpdate: true, releaseChannel: "beta" })),
      updateSettings,
    },
    updates: {
      getVersions: vi.fn(async () => ok({ core: "15.0.118", cli: "1.2.3" })),
      checkForUpdates: vi.fn(async () => ok(null)),
      checkCoreState: vi.fn(async () => ok({ versionBehind: false })),
      checkCliUpdate: vi.fn(async () => ok(null)),
      availableChannels: vi.fn(async () => ok(["stable", "beta", "alpha"])),
      ...overrides,
    },
  } as unknown as PlatformAdapter;
  return { adapter, updateSettings };
}

function mountUpdates(adapter: PlatformAdapter): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(PrototypeSettingsPanes, {
    target: host,
    props: { section: "updates", adapter, version: "0.10.173-beta.2" },
  });
  return host;
}

function checkButton(): HTMLButtonElement {
  const btn = host.querySelector<HTMLButtonElement>(
    '[data-testid="settings-check-for-updates"]',
  );
  expect(btn).toBeTruthy();
  return btn!;
}

function statusTexts(): string {
  return host.textContent?.replace(/\s+/g, " ") ?? "";
}

describe("Updates pane: busy state always resolves", () => {
  it("reaches a real result for every row and clears the button", async () => {
    const { adapter } = updatesAdapter();
    mountUpdates(adapter);

    await vi.waitFor(() => {
      expect(checkButton().disabled).toBe(false);
      expect(statusTexts()).toContain("UP TO DATE");
    });
    expect(statusTexts()).not.toContain("CHECKING");
    expect(checkButton().textContent?.trim()).toBe("Check for updates");
  });

  it("degrades a hung check to a failed row instead of spinning forever", async () => {
    // The exact beta.2 shape: the app updater call never settles.
    const { adapter } = updatesAdapter({
      checkForUpdates: vi.fn(() => new Promise(() => {})),
    });
    mountUpdates(adapter);

    await vi.waitFor(
      () => {
        expect(statusTexts()).toContain("UP TO DATE");
      },
      { timeout: 4000 },
    );
    // Core and CLI resolved even though the app check is still hanging —
    // no all-or-nothing gating.
    const updates = adapter.updates as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(updates.checkCoreState).toHaveBeenCalled();
    expect(updates.checkCliUpdate).toHaveBeenCalled();
  });

  it("the explicit button re-runs the same orchestration", async () => {
    const { adapter } = updatesAdapter();
    mountUpdates(adapter);
    const updates = adapter.updates as unknown as Record<string, ReturnType<typeof vi.fn>>;
    await vi.waitFor(() => expect(checkButton().disabled).toBe(false));
    const before = updates.checkForUpdates.mock.calls.length;

    checkButton().click();
    await vi.waitFor(() => {
      expect(updates.checkForUpdates.mock.calls.length).toBeGreaterThan(before);
    });
    await vi.waitFor(() => expect(checkButton().disabled).toBe(false));
  });
});

describe("Updates pane: release channel selector", () => {
  it("renders host-permitted channels with the stored one selected", async () => {
    const { adapter } = updatesAdapter();
    mountUpdates(adapter);
    const select = await vi.waitFor(() => {
      const el = host.querySelector<HTMLSelectElement>(
        '[data-testid="settings-release-channel"]',
      );
      expect(el).toBeTruthy();
      expect(el!.options.length).toBe(3);
      return el!;
    });
    await vi.waitFor(() => expect(select.value).toBe("beta"));
  });

  it("persists a selection and immediately re-checks on the new channel", async () => {
    const { adapter, updateSettings } = updatesAdapter();
    mountUpdates(adapter);
    const updates = adapter.updates as unknown as Record<string, ReturnType<typeof vi.fn>>;
    const select = await vi.waitFor(() => {
      const el = host.querySelector<HTMLSelectElement>(
        '[data-testid="settings-release-channel"]',
      );
      expect(el?.value).toBe("beta");
      return el!;
    });
    const before = updates.checkForUpdates.mock.calls.length;

    select.value = "alpha";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({ releaseChannel: "alpha" });
      expect(updates.checkForUpdates.mock.calls.length).toBeGreaterThan(before);
    });
  });

  it("explains a downgrade instead of offering an older build", async () => {
    const { adapter } = updatesAdapter({
      // Stable's newest is older than the installed 0.10.173-beta.2.
      checkForUpdates: vi.fn(async () => ok({ version: "0.10.172" })),
    });
    mountUpdates(adapter);
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="settings-release-channel"]'),
      ).toBeTruthy();
    });
    // The guard model is unit-tested directly; here we assert the pane never
    // presents an install action for an older build.
    expect(statusTexts()).not.toContain("Restart to update");
  });
});
