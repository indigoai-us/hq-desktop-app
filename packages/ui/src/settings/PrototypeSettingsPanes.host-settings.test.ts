// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { failure, ok, unavailable, type PlatformAdapter } from "@hq/platform";

import PrototypeSettingsPanes from "./PrototypeSettingsPanes.svelte";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

// happy-dom ships no localStorage here; see the helper for why.
const memoryStorage = installMemoryLocalStorage();

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
  } = {},
) {
  const setDockVisible = vi.fn(
    options.setDockVisible ?? (async () => ok(undefined)),
  );
  const adapter = {
    kind: "desktop",
    isAvailable: (capability: string) => capability === "trayAndWindow",
    appShell: {
      notificationPermissionState: vi.fn(async () => ok("granted")),
      setDockVisible,
    },
    meetings: {
      listAccounts: vi.fn(async () => ok([])),
    },
    settings: { getSettings },
  } as unknown as PlatformAdapter;
  return { adapter, setDockVisible };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
  vi.clearAllMocks();
});

describe("PrototypeSettingsPanes host-backed toggles", () => {
  it("hydrates the Dock toggle from native settings without driving host setters", async () => {
    const getSettings = vi.fn(async () => ok({ dockIcon: false }));
    const { adapter, setDockVisible } = trayAdapter(getSettings);
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
    });

    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(setDockVisible).not.toHaveBeenCalled();
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
    nativeSettings.resolve(ok({ dockIcon: "false" }));
    await tick();

    expect(
      host.querySelector('[aria-label="Show in Dock"]')?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("keeps a user toggle when the native settings read resolves later", async () => {
    const nativeSettings = deferred<ReturnType<typeof ok<Record<string, unknown>>>>();
    const getSettings = vi.fn(() => nativeSettings.promise);
    const { adapter, setDockVisible } = trayAdapter(getSettings);
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "general", adapter },
    });
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));

    host.querySelector<HTMLButtonElement>('[aria-label="Show in Dock"]')?.click();
    await tick();
    nativeSettings.resolve(ok({ dockIcon: true }));
    await nativeSettings.promise;
    await tick();

    expect(
      host.querySelector('[aria-label="Show in Dock"]')?.getAttribute("aria-checked"),
    ).toBe("false");
    expect(setDockVisible).toHaveBeenCalledWith(false);
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
    nativeSettings.resolve(ok({ dockIcon: true }));
    await nativeSettings.promise;
    await tick();

    expect(
      host.querySelector('[aria-label="Show in Dock"]')?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("restores the hydrated Dock value when a failed write cannot reconcile", async () => {
    let reads = 0;
    const getSettings = vi.fn(async () => {
      reads += 1;
      return reads === 1 ? ok({ dockIcon: true }) : failure("read-settings");
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

    const dock = host.querySelector<HTMLButtonElement>(
      '[aria-label="Show in Dock"]',
    );
    expect(dock?.getAttribute("aria-checked")).toBe("true");
    dock?.click();
    await vi.waitFor(() => expect(setDockVisible).toHaveBeenCalledWith(false));
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));

    expect(dock?.getAttribute("aria-checked")).toBe("true");
  });

  it("uses the latest successful Dock write when a later failed write cannot reconcile", async () => {
    let reads = 0;
    const getSettings = vi.fn(async () => {
      reads += 1;
      return reads === 1 ? ok({ dockIcon: true }) : failure("read-settings");
    });
    const firstWrite = deferred<ReturnType<typeof ok<void>>>();
    let writes = 0;
    const { adapter, setDockVisible } = trayAdapter(getSettings, {
      setDockVisible: async () => {
        writes += 1;
        return writes === 1
          ? firstWrite.promise
          : failure("save-settings");
      },
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "general", adapter },
    });
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));

    const dock = host.querySelector<HTMLButtonElement>(
      '[aria-label="Show in Dock"]',
    );
    dock?.click();
    await vi.waitFor(() => expect(setDockVisible).toHaveBeenCalledTimes(1));
    expect(dock?.getAttribute("aria-checked")).toBe("false");
    firstWrite.resolve(ok(undefined));
    await firstWrite.promise;
    await tick();
    dock?.click();
    await vi.waitFor(() => expect(setDockVisible).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));

    expect(dock?.getAttribute("aria-checked")).toBe("false");
  });

  it("keeps the optimistic Dock value when the host has never reported one", async () => {
    let reads = 0;
    const getSettings = vi.fn(async () => {
      reads += 1;
      return reads === 1 ? ok({}) : failure("read-settings");
    });
    const { adapter, setDockVisible } = trayAdapter(getSettings, {
      setDockVisible: async () => failure("save-settings"),
    });
    localStorage.setItem("hq-work-settings-prefs", JSON.stringify({ showInDock: false }));
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "general", adapter },
    });
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));

    const dock = host.querySelector<HTMLButtonElement>(
      '[aria-label="Show in Dock"]',
    );
    expect(dock?.getAttribute("aria-checked")).toBe("false");
    dock?.click();
    await vi.waitFor(() => expect(setDockVisible).toHaveBeenCalledWith(true));
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));

    expect(dock?.getAttribute("aria-checked")).toBe("true");
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
    await vi.waitFor(() => expect(setDockVisible).toHaveBeenCalledTimes(2));
    expect(persistedDock).toBe(false);
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
    await tick();
    expect(dock?.getAttribute("aria-checked")).toBe("false");
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

  it("restores the hydrated Dock value when a failed write's successful read omits it", async () => {
    let reads = 0;
    const getSettings = vi.fn(async () => {
      reads += 1;
      return reads === 1 ? ok({ dockIcon: true }) : ok({});
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

    const dock = host.querySelector<HTMLButtonElement>(
      '[aria-label="Show in Dock"]',
    );
    expect(dock?.getAttribute("aria-checked")).toBe("true");
    dock?.click();
    await vi.waitFor(() => expect(setDockVisible).toHaveBeenCalledWith(false));
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));

    expect(dock?.getAttribute("aria-checked")).toBe("true");
  });

  it("records the hydrated Dock authority when a click races the read", async () => {
    const initialRead = deferred<ReturnType<typeof ok<Record<string, unknown>>>>();
    let reads = 0;
    const getSettings = vi.fn(() => {
      reads += 1;
      return reads === 1
        ? initialRead.promise
        : Promise.resolve(failure("read-settings"));
    });
    let writes = 0;
    const { adapter, setDockVisible } = trayAdapter(getSettings, {
      setDockVisible: async () => {
        writes += 1;
        return writes === 1
          ? unavailable("desktop-only")
          : failure("save-settings");
      },
    });
    localStorage.setItem("hq-work-settings-prefs", JSON.stringify({ showInDock: true }));
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "general", adapter },
    });
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));

    const dock = host.querySelector<HTMLButtonElement>(
      '[aria-label="Show in Dock"]',
    );
    expect(dock?.getAttribute("aria-checked")).toBe("true");
    dock?.click();
    await vi.waitFor(() => expect(setDockVisible).toHaveBeenCalledWith(false));
    initialRead.resolve(ok({ dockIcon: false }));
    await initialRead.promise;
    await tick();
    expect(dock?.getAttribute("aria-checked")).toBe("false");
    dock?.click();
    await vi.waitFor(() => expect(setDockVisible).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));

    expect(dock?.getAttribute("aria-checked")).toBe("false");
  });
});

describe("PrototypeSettingsPanes window opacity", () => {
  const rootEl = () => document.documentElement;

  // Earlier tests in this file mount without a host marker, which writes the
  // fallback vars onto the real <html>; reset both sides around every case.
  const resetRoot = () => {
    delete rootEl().dataset.windowTransparency;
    rootEl().style.removeProperty("--hq-window-transparency-factor");
  };
  beforeEach(resetRoot);
  afterEach(resetRoot);

  function mountAppearance() {
    const { adapter } = trayAdapter(vi.fn(async () => ok({})));
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "appearance", adapter },
    });
    return host.querySelector<HTMLInputElement>('[aria-label="Window opacity"]')!;
  }

  it("seeds from the host marker and does not clobber the host on mount", async () => {
    memoryStorage.setItem(
      "hq-work-settings-prefs",
      JSON.stringify({ windowOpacity: 90 }),
    );
    rootEl().dataset.windowTransparency = "40";
    const requests: unknown[] = [];
    const onRequest = (event: Event) =>
      requests.push((event as CustomEvent).detail);
    window.addEventListener("hq:appearance-request", onRequest);
    try {
      const slider = mountAppearance();
      await tick();
      expect(slider.value).toBe("60");
      expect(requests).toEqual([]);
      expect(
        rootEl().style.getPropertyValue("--hq-window-transparency-factor"),
      ).toBe("");
    } finally {
      window.removeEventListener("hq:appearance-request", onRequest);
    }
  });

  it("dispatches the inverse transparency to the host when the slider moves", async () => {
    rootEl().dataset.windowTransparency = "35";
    // The host applies the request detail RAW — a partial payload would make
    // its normalizeColorTheme(undefined) === "system" delete data-force-theme
    // and drop the user's forced Light. So the detail must be complete.
    rootEl().dataset.forceTheme = "light";
    const requests: unknown[] = [];
    const onRequest = (event: Event) =>
      requests.push((event as CustomEvent).detail);
    window.addEventListener("hq:appearance-request", onRequest);
    try {
      const slider = mountAppearance();
      await tick();
      slider.value = "80";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      await tick();
      expect(requests).toEqual([
        { colorTheme: "light", windowTransparency: 20 },
      ]);
      expect(host.querySelector(".range-val")?.textContent).toBe("80%");
    } finally {
      window.removeEventListener("hq:appearance-request", onRequest);
      delete rootEl().dataset.forceTheme;
    }
  });

  it("follows hq:appearance-change from the host", async () => {
    rootEl().dataset.windowTransparency = "35";
    const slider = mountAppearance();
    await tick();
    expect(slider.value).toBe("65");
    rootEl().dataset.windowTransparency = "10";
    window.dispatchEvent(
      new CustomEvent("hq:appearance-change", {
        detail: { colorTheme: "system", windowTransparency: 10 },
      }),
    );
    await tick();
    expect(slider.value).toBe("90");
  });

  it("applies the local pref itself when no host is installed", async () => {
    memoryStorage.setItem(
      "hq-work-settings-prefs",
      JSON.stringify({ windowOpacity: 70 }),
    );
    const slider = mountAppearance();
    await tick();
    expect(slider.value).toBe("70");
    expect(
      rootEl().style.getPropertyValue("--hq-window-transparency-factor"),
    ).toBe("0.30");
  });
});
