// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import PrototypeSettingsPanes from "./PrototypeSettingsPanes.svelte";
import {
  readSettingsPrefs,
  writeSettingsPrefs,
} from "./settings-prefs.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

const memoryStorage = installMemoryLocalStorage();

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
});

describe("PrototypeSettingsPanes sidebar scope-label toggle", () => {
  it("defaults on and persists off through settings prefs", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "appearance", storage: memoryStorage },
    });
    await tick();

    const toggle = host.querySelector<HTMLButtonElement>(
      '[data-testid="settings-sidebar-scope-labels"]',
    );
    expect(toggle).toBeTruthy();
    expect(toggle?.getAttribute("aria-label")).toBe(
      "Show company / email labels in the sidebar",
    );
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(readSettingsPrefs(memoryStorage).showSidebarScopeLabels).toBe(true);

    toggle?.click();
    await tick();
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(readSettingsPrefs(memoryStorage).showSidebarScopeLabels).toBe(false);

    writeSettingsPrefs({ showSidebarScopeLabels: true }, memoryStorage);
  });
});
