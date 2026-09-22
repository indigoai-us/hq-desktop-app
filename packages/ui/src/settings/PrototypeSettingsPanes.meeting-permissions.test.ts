// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, unavailable, type PlatformAdapter } from "@hq/platform";

import PrototypeSettingsPanes from "./PrototypeSettingsPanes.svelte";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

const memoryStorage = installMemoryLocalStorage();

function desktopAdapter(
  permissionsState: PlatformAdapter["meetings"]["permissionsState"],
) {
  const openPermissionsSetup = vi.fn(async () => ok(undefined));
  const adapter = {
    kind: "desktop",
    isAvailable: (capability: string) =>
      capability === "trayAndWindow" || capability === "canLaunchApps",
    appShell: {
      notificationPermissionState: vi.fn(async () => ok("granted")),
    },
    meetings: {
      listAccounts: vi.fn(async () => ok([])),
      permissionsState: vi.fn(permissionsState),
      openPermissionsSetup,
    },
    settings: { getSettings: vi.fn(async () => ok({})) },
  } as unknown as PlatformAdapter;
  return { adapter, openPermissionsSetup };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function mountMeetings(adapter: PlatformAdapter) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(PrototypeSettingsPanes, {
    target: host,
    props: { adapter, section: "meetings", companies: [] },
  });
  await tick();
  await tick();
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
  vi.clearAllMocks();
});

describe("Settings → Meetings → Meeting detection", () => {
  it("names the missing permissions and opens the setup window on Set up", async () => {
    // The field shape: mic granted, the other two never asked for.
    const { adapter, openPermissionsSetup } = desktopAdapter(async () =>
      ok({
        accessibility: "denied",
        screenCapture: "denied",
        microphone: "granted",
        systemAudio: "denied",
        fullDiskAccess: "unknown",
        allRequiredGranted: false,
      }),
    );
    await mountMeetings(adapter);

    const row = host.querySelector('[data-testid="settings-meeting-permissions"]');
    expect(row?.textContent).toContain("Accessibility, Screen Recording");
    const button = host.querySelector<HTMLButtonElement>(
      '[data-testid="settings-meeting-permissions-setup"]',
    );
    expect(button).not.toBeNull();
    button!.click();
    await tick();
    expect(openPermissionsSetup).toHaveBeenCalledTimes(1);
  });

  it("shows Ready once everything is granted", async () => {
    const { adapter } = desktopAdapter(async () =>
      ok({
        accessibility: "granted",
        screenCapture: "granted",
        microphone: "granted",
        systemAudio: "granted",
        fullDiskAccess: "unknown",
        allRequiredGranted: true,
      }),
    );
    await mountMeetings(adapter);
    expect(
      host.querySelector('[data-testid="settings-meeting-permissions-ready"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('[data-testid="settings-meeting-permissions-setup"]'),
    ).toBeNull();
  });

  it("hides the row when the host cannot report permissions", async () => {
    const { adapter } = desktopAdapter(async () => unavailable("desktop-only"));
    await mountMeetings(adapter);
    expect(
      host.querySelector('[data-testid="settings-meeting-permissions"]'),
    ).toBeNull();
  });
});
