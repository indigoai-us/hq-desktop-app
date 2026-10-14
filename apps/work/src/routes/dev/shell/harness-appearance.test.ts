// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPEARANCE_CHANGE_EVENT,
  APPEARANCE_REQUEST_EVENT,
} from "@hq/ui/settings/appearance-seam";
import {
  HARNESS_DEFAULT_TRANSPARENCY,
  HARNESS_TRANSPARENCY_STORAGE_KEY,
  initialHarnessTransparency,
  installHarnessAppearance,
  opacityFromTransparency,
  transparencyFromOpacity,
} from "./harness-appearance";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("harness appearance host", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    disposers.splice(0).forEach((dispose) => dispose());
    const root = document.documentElement;
    delete root.dataset.windowTransparency;
    delete root.dataset.forceTheme;
    delete root.dataset.material;
    root.removeAttribute("style");
  });

  it("marks <html> as host-owned so the surface tokens leave their opaque fallback", () => {
    // home/tokens.css pins every surface opaque while data-window-transparency
    // is absent; translucency can only be judged once a host claims the root.
    const root = document.documentElement;
    const host = installHarnessAppearance({
      root,
      target: window,
      storage: memoryStorage(),
      initial: { colorTheme: "dark", windowTransparency: HARNESS_DEFAULT_TRANSPARENCY },
    });
    disposers.push(host.dispose);

    expect(root.dataset.windowTransparency).toBe("65");
    expect(root.dataset.forceTheme).toBe("dark");
    expect(root.style.getPropertyValue("--hq-window-transparency-factor")).toBe("0.65");
    expect(root.style.getPropertyValue("--hq-window-alpha-light")).toBe("0.35");
    expect(root.style.getPropertyValue("--hq-window-alpha-dark")).toBe("0.48");
  });

  it("answers the shell's appearance requests and announces the change", () => {
    // Settings → Window opacity dispatches APPEARANCE_REQUEST_EVENT and keeps
    // its slider in step by listening for APPEARANCE_CHANGE_EVENT.
    const root = document.documentElement;
    const storage = memoryStorage();
    const applyTheme = vi.fn();
    const onchange = vi.fn();
    const host = installHarnessAppearance({
      root,
      target: window,
      storage,
      applyTheme,
      onchange,
      initial: { colorTheme: "dark", windowTransparency: 65 },
    });
    disposers.push(host.dispose);
    const changes: unknown[] = [];
    const listener = (event: Event) => changes.push((event as CustomEvent).detail);
    window.addEventListener(APPEARANCE_CHANGE_EVENT, listener);
    disposers.push(() => window.removeEventListener(APPEARANCE_CHANGE_EVENT, listener));

    window.dispatchEvent(
      new CustomEvent(APPEARANCE_REQUEST_EVENT, {
        detail: { colorTheme: "light", windowTransparency: 0 },
      }),
    );

    expect(root.dataset.windowTransparency).toBe("0");
    expect(root.dataset.forceTheme).toBe("light");
    expect(applyTheme).toHaveBeenLastCalledWith("light");
    expect(onchange).toHaveBeenLastCalledWith({ colorTheme: "light", windowTransparency: 0 });
    expect(changes).toEqual([{ colorTheme: "light", windowTransparency: 0 }]);
    expect(storage.getItem(HARNESS_TRANSPARENCY_STORAGE_KEY)).toBe("0");
  });

  it("keeps the other half of the preference when a request names only one", () => {
    const root = document.documentElement;
    const host = installHarnessAppearance({
      root,
      target: window,
      storage: memoryStorage(),
      initial: { colorTheme: "dark", windowTransparency: 40 },
    });
    disposers.push(host.dispose);

    host.request({ colorTheme: "system" });
    expect(host.current()).toEqual({ colorTheme: "system", windowTransparency: 40 });
    expect(root.dataset.forceTheme).toBeUndefined();
  });

  it("stops answering once disposed", () => {
    const root = document.documentElement;
    const host = installHarnessAppearance({
      root,
      target: window,
      storage: memoryStorage(),
      initial: { colorTheme: "dark", windowTransparency: 65 },
    });
    host.dispose();

    window.dispatchEvent(
      new CustomEvent(APPEARANCE_REQUEST_EVENT, {
        detail: { colorTheme: "dark", windowTransparency: 10 },
      }),
    );
    expect(root.dataset.windowTransparency).toBe("65");
  });
});

describe("initial harness transparency", () => {
  it("opens on the PR #772 reference material by default", () => {
    expect(initialHarnessTransparency("", memoryStorage())).toBe(65);
    expect(opacityFromTransparency(HARNESS_DEFAULT_TRANSPARENCY)).toBe(35);
  });

  it("takes ?opacity= over the remembered value, clamped to the Settings slider", () => {
    const storage = memoryStorage({ [HARNESS_TRANSPARENCY_STORAGE_KEY]: "20" });
    expect(initialHarnessTransparency("?opacity=100", storage)).toBe(0);
    expect(initialHarnessTransparency("?opacity=80", storage)).toBe(20);
    expect(initialHarnessTransparency("?opacity=5", storage)).toBe(65);
    expect(initialHarnessTransparency("", storage)).toBe(20);
  });

  it("ignores junk in the URL and in storage", () => {
    expect(initialHarnessTransparency("?opacity=lots", memoryStorage())).toBe(65);
    expect(
      initialHarnessTransparency(
        "",
        memoryStorage({ [HARNESS_TRANSPARENCY_STORAGE_KEY]: "nope" }),
      ),
    ).toBe(65);
  });

  it("round-trips opacity and transparency", () => {
    expect(transparencyFromOpacity(35)).toBe(65);
    expect(transparencyFromOpacity(100)).toBe(0);
    expect(opacityFromTransparency(transparencyFromOpacity(72))).toBe(72);
  });
});
