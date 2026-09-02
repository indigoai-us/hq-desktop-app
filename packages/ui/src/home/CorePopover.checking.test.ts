// @vitest-environment happy-dom
//
// Owner bug: a healthy install (menubar.json hqPath set, core/core.yaml
// present) rendered "HQ core not detected / NOT CHECKED" in the popover.
// Root cause: the cheap version read was gated behind Promise.all with the
// slow checkCoreState scan, and the null initial state had no "checking"
// presentation. These tests pin the fix: the row reads as checking while
// the version read is in flight, the version paints as soon as it lands
// (before the state scan finishes), and "not detected" only appears after
// the read actually resolved without a version.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import CorePopover from "./CorePopover.svelte";
import { resetUpdateStore } from "../settings/update-store.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  resetUpdateStore();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type Result = { ok: true; value: unknown };
const ok = (value: unknown): Result => ({ ok: true, value });

function makeAdapter(overrides: {
  getVersions?: () => Promise<unknown>;
  checkCoreState?: () => Promise<unknown>;
}) {
  return {
    isAvailable: () => true,
    packages: {
      listPackagesCached: async () => ok(null),
      listPackages: async () => ok({ packs: { installed: [] } }),
    },
    updates: {
      getVersions:
        overrides.getVersions ?? (async () => ok({ core: "15.0.118" })),
      checkCoreState: overrides.checkCoreState ?? (async () => ok(null)),
      checkForUpdates: async () => ok(null),
      checkCliUpdate: async () => ok(null),
      installUpdate: async () => ok(undefined),
    },
    // Unused surface for these tests.
  } as never;
}

function mountPopover(adapter: unknown): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CorePopover, {
    target: host,
    props: {
      adapter: adapter as never,
      appVersion: "0.10.170",
      onclose: vi.fn(),
    },
  });
  flushSync();
  return host;
}

function coreRowText(): string {
  return (
    host
      .querySelector('[data-testid="core-popover-core-row"]')
      ?.textContent?.replace(/\s+/g, " ")
      .trim() ?? ""
  );
}

describe("CorePopover core-row checking state", () => {
  it("shows checking (never not detected) while the version read is in flight, then the version", async () => {
    const versions = deferred<unknown>();
    const state = deferred<unknown>();
    mountPopover(
      makeAdapter({
        getVersions: () => versions.promise as Promise<unknown>,
        checkCoreState: () => state.promise as Promise<unknown>,
      }),
    );
    await vi.waitFor(() => {
      flushSync();
      expect(coreRowText()).toContain("Checking HQ core");
    });
    expect(coreRowText()).not.toContain("not detected");
    expect(coreRowText()).toContain("CHECKING");

    // Version resolves first — it must paint without waiting for the slow
    // core-state scan (still pending here).
    versions.resolve(ok({ core: "15.0.118" }));
    await vi.waitFor(() => {
      flushSync();
      expect(coreRowText()).toContain("HQ core v15.0.118");
    });
    state.resolve(ok(null));
  });

  it("says not detected only after the version read resolves empty", async () => {
    const versions = deferred<unknown>();
    mountPopover(
      makeAdapter({
        getVersions: () => versions.promise as Promise<unknown>,
      }),
    );
    await vi.waitFor(() => {
      flushSync();
      expect(coreRowText()).toContain("Checking HQ core");
    });

    versions.resolve(ok({}));
    await vi.waitFor(() => {
      flushSync();
      expect(coreRowText()).toContain("HQ core not detected");
    });
    expect(coreRowText()).toContain("NOT CHECKED");
  });
});
