// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import {
  APPEARANCE_CHANGE_EVENT,
  APPEARANCE_REQUEST_EVENT,
  type AppearancePreferences,
} from "./appearance-seam.js";
import { createShellAppearanceSeam } from "./settings-theme-seam.js";
import { SETTINGS_PREFS_KEY } from "./settings-prefs.js";

function memoryStorage(
  seed: Record<string, string> = {},
): Pick<Storage, "getItem" | "setItem"> {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

afterEach(() => {
  const root = document.documentElement;
  delete root.dataset.windowTransparency;
  root.removeAttribute("style");
});

describe("createShellAppearanceSeam window transparency", () => {
  it("defaults a fresh install to full opacity and preserves a saved value", () => {
    const root = document.documentElement;
    const fresh = createShellAppearanceSeam({
      root,
      target: new EventTarget(),
      storage: memoryStorage(),
    });
    expect(fresh.read().windowTransparency).toBe(0);

    const saved = createShellAppearanceSeam({
      root,
      target: new EventTarget(),
      storage: memoryStorage({
        [SETTINGS_PREFS_KEY]: JSON.stringify({ windowOpacity: 72 }),
      }),
    });
    expect(saved.read().windowTransparency).toBe(28);
  });

  it("round-trips a requested transparency instead of snapping back to 65", () => {
    const storage = memoryStorage();
    const target = new EventTarget();
    const seam = createShellAppearanceSeam({
      root: document.documentElement,
      target,
      storage,
    });
    const result = seam.request({ windowTransparency: 20 });
    expect(result.windowTransparency).toBe(20);
    expect(seam.read().windowTransparency).toBe(20);
    // Persisted for the next launch.
    expect(JSON.parse(storage.getItem(SETTINGS_PREFS_KEY) ?? "{}").windowOpacity).toBe(80);
    // No host installed: the surface-alpha vars are written directly.
    expect(
      document.documentElement.style.getPropertyValue("--hq-window-transparency-factor"),
    ).toBe("0.20");
  });

  it("asks the desktop host to apply the value and reads the host's value back", () => {
    const root = document.documentElement;
    root.dataset.windowTransparency = "65";
    const target = new EventTarget();
    const requests: AppearancePreferences[] = [];
    target.addEventListener(APPEARANCE_REQUEST_EVENT, (event) => {
      const detail = (event as CustomEvent<AppearancePreferences>).detail;
      requests.push(detail);
      // Emulate the host installer applying the request.
      root.dataset.windowTransparency = String(detail.windowTransparency);
      target.dispatchEvent(new CustomEvent(APPEARANCE_CHANGE_EVENT, { detail }));
    });
    const seam = createShellAppearanceSeam({ root, target, storage: memoryStorage() });
    expect(seam.read().windowTransparency).toBe(65);

    const seen: number[] = [];
    const unsubscribe = seam.subscribe?.((prefs) => seen.push(prefs.windowTransparency));
    seam.request({ windowTransparency: 10 });
    unsubscribe?.();

    expect(requests.at(-1)?.windowTransparency).toBe(10);
    expect(seam.read().windowTransparency).toBe(10);
    expect(seen).toEqual([10]);
  });
});
