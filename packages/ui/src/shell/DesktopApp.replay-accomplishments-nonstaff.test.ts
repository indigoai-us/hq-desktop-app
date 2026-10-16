// @vitest-environment happy-dom
/**
 * The staff-only "Replay accomplishments announcement" palette command is not
 * offered to anyone the host does not confirm as @getindigo.ai staff, even
 * with badges on.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount } from "svelte";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";
import { setBadgeSource, setBadgesEnabledSource } from "../badges/badge-source.js";
import { markLaunchSeen } from "../badges/badge-launch.js";
import { ACME, SELF, openPalette, replayAdapter, settle } from "./replay-accomplishments.fixture.js";

const memoryStorage = installMemoryLocalStorage();
let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
  setBadgeSource(null);
  setBadgesEnabledSource(null);
});

describe("Replay accomplishments announcement (not staff)", () => {
  it("is not in the palette", async () => {
    setBadgesEnabledSource(() => true);
    setBadgeSource(() => [{ id: "founding", earnedAt: "2026-03-02" }]);
    markLaunchSeen(SELF.uid);

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: replayAdapter(false),
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: createEmptyNotificationsApi(),
        self: { ...SELF, email: "ada@example.com" },
        coreFixtures: false,
        companies: [ACME],
      },
    });
    await settle();
    await openPalette();
    await settle();
    // The palette is open (its other commands are there), without Replay.
    expect(host.querySelector("#command-take-tour")).toBeTruthy();
    expect(host.querySelector("#command-replay-accomplishments")).toBeNull();
  }, 20_000);
});
