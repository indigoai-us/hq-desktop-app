// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { failure, ok, unavailable, type PlatformAdapter } from "@hq/platform";

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
  options: {
    setDockVisible?: PlatformAdapter["appShell"]["setDockVisible"];
    setDesktopWidget?: PlatformAdapter["appShell"]["setDesktopWidget"];
  } = {},
) {
  const setDockVisible = vi.fn(
    options.setDockVisible ?? (async () => ok(undefined)),
  );
  const setDesktopWidget = vi.fn(
    options.setDesktopWidget ?? (async () => ok(undefined)),
  );
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

  it("reconciles a failed Dock write from the native read", async () => {
    const nativeSettings = deferred<ReturnType<typeof ok<Record<string, unknown>>>>();
    const getSettings = vi.fn(() => nativeSettings.promise);
    const { adapter, setDockVisible } = trayAdapter(getSettings, {
      setDockVisible: async () => failure("save-settings"),
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "general", adapter },
    });
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));

    host.querySelector<HTMLButtonElement>('[aria-label="Show in Dock"]')?.click();
    await vi.waitFor(() => expect(setDockVisible).toHaveBeenCalledWith(false));
    await vi.waitFor(() => {
      expect(
        host.querySelector('[aria-label="Show in Dock"]')?.getAttribute("aria-checked"),
      ).toBe("false");
    });
    expect(getSettings).toHaveBeenCalledTimes(2);
    nativeSettings.resolve(ok({ dockIcon: false }));
    await nativeSettings.promise;
    await tick();

    expect(
      host.querySelector('[aria-label="Show in Dock"]')?.getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("keeps a Dock preference when the host reports it unavailable", async () => {
    const getSettings = vi.fn(async () => ok({ dockIcon: true }));
    const dockWrite = deferred<ReturnType<typeof unavailable>>();
    const { adapter, setDockVisible } = trayAdapter(getSettings, {
      setDockVisible: () => dockWrite.promise,
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "general", adapter },
    });
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));

    host.querySelector<HTMLButtonElement>('[aria-label="Show in Dock"]')?.click();
    await vi.waitFor(() => expect(setDockVisible).toHaveBeenCalledWith(false));
    dockWrite.resolve(unavailable("desktop-only"));
    await dockWrite.promise;
    await tick();

    expect(
      host.querySelector('[aria-label="Show in Dock"]')?.getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("does not clobber a newer Dock toggle when an earlier write fails", async () => {
    const nativeSettings = deferred<ReturnType<typeof ok<Record<string, unknown>>>>();
    const dockWrite = deferred<ReturnType<typeof failure>>();
    const getSettings = vi.fn(() => nativeSettings.promise);
    let dockWriteCount = 0;
    const { adapter, setDockVisible } = trayAdapter(getSettings, {
      setDockVisible: () => {
        dockWriteCount += 1;
        return dockWriteCount === 1 ? dockWrite.promise : Promise.resolve(ok(undefined));
      },
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "general", adapter },
    });
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));

    const dock = host.querySelector<HTMLButtonElement>('[aria-label="Show in Dock"]');
    dock?.click();
    dock?.click();
    dockWrite.resolve(failure("save-settings"));
    await dockWrite.promise;
    nativeSettings.resolve(ok({ dockIcon: false }));
    await nativeSettings.promise;
    await tick();

    expect(setDockVisible).toHaveBeenNthCalledWith(1, false);
    expect(setDockVisible).toHaveBeenNthCalledWith(2, true);
    expect(dock?.getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the third Dock toggle and its dirty state when the first write fails", async () => {
    const nativeSettings = deferred<ReturnType<typeof ok<Record<string, unknown>>>>();
    const dockWrite = deferred<ReturnType<typeof failure>>();
    const getSettings = vi.fn(() => nativeSettings.promise);
    let dockWriteCount = 0;
    const { adapter, setDockVisible } = trayAdapter(getSettings, {
      setDockVisible: () => {
        dockWriteCount += 1;
        return dockWriteCount === 1 ? dockWrite.promise : Promise.resolve(ok(undefined));
      },
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "general", adapter },
    });
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));

    const dock = host.querySelector<HTMLButtonElement>('[aria-label="Show in Dock"]');
    dock?.click();
    dock?.click();
    dock?.click();
    await vi.waitFor(() => expect(setDockVisible).toHaveBeenCalledTimes(3));
    dockWrite.resolve(failure("save-settings"));
    await dockWrite.promise;
    await tick();

    expect(dock?.getAttribute("aria-checked")).toBe("false");
    nativeSettings.resolve(ok({ dockIcon: true }));
    await nativeSettings.promise;
    await tick();
    expect(dock?.getAttribute("aria-checked")).toBe("false");
  });

  it("reverts a failed desktop widget write", async () => {
    const getSettings = vi.fn(async () => ok({ widgetEnabled: true }));
    const { adapter, setDesktopWidget } = trayAdapter(getSettings, {
      setDesktopWidget: async () => failure("save-settings"),
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "general", adapter },
    });
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => {
      expect(
        host.querySelector('[aria-label="Desktop widget"]')?.getAttribute("aria-checked"),
      ).toBe("true");
    });

    host.querySelector<HTMLButtonElement>('[aria-label="Desktop widget"]')?.click();
    await vi.waitFor(() => expect(setDesktopWidget).toHaveBeenCalledWith(false));

    await vi.waitFor(() => {
      expect(
        host.querySelector('[aria-label="Desktop widget"]')?.getAttribute("aria-checked"),
      ).toBe("true");
    });
  });

  it("keeps the third desktop widget toggle and its dirty state when the first write fails", async () => {
    const nativeSettings = deferred<ReturnType<typeof ok<Record<string, unknown>>>>();
    const widgetWrite = deferred<ReturnType<typeof failure>>();
    const getSettings = vi.fn(() => nativeSettings.promise);
    let widgetWriteCount = 0;
    const { adapter, setDesktopWidget } = trayAdapter(getSettings, {
      setDesktopWidget: () => {
        widgetWriteCount += 1;
        return widgetWriteCount === 1
          ? widgetWrite.promise
          : Promise.resolve(ok(undefined));
      },
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "general", adapter },
    });
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));

    const widget = host.querySelector<HTMLButtonElement>(
      '[aria-label="Desktop widget"]',
    );
    widget?.click();
    widget?.click();
    widget?.click();
    await vi.waitFor(() => expect(setDesktopWidget).toHaveBeenCalledTimes(3));
    widgetWrite.resolve(failure("save-settings"));
    await widgetWrite.promise;
    await tick();

    expect(widget?.getAttribute("aria-checked")).toBe("false");
    nativeSettings.resolve(ok({ widgetEnabled: true }));
    await nativeSettings.promise;
    await tick();
    expect(widget?.getAttribute("aria-checked")).toBe("false");
  });

  it("reconciles failed Dock and desktop widget writes independently", async () => {
    const getSettings = vi.fn(async () =>
      ok({ dockIcon: true, widgetEnabled: true }),
    );
    const dockWrite = deferred<ReturnType<typeof failure>>();
    const widgetWrite = deferred<ReturnType<typeof failure>>();
    const { adapter, setDockVisible, setDesktopWidget } = trayAdapter(
      getSettings,
      {
        setDockVisible: () => dockWrite.promise,
        setDesktopWidget: () => widgetWrite.promise,
      },
    );
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "general", adapter },
    });
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));

    const dock = host.querySelector<HTMLButtonElement>('[aria-label="Show in Dock"]');
    const widget = host.querySelector<HTMLButtonElement>(
      '[aria-label="Desktop widget"]',
    );
    dock?.click();
    widget?.click();
    await vi.waitFor(() => {
      expect(setDockVisible).toHaveBeenCalledWith(false);
      expect(setDesktopWidget).toHaveBeenCalledWith(false);
    });
    dockWrite.resolve(failure("save-settings"));
    widgetWrite.resolve(failure("save-settings"));
    await Promise.all([dockWrite.promise, widgetWrite.promise]);
    await tick();

    await vi.waitFor(() => {
      expect(dock?.getAttribute("aria-checked")).toBe("true");
      expect(widget?.getAttribute("aria-checked")).toBe("true");
    });
  });

  it("reconciles the reported failed Dock sequence from persisted settings", async () => {
    let persistedDock = true;
    let dockWriteCount = 0;
    const getSettings = vi.fn(async () => ok({ dockIcon: persistedDock }));
    const { adapter, setDockVisible } = trayAdapter(getSettings, {
      setDockVisible: async (visible) => {
        dockWriteCount += 1;
        if (dockWriteCount === 1) {
          persistedDock = visible;
          return ok(undefined);
        }
        return failure("save-settings");
      },
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "general", adapter },
    });
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));

    const dock = host.querySelector<HTMLButtonElement>('[aria-label="Show in Dock"]');
    dock?.click();
    dock?.click();
    dock?.click();
    await vi.waitFor(() => expect(setDockVisible).toHaveBeenCalledTimes(3));

    await vi.waitFor(() => {
      expect(dock?.getAttribute("aria-checked")).toBe("false");
    });
    expect(persistedDock).toBe(false);
    expect(getSettings).toHaveBeenCalledTimes(2);
  });

  it("reconciles the reported failed desktop widget sequence from persisted settings", async () => {
    let persistedWidget = true;
    let widgetWriteCount = 0;
    const getSettings = vi.fn(async () => ok({ widgetEnabled: persistedWidget }));
    const { adapter, setDesktopWidget } = trayAdapter(getSettings, {
      setDesktopWidget: async (enabled) => {
        widgetWriteCount += 1;
        if (widgetWriteCount === 1) {
          persistedWidget = enabled;
          return ok(undefined);
        }
        return failure("save-settings");
      },
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "general", adapter },
    });
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));

    const widget = host.querySelector<HTMLButtonElement>(
      '[aria-label="Desktop widget"]',
    );
    widget?.click();
    widget?.click();
    widget?.click();
    await vi.waitFor(() => expect(setDesktopWidget).toHaveBeenCalledTimes(3));

    await vi.waitFor(() => {
      expect(widget?.getAttribute("aria-checked")).toBe("false");
    });
    expect(persistedWidget).toBe(false);
    expect(getSettings).toHaveBeenCalledTimes(2);
  });

  it("clears a failed Dock write's dirty state when its authoritative read fails", async () => {
    const initialRead = deferred<ReturnType<typeof ok<Record<string, unknown>>>>();
    let reads = 0;
    const getSettings = vi.fn(() => {
      reads += 1;
      return reads === 1 ? initialRead.promise : Promise.resolve(failure("read-settings"));
    });
    const { adapter, setDockVisible } = trayAdapter(getSettings, {
      setDockVisible: async () => failure("save-settings"),
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "general", adapter },
    });
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));

    const dock = host.querySelector<HTMLButtonElement>('[aria-label="Show in Dock"]');
    dock?.click();
    await vi.waitFor(() => expect(setDockVisible).toHaveBeenCalledWith(false));
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));

    initialRead.resolve(ok({ dockIcon: true }));
    await initialRead.promise;
    await tick();

    expect(dock?.getAttribute("aria-checked")).toBe("true");
  });

  it("does not clobber a newer Dock click while reconciliation rereads settings", async () => {
    const initialRead = deferred<ReturnType<typeof ok<Record<string, unknown>>>>();
    const reconciliationRead = deferred<
      ReturnType<typeof ok<Record<string, unknown>>>
    >();
    let reads = 0;
    const getSettings = vi.fn(() => {
      reads += 1;
      return reads === 1 ? initialRead.promise : reconciliationRead.promise;
    });
    let dockWriteCount = 0;
    const { adapter, setDockVisible } = trayAdapter(getSettings, {
      setDockVisible: async () => {
        dockWriteCount += 1;
        return dockWriteCount === 1 ? failure("save-settings") : ok(undefined);
      },
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "general", adapter },
    });
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));

    const dock = host.querySelector<HTMLButtonElement>('[aria-label="Show in Dock"]');
    dock?.click();
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
    dock?.click();
    await vi.waitFor(() => expect(setDockVisible).toHaveBeenCalledTimes(2));

    reconciliationRead.resolve(ok({ dockIcon: false }));
    await reconciliationRead.promise;
    initialRead.resolve(ok({ dockIcon: false }));
    await initialRead.promise;
    await tick();

    expect(dock?.getAttribute("aria-checked")).toBe("true");
  });
});
