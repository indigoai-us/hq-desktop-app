// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { failure, ok, type PlatformAdapter } from "@hq/platform";

import PrototypeSettingsPanes from "./PrototypeSettingsPanes.svelte";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

const memoryStorage = installMemoryLocalStorage();
const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

function makeAdapter(extra: Record<string, unknown> = {}): PlatformAdapter {
  return {
    kind: "desktop",
    isAvailable: () => false,
    appShell: { notificationPermissionState: vi.fn(async () => ok("granted")) },
    meetings: {
      listAccounts: vi.fn(async () => ok([])),
      connectCalendar: vi.fn(async () => ok({ url: "https://accounts.example.com/oauth" })),
    },
    settings: { getSettings: vi.fn(async () => ok({})) },
    messaging: {},
    ...extra,
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
  vi.restoreAllMocks();
});

function render(props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(PrototypeSettingsPanes, { target: host, props });
  flushSync();
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function expectNoRaw(): void {
  expect(host.textContent ?? "").not.toContain("boom");
  expect(host.textContent ?? "").not.toContain("HTTP 500");
  for (const el of host.querySelectorAll("[title]")) {
    expect(el.getAttribute("title") ?? "").not.toContain("boom");
  }
}

describe("PrototypeSettingsPanes raw errors (AUDIT-3c)", () => {
  it("a native settings failure shows plain copy, logs the raw text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = makeAdapter({
      settings: { getSettings: vi.fn(async () => failure("invoke", RAW)) },
    });
    render({ section: "general", adapter });
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => {
      flushSync();
      expect(q("settings-native-error")?.textContent).toContain("wasn’t saved. Try again.");
    });
    expectNoRaw();
    expect(warn).toHaveBeenCalledWith("[settings] Settings not saved", RAW);
  });

  it("a failed console open from Calendars shows plain copy, logs the raw error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = new Error(RAW);
    render({
      section: "meetings",
      adapter: makeAdapter(),
      onopenconsole: async () => {
        throw err;
      },
    });
    await vi.waitFor(() => expect(q("settings-manage-console")).not.toBeNull());
    q("settings-manage-console")!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain("Couldn’t open HQ Console. Try again.");
    });
    expectNoRaw();
    expect(warn).toHaveBeenCalledWith("[settings] open HQ Console failed", err);
  });

  it("a failed browser open during calendar connect shows plain copy, logs the raw error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = new Error(RAW);
    render({
      section: "meetings",
      adapter: makeAdapter(),
      onopenconsole: async () => {
        throw err;
      },
    });
    await vi.waitFor(() => expect(q("settings-connect-calendar")).not.toBeNull());
    q("settings-connect-calendar")!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain("Couldn't open the browser. Try again.");
    });
    expectNoRaw();
    expect(warn).toHaveBeenCalledWith("[settings] open calendar connect URL failed", err);
  });
});
