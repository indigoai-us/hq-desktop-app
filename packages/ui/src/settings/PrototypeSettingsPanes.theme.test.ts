// @vitest-environment happy-dom

// Settings showed Theme = Dark selected while the window rendered light. The
// pill read `hq-work-color-theme` (which defaults to "dark" when unset) while
// the window followed the desktop host's preference (default System), and a
// click only flipped `data-force-theme` in this WebView without telling the
// host, so the native window theme and the next launch ignored it.

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import PrototypeSettingsPanes from "./PrototypeSettingsPanes.svelte";
import {
  APPEARANCE_CHANGE_EVENT,
  APPEARANCE_REQUEST_EVENT,
  type AppearancePreferences,
  type ColorTheme,
} from "./appearance-seam.js";
import { THEME_STORAGE_KEY } from "./shell-settings-model.js";
import { restoreStoredColorTheme } from "./settings-theme-seam.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

const memoryStorage = installMemoryLocalStorage();
const root = document.documentElement;

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;
let removeHost: (() => void) | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  removeHost?.();
  removeHost = null;
  memoryStorage.clear();
  root.removeAttribute("data-force-theme");
  root.removeAttribute("data-window-transparency");
});

/**
 * Stand-in for apps/sync `installAppearancePreferences`: applies a request to
 * `data-force-theme`, records what it would hand to the native window theme,
 * and announces the change, in that order, as the real host does.
 */
function installFakeHost(
  stored: ColorTheme = "system",
  transparency = 0,
): {
  requests: AppearancePreferences[];
  nativeTheme: () => ColorTheme;
} {
  const requests: AppearancePreferences[] = [];
  let native: ColorTheme = stored;
  const apply = (prefs: AppearancePreferences) => {
    if (prefs.colorTheme === "system") root.removeAttribute("data-force-theme");
    else root.setAttribute("data-force-theme", prefs.colorTheme);
    root.dataset.windowTransparency = String(prefs.windowTransparency);
    native = prefs.colorTheme;
    window.dispatchEvent(new CustomEvent(APPEARANCE_CHANGE_EVENT, { detail: prefs }));
  };
  const onRequest = (event: Event) => {
    const detail = (event as CustomEvent<AppearancePreferences>).detail;
    requests.push(detail);
    apply(detail);
  };
  apply({ colorTheme: stored, windowTransparency: transparency });
  window.addEventListener(APPEARANCE_REQUEST_EVENT, onRequest);
  removeHost = () => window.removeEventListener(APPEARANCE_REQUEST_EVENT, onRequest);
  return { requests, nativeTheme: () => native };
}

function mountAppearance(): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(PrototypeSettingsPanes, {
    target: host,
    props: { section: "appearance" },
  });
  return host;
}

function checkedTheme(el: HTMLElement): string | null {
  const on = el.querySelector<HTMLButtonElement>(
    '[aria-label="Color theme"] button[aria-checked="true"]',
  );
  return on?.getAttribute("data-testid")?.replace("settings-theme-", "") ?? null;
}

function themeButton(el: HTMLElement, id: ColorTheme): HTMLButtonElement {
  const button = el.querySelector<HTMLButtonElement>(
    `[data-testid="settings-theme-${id}"]`,
  );
  if (!button) throw new Error(`no ${id} theme button`);
  return button;
}

describe("Settings theme selection matches the applied theme", () => {
  it("a fresh install selects System, not Dark, while the window follows macOS", async () => {
    installFakeHost("system");
    const el = mountAppearance();
    await tick();
    expect(root.hasAttribute("data-force-theme")).toBe(false);
    expect(checkedTheme(el)).toBe("system");
  });

  it("boots with a stored Dark rendered dark and selected Dark", async () => {
    const fake = installFakeHost("dark");
    const el = mountAppearance();
    await tick();
    expect(root.getAttribute("data-force-theme")).toBe("dark");
    expect(fake.nativeTheme()).toBe("dark");
    expect(checkedTheme(el)).toBe("dark");
  });

  it("choosing Dark applies at once, reaches the host, and keeps both stores in step", async () => {
    const fake = installFakeHost("light", 20);
    const el = mountAppearance();
    await tick();
    expect(checkedTheme(el)).toBe("light");

    themeButton(el, "dark").click();
    await tick();

    expect(root.getAttribute("data-force-theme")).toBe("dark");
    expect(fake.nativeTheme()).toBe("dark");
    // A whole preference: the theme change must not reset the opacity.
    expect(fake.requests.at(-1)).toEqual({ colorTheme: "dark", windowTransparency: 20 });
    expect(memoryStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(checkedTheme(el)).toBe("dark");
  });

  it("follows a theme applied from another window", async () => {
    installFakeHost("system");
    const el = mountAppearance();
    await tick();
    window.dispatchEvent(
      new CustomEvent(APPEARANCE_REQUEST_EVENT, {
        detail: { colorTheme: "dark", windowTransparency: 0 },
      }),
    );
    await tick();
    expect(checkedTheme(el)).toBe("dark");
  });

  it("without a desktop host, still applies locally and sends no request", async () => {
    const seen: unknown[] = [];
    const onRequest = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener(APPEARANCE_REQUEST_EVENT, onRequest);
    try {
      const el = mountAppearance();
      await tick();
      // Mount may re-apply the stored opacity; only the theme click matters.
      seen.length = 0;
      themeButton(el, "dark").click();
      await tick();
      expect(root.getAttribute("data-force-theme")).toBe("dark");
      expect(checkedTheme(el)).toBe("dark");
      expect(seen).toEqual([]);
    } finally {
      window.removeEventListener(APPEARANCE_REQUEST_EVENT, onRequest);
    }
  });
});

describe("restoreStoredColorTheme hands a saved theme to the host", () => {
  it("carries an older Settings choice into the host preference on launch", () => {
    const fake = installFakeHost("system");
    memoryStorage.setItem(THEME_STORAGE_KEY, "dark");
    restoreStoredColorTheme(root, memoryStorage, window);
    expect(root.getAttribute("data-force-theme")).toBe("dark");
    expect(fake.nativeTheme()).toBe("dark");
    expect(fake.requests).toEqual([{ colorTheme: "dark", windowTransparency: 0 }]);
  });

  it("sends nothing when no theme was ever chosen", () => {
    const fake = installFakeHost("system");
    restoreStoredColorTheme(root, memoryStorage, window);
    expect(fake.requests).toEqual([]);
    expect(root.hasAttribute("data-force-theme")).toBe(false);
  });
});
