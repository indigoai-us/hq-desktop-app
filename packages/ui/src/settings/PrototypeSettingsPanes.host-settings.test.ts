// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import PrototypeSettingsPanes from "./PrototypeSettingsPanes.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function trayAdapter(
  getSettings: PlatformAdapter["settings"]["getSettings"],
) {
  const setDockVisible = vi.fn(async () => undefined);
  const setDesktopWidget = vi.fn(async () => undefined);
  const adapter = {
    kind: "desktop",
    isAvailable: (capability: string) => capability === "trayAndWindow",
    appShell: {
      notificationPermissionState: vi.fn(async () => ok("granted")),
      setDockVisible,
      setDesktopWidget,
    },
    meetings: {
      listAccounts: vi.fn(async () => ok([])),
    },
    settings: { getSettings },
  } as unknown as PlatformAdapter;
  return { adapter, setDockVisible, setDesktopWidget };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("PrototypeSettingsPanes host-backed toggles", () => {
  it("hydrates Dock and widget toggles from native settings without driving host setters", async () => {
    const getSettings = vi.fn(async () =>
      ok({ dockIcon: false, widgetEnabled: false }),
    );
    const { adapter, setDockVisible, setDesktopWidget } = trayAdapter(
      getSettings,
    );
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "general", adapter },
    });

    await vi.waitFor(() => {
      expect(
        host.querySelector('[aria-label="Show in Dock"]')?.getAttribute("aria-checked"),
      ).toBe("false");
      expect(
        host.querySelector('[aria-label="Desktop widget"]')?.getAttribute("aria-checked"),
      ).toBe("false");
    });

    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(setDockVisible).not.toHaveBeenCalled();
    expect(setDesktopWidget).not.toHaveBeenCalled();
  });

  it("leaves local toggle values alone when native settings omit booleans", async () => {
    const nativeSettings = deferred<ReturnType<typeof ok<Record<string, unknown>>>>();
    const getSettings = vi.fn(() => nativeSettings.promise);
    const { adapter } = trayAdapter(getSettings);
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "general", adapter },
    });

    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));
    nativeSettings.resolve(ok({ dockIcon: "false", widgetEnabled: null }));
    await tick();

    expect(
      host.querySelector('[aria-label="Show in Dock"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      host.querySelector('[aria-label="Desktop widget"]')?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("keeps a user toggle when the native settings read resolves later", async () => {
    const nativeSettings = deferred<ReturnType<typeof ok<Record<string, unknown>>>>();
    const getSettings = vi.fn(() => nativeSettings.promise);
    const { adapter, setDockVisible, setDesktopWidget } = trayAdapter(getSettings);
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "general", adapter },
    });
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));

    host.querySelector<HTMLButtonElement>('[aria-label="Show in Dock"]')?.click();
    host.querySelector<HTMLButtonElement>('[aria-label="Desktop widget"]')?.click();
    await tick();
    nativeSettings.resolve(ok({ dockIcon: true, widgetEnabled: true }));
    await nativeSettings.promise;
    await tick();

    expect(
      host.querySelector('[aria-label="Show in Dock"]')?.getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      host.querySelector('[aria-label="Desktop widget"]')?.getAttribute("aria-checked"),
    ).toBe("false");
    expect(setDockVisible).toHaveBeenCalledWith(false);
    expect(setDesktopWidget).toHaveBeenCalledWith(false);
  });
});
