// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import {
  APPEARANCE_CHANGE_EVENT,
  APPEARANCE_REQUEST_EVENT,
  type AppearancePreferences,
} from "./appearance-seam.js";
import { createShellAppearanceSeam } from "./settings-theme-seam.js";
import { APPEARANCE_STORAGE_KEY } from "./appearance-seam.js";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const map = new Map<string, string>();
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
  it("round-trips a requested transparency instead of snapping back to the default", () => {
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
    // Persisted for the next launch, in the one Appearance record.
    expect(JSON.parse(storage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}")).toMatchObject({
      windowTransparency: 20,
      windowTransparencySet: true,
    });
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
