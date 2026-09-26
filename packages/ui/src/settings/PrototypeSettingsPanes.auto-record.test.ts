// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { failure, ok, type PlatformAdapter, unavailable } from "@hq/platform";
import PrototypeSettingsPanes from "./PrototypeSettingsPanes.svelte";

function makeAdapter(options: {
  native?: Record<string, unknown>;
  updateSettings?: PlatformAdapter["settings"]["updateSettings"];
  canWatchMeetings?: boolean;
}) {
  const updateSettings = vi.fn(options.updateSettings ?? (async () => ok(undefined)));
  const adapter = {
    kind: "desktop",
    isAvailable: (capability: string) =>
      capability === "canLaunchApps" && (options.canWatchMeetings ?? true),
    settings: {
      getSettings: async () => ok(options.native ?? {}),
      updateSettings,
      getConfig: async () => ok({}),
    },
    appShell: { notificationPermissionState: async () => ok("granted") },
    meetings: {
      listAccounts: async () => ok([]),
      permissionsState: async () => unavailable("desktop-only"),
    },
    sync: { getSyncStatus: async () => ok({}) },
  } as unknown as PlatformAdapter;
  return { adapter, updateSettings };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.clearAllMocks();
});

function render(adapter: PlatformAdapter) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(PrototypeSettingsPanes, {
    target: host,
    props: { section: "meetings", adapter, companies: [] },
  });
}

const toggle = () =>
  host.querySelector<HTMLButtonElement>('[data-testid="settings-auto-record-meetings"]');

describe("Settings > Meetings auto-record", () => {
  it("renders the switch OFF when the setting has never been saved", async () => {
    const { adapter } = makeAdapter({ native: {} });
    render(adapter);

    await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).toContain("Record meetings automatically");
  });

  it("reflects a saved ON value", async () => {
    const { adapter } = makeAdapter({ native: { autoRecordMeetings: true } });
    render(adapter);

    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("true"));
  });

  it("persists autoRecordMeetings as a top-level key when switched on", async () => {
    const { adapter, updateSettings } = makeAdapter({ native: {} });
    render(adapter);
    await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));

    toggle()!.click();
    await tick();

    await vi.waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ autoRecordMeetings: true }),
    );
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
  });

  it("rolls the switch back when the save fails", async () => {
    const { adapter } = makeAdapter({
      native: {},
      updateSettings: async () => failure("save-settings", "disk full"),
    });
    render(adapter);
    await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));

    toggle()!.click();

    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("false"));
  });

  it("is hidden on hosts that cannot detect meetings", async () => {
    const { adapter } = makeAdapter({ native: {}, canWatchMeetings: false });
    render(adapter);
    await tick();
    await tick();

    expect(toggle()).toBeNull();
  });
});
