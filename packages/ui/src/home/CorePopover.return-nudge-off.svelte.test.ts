// @vitest-environment happy-dom
//
// US-016: a first-week return nudge already on screen goes away when its
// company's sync is switched off on this computer.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import CorePopover from "./CorePopover.svelte";
import { resetUpdateStore } from "../settings/update-store.svelte";
import type { PlatformAdapter } from "@hq/platform";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const NUDGE_KEY = "hq:desktop:first-week-return-nudge:v1:cmp_test";

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  resetUpdateStore();
  localStorage.removeItem(NUDGE_KEY);
});

const ok = (value: unknown) => ({ ok: true as const, value });

function makeAdapter() {
  return {
    kind: "desktop",
    isAvailable: () => true,
    identity: { hasFeature: vi.fn(async () => ok(true)) },
    company: {
      getFirstWeekReturnNudge: vi.fn(async () => ok({ eligible: true, dayIndex: 2, reason: "eligible" })),
    },
    sync: { startSync: vi.fn(async () => ok(undefined)) },
    packages: {
      listPackagesCached: async () => ok(null),
      listPackages: async () => ok({ packs: { installed: [] } }),
    },
    updates: {
      getVersions: async () => ok({ core: "15.0.118" }),
      checkCoreState: async () => ok(null),
      checkForUpdates: async () => ok(null),
      checkCliUpdate: async () => ok(null),
      downloadUpdate: async () => ok(null),
      installDownloadedUpdate: async () => ok(null),
      getDownloadedUpdate: async () => ok(null),
    },
    shell: { openClaudeCodeLink: async () => ok(undefined) },
  } as unknown as PlatformAdapter;
}

const nudge = () => host.querySelector('[data-testid="core-popover-return-nudge"]');

describe("CorePopover return nudge and the per-vault switch (US-016)", () => {
  it("hides a shown nudge when its company is switched off, and keeps it for another company's switch", async () => {
    const adapter = makeAdapter();
    host = document.createElement("div");
    document.body.appendChild(host);
    const props = $state({
      adapter,
      appVersion: "0.10.285",
      hqFolderPath: "/Users/me/HQ",
      onclose: vi.fn(),
      workspaces: [
        { cloudUid: "cmp_test", slug: "indigo", name: "Indigo", syncEnabled: true },
        { cloudUid: "cmp_other", slug: "other", name: "Other", syncEnabled: true },
      ] as Array<Record<string, unknown>>,
    });
    component = mount(CorePopover, { target: host, props: props as never });
    flushSync();
    await vi.waitFor(() => expect(nudge()).not.toBeNull());

    // Another company's switch going off leaves this nudge alone.
    props.workspaces = [
      { cloudUid: "cmp_test", slug: "indigo", name: "Indigo", syncEnabled: true },
      { cloudUid: "cmp_other", slug: "other", name: "Other", syncEnabled: false },
    ];
    flushSync();
    expect(nudge()).not.toBeNull();

    // Its own company's switch going off removes it.
    props.workspaces = [
      { cloudUid: "cmp_test", slug: "indigo", name: "Indigo", syncEnabled: false },
      { cloudUid: "cmp_other", slug: "other", name: "Other", syncEnabled: false },
    ];
    flushSync();
    expect(nudge()).toBeNull();
    expect(adapter.sync.startSync).not.toHaveBeenCalled();
  });
});
