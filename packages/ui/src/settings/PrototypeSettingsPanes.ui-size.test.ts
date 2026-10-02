// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import PrototypeSettingsPanes from "./PrototypeSettingsPanes.svelte";
import { readStoredUiSize } from "./settings-prefs.js";
import { createTenantStorage } from "../identity/tenant-storage.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

const memoryStorage = installMemoryLocalStorage();

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  memoryStorage.clear();
  document.documentElement.removeAttribute("data-ui-size");
});

function mountAppearance(companyId: string): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(PrototypeSettingsPanes, {
    target: host,
    props: {
      section: "appearance",
      // The shell passes tenant-scoped storage; Home and a company differ.
      storage: createTenantStorage(memoryStorage, {
        accountId: "acct_test",
        companyId,
      }),
    },
  });
  return host;
}

function sizeChip(root: HTMLElement, label: string): HTMLButtonElement {
  const chip = [
    ...root.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Interface size"] button',
    ),
  ].find((button) => button.textContent?.trim() === label);
  if (!chip) throw new Error(`no ${label} chip`);
  return chip;
}

describe("PrototypeSettingsPanes interface size (QA-074)", () => {
  it("keeps Large after Settings remounts under a different tenant scope", async () => {
    let root = mountAppearance("cmp_acme");
    await tick();
    sizeChip(root, "Large").click();
    await tick();
    expect(sizeChip(root, "Large").getAttribute("aria-checked")).toBe("true");
    expect(readStoredUiSize()).toBe("large");

    // Leave Settings, go Home (tenant scope "all"), reopen Settings.
    await unmount(component!);
    component = null;
    root.remove();
    root = mountAppearance("all");
    await tick();

    expect(sizeChip(root, "Large").getAttribute("aria-checked")).toBe("true");
    expect(sizeChip(root, "Default").getAttribute("aria-checked")).toBe("false");
    expect(document.documentElement.getAttribute("data-ui-size")).toBe("large");
  });
});
