// @vitest-environment happy-dom
//
// Regression cover: the sync settings pane used to read `liveSync` exactly
// once in onMount. Because the real sync daemon is a separate process that
// is often still starting when this component mounts, that single snapshot
// could permanently pin the panel on "STOPPED" / "Never" even once the
// daemon was healthy — and switching away from and back to the "sync"
// section within the same running session (no remount) never re-read it
// either. These tests pin the fixed contract: the panel polls while the
// sync section is visible, stops polling once it isn't, and re-reads
// immediately when the user returns to the section.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import PrototypeSettingsPanes from "./PrototypeSettingsPanes.svelte";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

const memoryStorage = installMemoryLocalStorage();

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function syncAdapter(getSyncStatus: PlatformAdapter["sync"]["getSyncStatus"]) {
  const adapter = {
    kind: "desktop",
    isAvailable: (capability: string) => capability === "canSync",
    settings: { getSettings: async () => ok({}), getConfig: async () => ok({}) },
    appShell: { notificationPermissionState: async () => ok("unsupported") },
    meetings: { listAccounts: async () => ok([]) },
    sync: { getSyncStatus },
  } as unknown as PlatformAdapter;
  return adapter;
}

function daemonStatus(running: boolean) {
  return ok({
    lastSyncAt: running ? "2026-09-04T00:00:00Z" : null,
    pendingFiles: 0,
    conflicts: 0,
    daemonRunning: running,
    source: running ? "journal" : "none",
    hqFolderPath: undefined,
  });
}

function daemonLabel(): string | null {
  return (
    host.querySelector('[data-testid="settings-sync-pane"] .mono.ok')
      ?.textContent ??
    host
      .querySelector('[data-testid="settings-sync-pane"] .set-row .mono')
      ?.textContent ??
    null
  );
}

describe("PrototypeSettingsPanes live sync status refresh", () => {
  it("polls while the daemon comes up after mount and stops reflecting stale STOPPED", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const getSyncStatus = vi.fn(async () => {
      calls += 1;
      // First read: daemon hasn't finished starting yet (the historical bug
      // case). Later reads: the daemon has come up.
      return calls === 1 ? daemonStatus(false) : daemonStatus(true);
    });
    const adapter = syncAdapter(getSyncStatus);
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "sync", adapter },
    });

    await vi.waitFor(() => expect(calls).toBe(1));
    await tick();
    expect(daemonLabel()).toBe("STOPPED");

    await vi.advanceTimersByTimeAsync(5000);
    await tick();
    expect(getSyncStatus).toHaveBeenCalledTimes(2);
    expect(daemonLabel()).toBe("RUNNING");
  });

  it("clears the polling interval on unmount", async () => {
    vi.useFakeTimers();
    const getSyncStatus = vi.fn(async () => daemonStatus(true));
    const adapter = syncAdapter(getSyncStatus);
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, {
      target: host,
      props: { section: "sync", adapter },
    });

    await vi.waitFor(() => expect(getSyncStatus).toHaveBeenCalledTimes(1));

    await unmount(component);
    component = null;

    // Give the (now-torn-down) interval every chance to fire if it leaked.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getSyncStatus).toHaveBeenCalledTimes(1);
  });

  it("stops polling once the section is no longer sync", async () => {
    vi.useFakeTimers();
    const getSyncStatus = vi.fn(async () => daemonStatus(true));
    const adapter = syncAdapter(getSyncStatus);
    const props = $state<{ section: "sync" | "general"; adapter: PlatformAdapter }>(
      { section: "sync", adapter },
    );
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, { target: host, props });

    await vi.waitFor(() => expect(getSyncStatus).toHaveBeenCalledTimes(1));

    props.section = "general";
    await tick();

    // Give the (now-cleared) interval every chance to fire if it leaked.
    await vi.advanceTimersByTimeAsync(30_000);
    await tick();
    expect(getSyncStatus).toHaveBeenCalledTimes(1);
  });

  it("re-reads immediately when navigating back to the sync section without a remount", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const getSyncStatus = vi.fn(async () => {
      calls += 1;
      return calls <= 1 ? daemonStatus(false) : daemonStatus(true);
    });
    const adapter = syncAdapter(getSyncStatus);
    const props = $state<{ section: "sync" | "general"; adapter: PlatformAdapter }>(
      { section: "sync", adapter },
    );
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PrototypeSettingsPanes, { target: host, props });

    await vi.waitFor(() => expect(calls).toBe(1));

    // Navigate away, then back — same component instance, no remount.
    props.section = "general";
    await tick();
    props.section = "sync";
    await tick();

    await vi.waitFor(() => expect(getSyncStatus).toHaveBeenCalledTimes(2));
    await tick();
    expect(daemonLabel()).toBe("RUNNING");
  });
});
