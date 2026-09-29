// @vitest-environment happy-dom

// Title-bar Appearance menu: an icon button after the bell (before Core)
// opening a popover with a Light / Dark / System segmented control and a
// Window opacity slider. Both controls MUST go through the shared
// appearance-store functions that Settings > Appearance uses.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

vi.mock("../settings/appearance-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../settings/appearance-store.js")>();
  return {
    ...actual,
    setAppearanceColorTheme: vi.fn(actual.setAppearanceColorTheme),
    setAppearanceWindowOpacity: vi.fn(actual.setAppearanceWindowOpacity),
  };
});

import V4TitleBar from "./V4TitleBar.svelte";
import {
  setAppearanceColorTheme,
  setAppearanceWindowOpacity,
} from "../settings/appearance-store.js";

const ok = <T,>(value: T) => ({ ok: true as const, value });

function makeAdapter() {
  return {
    kind: "desktop" as const,
    capabilities: { hasWindowControls: true, localFiles: true },
    isAvailable: (key: string) => key === "canSync",
    shell: {},
    files: { revealHqRoot: vi.fn(async () => ok(undefined)) },
    settings: {
      getSetupStatus: vi.fn(async () => ok({ hqFolderPath: "/tmp/HQ" })),
    },
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function resetRoot() {
  const root = document.documentElement;
  delete root.dataset.windowTransparency;
  root.removeAttribute("data-force-theme");
  root.removeAttribute("style");
  window.localStorage.clear();
}

beforeEach(() => {
  resetRoot();
  vi.mocked(setAppearanceColorTheme).mockClear();
  vi.mocked(setAppearanceWindowOpacity).mockClear();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  resetRoot();
});

async function mountBar() {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(V4TitleBar, {
    target: host,
    props: {
      adapter: makeAdapter(),
      version: "0.0.0-test",
      syncState: "idle",
      watchedCount: 0,
      onopenNotifications: () => {},
    } as never,
  });
  await tick();
}

const q = <T extends Element = HTMLElement>(id: string) =>
  host.querySelector<T & HTMLElement>(`[data-testid="${id}"]`);

async function openMenu() {
  q<HTMLButtonElement>("titlebar-appearance")!.click();
  await tick();
  await tick();
}

describe("V4TitleBar Appearance menu", () => {
  it("renders a labelled icon button after the bell and before Core", async () => {
    await mountBar();
    const button = q<HTMLButtonElement>("titlebar-appearance");
    expect(button).not.toBeNull();
    expect(button!.getAttribute("aria-label")).toBe("Appearance");
    expect(button!.classList.contains("v4-icon-btn")).toBe(true);
    expect(button!.getAttribute("aria-expanded")).toBe("false");

    const order = Array.from(
      host.querySelectorAll<HTMLElement>(
        '[data-testid="titlebar-notifications"], [data-testid="titlebar-appearance"], [data-testid="titlebar-core-pill"]',
      ),
    ).map((el) => el.dataset.testid);
    expect(order).toEqual([
      "titlebar-notifications",
      "titlebar-appearance",
      "titlebar-core-pill",
    ]);
  });

  it("opens a popover with a labelled theme control and opacity slider", async () => {
    await mountBar();
    expect(q("titlebar-appearance-menu")).toBeNull();
    await openMenu();

    const menu = q("titlebar-appearance-menu");
    expect(menu).not.toBeNull();
    expect(menu!.getAttribute("aria-label")).toBe("Appearance");
    expect(q("titlebar-appearance")!.getAttribute("aria-expanded")).toBe("true");

    const group = q("titlebar-appearance-theme")!;
    expect(group.getAttribute("role")).toBe("radiogroup");
    const labelId = group.getAttribute("aria-labelledby")!;
    expect(document.getElementById(labelId)?.textContent).toBe("Theme");
    const radios = Array.from(group.querySelectorAll('[role="radio"]')).map(
      (el) => el.textContent,
    );
    expect(radios).toEqual(["Light", "Dark", "System"]);

    const slider = q<HTMLInputElement>("titlebar-appearance-opacity")!;
    const label = host.querySelector(`label[for="${slider.id}"]`);
    expect(label?.textContent).toBe("Window opacity");
    // Fresh profile: fully solid.
    expect(slider.value).toBe("100");
    expect(q("titlebar-appearance-opacity-value")!.textContent).toBe("100%");
  });

  it("routes the theme through the shared store", async () => {
    await mountBar();
    await openMenu();
    q<HTMLButtonElement>("titlebar-appearance-theme-light")!.click();
    await tick();
    expect(setAppearanceColorTheme).toHaveBeenCalledWith("light");
    expect(document.documentElement.getAttribute("data-force-theme")).toBe(
      "light",
    );
    expect(
      q("titlebar-appearance-theme-light")!.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("routes the opacity slider through the shared store", async () => {
    await mountBar();
    await openMenu();
    const slider = q<HTMLInputElement>("titlebar-appearance-opacity")!;
    slider.value = "60";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(setAppearanceWindowOpacity).toHaveBeenCalledWith(60);
    expect(q("titlebar-appearance-opacity-value")!.textContent).toBe("60%");
    expect(
      document.documentElement.style.getPropertyValue(
        "--hq-window-transparency-factor",
      ),
    ).toBe("0.40");
  });

  it("follows a change made elsewhere (Settings > Appearance) live", async () => {
    await mountBar();
    await openMenu();
    // Same function Settings > Appearance calls.
    setAppearanceWindowOpacity(45);
    await tick();
    expect(q<HTMLInputElement>("titlebar-appearance-opacity")!.value).toBe("45");
    expect(q("titlebar-appearance-opacity-value")!.textContent).toBe("45%");
  });

  it("Escape closes the popover and returns focus to the button", async () => {
    await mountBar();
    await openMenu();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await tick();
    expect(q("titlebar-appearance-menu")).toBeNull();
    expect(document.activeElement).toBe(q("titlebar-appearance"));
  });

  it("closes when the Launch menu opens", async () => {
    await mountBar();
    await openMenu();
    q<HTMLButtonElement>("titlebar-launch")!.click();
    await tick();
    expect(q("titlebar-appearance-menu")).toBeNull();
  });
});
