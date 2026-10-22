// @vitest-environment happy-dom

// Title-bar sync chip: live progress beside the bell. Progress ONLY — the Core
// pill's dot already owns auth-error / error, and two warning lights
// in one bar makes it ambiguous which to act on.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import V4TitleBar from "./V4TitleBar.svelte";
import { emptySyncStatus, reduceSyncEvent } from "./sync-status.js";

const ok = <T,>(value: T) => ({ ok: true as const, value });

function adapter() {
  return {
    kind: "desktop" as const,
    capabilities: { hasWindowControls: true, localFiles: true },
    isAvailable: () => false,
    shell: {
      detectAiTools: vi.fn(async () => ok({})),
    },
    files: { revealHqRoot: vi.fn(async () => ok(undefined)) },
    settings: { getSetupStatus: vi.fn(async () => ok({ hqFolderPath: "/tmp/HQ" })) },
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function mountBar(extraProps: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(V4TitleBar, {
    target: host,
    props: {
      adapter: adapter(),
      version: "0.0.0-test",
      syncState: "idle",
      watchedCount: 0,
      ...extraProps,
    } as never,
  });
  await tick();
}

const chip = () =>
  host.querySelector<HTMLButtonElement>('[data-testid="titlebar-sync-status"]');

describe("titlebar sync chip", () => {
  it("shows live progress against the planned total while syncing", async () => {
    let s = reduceSyncEvent(emptySyncStatus(), "sync:plan", {
      company: "acme",
      filesToDownload: 20,
      filesToUpload: 8,
    });
    s = reduceSyncEvent(s, "sync:progress", { company: "acme", path: "a" });
    s = reduceSyncEvent(s, "sync:progress", { company: "acme", path: "b" });
    s = reduceSyncEvent(s, "sync:progress", { company: "acme", path: "c" });

    await mountBar({ syncStatus: s });
    expect(chip()?.textContent).toContain("3 of 28");
    expect(chip()?.getAttribute("aria-label")).toContain("acme");
  });

  it("shows nothing when sync is idle", async () => {
    // D-04 hides idle sync chrome. A permanent "All synced" chip is correct
    // almost always and therefore stops being read.
    await mountBar({ syncStatus: emptySyncStatus() });
    expect(chip()).toBeNull();
  });

  it("shows nothing when the platform has no sync events to observe", async () => {
    await mountBar({ syncStatus: null });
    expect(chip()).toBeNull();
  });

  it("does not draw a second warning light for attention states", async () => {
    // The Core pill's dot tone and its popover sentence already carry these.
    for (const event of ["sync:auth-error", "sync:error"]) {
      let s = reduceSyncEvent(emptySyncStatus(), "sync:plan", {
        company: "acme",
        filesToDownload: 9,
      });
      s = reduceSyncEvent(s, event, {});
      await mountBar({ syncStatus: s });
      expect(chip(), `${event} must not render a chip`).toBeNull();
      if (component) await unmount(component);
      component = null;
      host.remove();
    }
  });

  it("opens sync settings when clicked", async () => {
    const onopenSync = vi.fn();
    let s = reduceSyncEvent(emptySyncStatus(), "sync:progress", { company: "acme" });
    await mountBar({ syncStatus: s, onopenSync });
    chip()!.click();
    expect(onopenSync).toHaveBeenCalledTimes(1);
  });

  it("is inert rather than misleading when nothing can handle a click", async () => {
    let s = reduceSyncEvent(emptySyncStatus(), "sync:progress", { company: "acme" });
    await mountBar({ syncStatus: s });
    expect(chip()?.disabled).toBe(true);
  });
});

it("shows a persisted startup hold and an explicit retry before any sync events arrive", async () => {
  const { readLiveSyncStatus, syncStateFromLive } = await import("../settings/live-sync-status.js");
  const reason = "Automatic sync recovery stopped after a setup failure. Fix the problem, then try Sync Now again.";
  const source = { isAvailable: () => true, sync: { getSyncStatus: async () => ok({ recoveryHoldReason: reason }) } };
  const status = await readLiveSyncStatus(source as never);
  const onretry = vi.fn(async () => {});
  await mountBar({ adapter: { ...adapter(), isAvailable: (cap: string) => cap === "canSync", sync: source.sync }, syncState: syncStateFromLive(status), syncRecoveryReason: status.recoveryHoldReason, errorMessage: status.recoveryHoldReason, errorSummary: status.recoveryHoldReason, onretry });
  host.querySelector<HTMLButtonElement>('[data-testid="titlebar-core-pill"]')?.click();
  await tick();
  expect(host.textContent).toContain(reason);
  expect(host.textContent).not.toContain("Sync started but needs a hand");
  const retry = host.querySelector<HTMLButtonElement>('[data-testid="core-popover-recovery-action"]');
  expect(retry?.textContent).toContain("Retry");
  retry?.click();
  await tick();
  expect(onretry).toHaveBeenCalledTimes(1);
});
