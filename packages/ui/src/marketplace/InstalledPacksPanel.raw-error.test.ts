// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { flushSync, mount, unmount } from "svelte";
import { failure, ok, type PlatformAdapter } from "@hq/platform";
import InstalledPacksPanel from "./InstalledPacksPanel.svelte";
import type { PackagesEvents } from "../library/packages-events.js";

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

const pack = {
  name: "demo-pack",
  transport: null,
  hqCoreSatisfied: true,
  contributes: {},
  links: {},
  brokenLinks: [],
  inCatalog: true,
  updateAvailable: false,
  initialization: { entrypoint: "demo" },
};

const view = {
  packs: { hqRoot: "/hq", hqVersion: "1.0.0", installed: [pack], available: [], warnings: [] },
  registry: null,
  error: null,
};

function adapterWith(listPackages: () => Promise<unknown>): PlatformAdapter {
  return {
    kind: "desktop",
    isAvailable: () => true,
    packages: {
      listPackages: vi.fn(listPackages),
      checkUpdates: vi.fn(async () => ok(null)),
    },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

function render(adapter: PlatformAdapter, packagesEvents: PackagesEvents | null = null): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(InstalledPacksPanel, { target: host, props: { adapter, packagesEvents } });
}

function expectNoRaw(): void {
  expect(host.textContent ?? "").not.toContain("boom");
  for (const el of host.querySelectorAll("[title]")) {
    expect(el.getAttribute("title") ?? "").not.toContain("boom");
  }
}

function rejectClipboard(): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => { throw new Error(RAW); }) },
  });
}

describe("InstalledPacksPanel raw errors (AUDIT-3c)", () => {
  it("update probe failure keeps raw text out of the probe note tooltip", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events: PackagesEvents = {
      subscribe: vi.fn(async (handlers) => {
        queueMicrotask(() => handlers.onUpdates({ packs: null, registry: null, error: RAW }));
        return () => {};
      }),
    };
    render(adapterWith(async () => ok(view)), events);
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector(".probe-note")?.textContent).toContain(
        "Update availability could not be refreshed",
      );
    });
    expectNoRaw();
    expect(warn).toHaveBeenCalledWith("[installed-packs] update probe failed", RAW);
  });

  it("get-started copy failure keeps raw text out of the error tooltip", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    rejectClipboard();
    render(adapterWith(async () => ok(view)));
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="installed-get-started-copy"]')).not.toBeNull();
    });
    host.querySelector<HTMLButtonElement>('[data-testid="installed-get-started-copy"]')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector(".pack-action-error")?.textContent).toContain(
        "Couldn’t copy to the clipboard.",
      );
    });
    expectNoRaw();
    expect(err).toHaveBeenCalledWith(
      "installed-packs: clipboard write failed",
      expect.objectContaining({ message: RAW }),
    );
  });

  it("repair command copy failure keeps raw text out of the error tooltip", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    rejectClipboard();
    render(adapterWith(async () => failure("spawn", "hq: command not found")));
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector(".repair-link")).not.toBeNull();
    });
    host.querySelector<HTMLButtonElement>(".repair-link")!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector(".pack-action-error")?.textContent).toContain(
        "Couldn’t copy to the clipboard.",
      );
    });
    expectNoRaw();
    expect(err).toHaveBeenCalledWith(
      "installed-packs: repair command copy failed",
      expect.objectContaining({ message: RAW }),
    );
  });
});
