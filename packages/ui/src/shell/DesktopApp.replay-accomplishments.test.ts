// @vitest-environment happy-dom
/**
 * Owner, 2026-10-16: "add a staff-only 'Replay accomplishments announcement'
 * command in the command palette so I can see it fresh."
 *
 * For a staff member with badges on who has already seen the announcement,
 * the palette offers Replay; it opens the full announcement with their badges
 * and closes as usual. The "seen" record is untouched, so it never comes back
 * on its own.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";
import { setBadgeSource, setBadgesEnabledSource } from "../badges/badge-source.js";
import { hasSeenLaunch, LAUNCH_OPEN_DELAY_MS, markLaunchSeen } from "../badges/badge-launch.js";
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

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("Replay accomplishments announcement (staff)", () => {
  it("is offered to staff with badges on, and replays the announcement without resetting 'seen'", async () => {
    setBadgesEnabledSource(() => true);
    setBadgeSource(() => [{ id: "founding", earnedAt: "2026-03-02" }, { id: "maker", tier: 2, earnedAt: "2026-10-01" }]);
    markLaunchSeen(SELF.uid);

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: replayAdapter(true),
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: createEmptyNotificationsApi(),
        self: SELF,
        coreFixtures: false,
        companies: [ACME],
      },
    });
    await settle();
    // Already seen: it does not open on its own.
    await new Promise((r) => setTimeout(r, LAUNCH_OPEN_DELAY_MS + 200));
    await settle();
    expect(q("badge-launch")).toBeNull();

    await openPalette();
    const row = await vi.waitFor(() => {
      const found = host.querySelector<HTMLButtonElement>("#command-replay-accomplishments");
      expect(found).toBeTruthy();
      return found!;
    }, { timeout: 2000, interval: 20 });
    expect(row.textContent).toContain("Replay accomplishments announcement");
    row.click();
    await vi.waitFor(() => expect(q("badge-launch")).toBeTruthy(), { timeout: 2000, interval: 20 });
    expect(q("badge-launch")?.getAttribute("data-state")).toBe("earned");

    q("badge-launch-close")!.click();
    await vi.waitFor(() => expect(q("badge-launch")).toBeNull(), { timeout: 2000, interval: 20 });
    expect(hasSeenLaunch(SELF.uid)).toBe(true);
  }, 20_000);
});
