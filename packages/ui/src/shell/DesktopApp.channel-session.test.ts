// @vitest-environment happy-dom

/**
 * In-channel Session clicks must start a live session even when the pane has
 * no project (pinned #welcome, or a company that has not created one yet).
 * The previous gate required both companySlug and projectId and silently
 * returned the thread to idle — clicks looked ignored.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount, type ComponentProps } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { SETUP_ROW_ID } from "../chat/setup-channel.js";
import type { Workspace } from "../chat/workspaces.js";

const CRAYADS: Workspace = {
  slug: "crayads",
  displayName: "Crayads",
  kind: "company",
  state: "synced",
  cloudUid: "cmp_crayads",
  bucketName: null,
  hasLocalFolder: true,
  localPath: "/tmp/HQ/crayads",
  membershipStatus: "active",
  role: "owner",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
};

function adapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () =>
        ok({
          messages: [
            {
              eventId: "evt_welcome",
              body: "Welcome to HQ",
              fromPersonUid: "prs_test",
              fromDisplayName: "Martin",
              createdAt: "2026-09-15T12:00:00Z",
              direction: "in",
              replyCount: 0,
            },
          ],
          nextCursor: null,
        }),
    },
    settings: {
      getSetupStatus: async () =>
        ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
    },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function mountApp(
  extra: Partial<ComponentProps<typeof DesktopApp>> = {},
): Promise<ReturnType<typeof vi.fn>> {
  host = document.createElement("div");
  document.body.appendChild(host);
  const onstartlivesession = vi.fn(async () => ({ sessionId: "sess_live_1" }));
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: {
        uid: "prs_test",
        displayName: "Martin",
        email: "martin@crayads.com",
      },
      companies: [CRAYADS],
      coreFixtures: false,
      onstartlivesession,
      ...extra,
    },
  });
  await settle();
  return onstartlivesession;
}

describe("DesktopApp in-channel session start", () => {
  it("starts a live session from pinned #welcome even though that row has no company or project", async () => {
    const onstartlivesession = await mountApp();
    const welcome = host.querySelector<HTMLButtonElement>(
      `[data-conversation-id="${SETUP_ROW_ID}"]`,
    );
    expect(welcome, "pinned #welcome row renders").toBeTruthy();
    welcome!.click();
    await settle();

    const start = host.querySelector<HTMLButtonElement>(
      '[data-testid="composer-start-session"]',
    );
    expect(start, "Session control is on the welcome composer").toBeTruthy();
    start!.click();
    await settle();

    expect(onstartlivesession).toHaveBeenCalledOnce();
    const input = onstartlivesession.mock.calls[0]?.[0] as {
      companySlug: string;
      projectId: string;
    };
    expect(input.companySlug).toBe("crayads");
    expect(input.projectId).toBe("");
  });
});
