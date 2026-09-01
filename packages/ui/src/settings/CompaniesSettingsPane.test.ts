// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";
import { failure, ok, type PlatformAdapter } from "@hq/platform";
import CompaniesSettingsPane from "./CompaniesSettingsPane.svelte";

function adapterForSettings(
  getSettings: PlatformAdapter["settings"]["getSettings"],
): PlatformAdapter {
  return {
    kind: "desktop",
    isAvailable: (capability: string) => capability === "canSync",
    settings: { getSettings },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.clearAllMocks();
});

function mountPane(adapter: PlatformAdapter): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CompaniesSettingsPane, {
    target: host,
    props: {
      adapter,
      companies: [],
      personalLabel: "Personal",
    },
  });
}

function personalSyncState(): string | null | undefined {
  return host
    .querySelector('[data-testid="settings-personal-sync-state"]')
    ?.textContent?.trim();
}

describe("CompaniesSettingsPane personal sync status", () => {
  it("shows Personal as synced when native sync is enabled", async () => {
    mountPane(adapterForSettings(async () => ok({ personalSyncEnabled: true })));

    await vi.waitFor(() => expect(personalSyncState()).toBe("Synced"));
  });

  it("defaults Personal to synced when the native setting is absent", async () => {
    mountPane(adapterForSettings(async () => ok({})));

    await vi.waitFor(() => expect(personalSyncState()).toBe("Synced"));
  });

  it("shows Personal as local only after an explicit native opt-out", async () => {
    mountPane(adapterForSettings(async () => ok({ personalSyncEnabled: false })));

    await vi.waitFor(() => expect(personalSyncState()).toBe("Local"));
  });

  it("does not misreport Personal as local when native settings cannot be read", async () => {
    mountPane(adapterForSettings(async () => failure("error", "settings-read-failed")));

    await vi.waitFor(() => expect(personalSyncState()).toBe("Unavailable"));
  });
});
