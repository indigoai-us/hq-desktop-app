// @vitest-environment happy-dom

/**
 * End-to-end regression for "clicking a company in the Companies section
 * does nothing": builds the REAL sync-app api/adapter chain (real
 * `createSyncPlatformAdapter` from @hq/platform with a mocked Tauri
 * `invoke`, real `createChatSidebarApi` from this package) and mounts the
 * REAL `ChatSidebar` component from @hq/ui on top of it — the same wiring
 * `WorkShell.svelte` uses in the live app. A stub api (as most ChatSidebar
 * unit tests use) can't catch a seam break between the adapter and the
 * Tauri command layer; this test exercises the whole chain down to the
 * mocked `invoke` call.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import { createSyncPlatformAdapter } from "@hq/platform";
import ChatSidebar from "../../../../packages/ui/src/chat/ChatSidebar.svelte";
import type { Workspace } from "../../../../packages/ui/src/chat/workspaces.js";
import { installMemoryLocalStorage } from "../../../../packages/ui/src/test-support/memory-local-storage.js";

import { createChatSidebarApi } from "./chat-adapter.js";

installMemoryLocalStorage();

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (component) {
    unmount(component);
    component = null;
  }
  host.remove();
});

function recordingInvoke() {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "list_channels") return { channels: [] };
    if (cmd === "ensure_company_home_channel") return "chn_home_ensured";
    if (cmd === "frontend_log") return null;
    return null;
  };
  return { invoke, calls };
}

const PROVISIONING: Workspace = {
  slug: "provisioning",
  displayName: "Provisioning Co",
  kind: "company",
  state: "synced",
  cloudUid: "cmp_provisioning",
  bucketName: null,
  hasLocalFolder: true,
  localPath: null,
  membershipStatus: "active",
  role: "member",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
  homeChannelId: null,
};

const CONNECTED: Workspace = {
  ...PROVISIONING,
  slug: "connected",
  displayName: "Connected Co",
  cloudUid: "cmp_connected",
  homeChannelId: "chn_home_connected",
};

describe("Companies section click — real adapter chain", () => {
  it("no homeChannelId: click invokes ensure_company_home_channel and frontend_log through the real adapter", async () => {
    const { invoke, calls } = recordingInvoke();
    const adapter = createSyncPlatformAdapter({
      invoke,
      fetch: (() => {
        throw new Error("must not use window.fetch");
      }) as unknown as typeof globalThis.fetch,
    });
    const api = createChatSidebarApi(adapter, [], "prs_test");

    component = mount(ChatSidebar, {
      target: host,
      props: {
        api,
        wakes: { emit: () => {}, on: () => () => {} },
        companies: [PROVISIONING],
        self: { uid: "prs_test", email: "test@example.com" },
        isAdmin: false,
        accountLabel: "Test",
        accountInitials: "T",
        selectedId: null,
        scopeUid: null,
        tenantAccountId: "prs_test",
        engagedAgentUids: [],
        tenantCompanyId: null,
        seedDirectory: [],
        avatarByUid: {},
        rosterWakeSeq: 0,
        requestsWakeSeq: 0,
        onavatarmap: () => {},
        onselect: () => {},
      },
    });
    await tick();

    const row = host.querySelector(
      '[data-testid="chat-companies-row-disabled-cmp_provisioning"]',
    ) as HTMLButtonElement | null;
    expect(row).not.toBeNull();
    row!.click();
    await tick();
    // ensureCompanyHomeChannel + logToFile both resolve async round-trips.
    await new Promise((r) => setTimeout(r, 0));
    await tick();

    const cmds = calls.map((c) => c.cmd);
    expect(cmds).toContain("ensure_company_home_channel");
    expect(calls.find((c) => c.cmd === "ensure_company_home_channel")?.args).toEqual({
      companyUid: "cmp_provisioning",
    });
    expect(cmds).toContain("frontend_log");
    expect(
      calls.find((c) => c.cmd === "frontend_log")?.args,
    ).toMatchObject({ tag: "companies" });
  });

  it("known homeChannelId: click navigates without calling ensure_company_home_channel, still logs via frontend_log", async () => {
    const { invoke, calls } = recordingInvoke();
    const adapter = createSyncPlatformAdapter({
      invoke,
      fetch: (() => {
        throw new Error("must not use window.fetch");
      }) as unknown as typeof globalThis.fetch,
    });
    const api = createChatSidebarApi(adapter, [], "prs_test");

    let selected: unknown = null;
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api,
        wakes: { emit: () => {}, on: () => () => {} },
        companies: [CONNECTED],
        self: { uid: "prs_test", email: "test@example.com" },
        isAdmin: false,
        accountLabel: "Test",
        accountInitials: "T",
        selectedId: null,
        scopeUid: null,
        tenantAccountId: "prs_test",
        engagedAgentUids: [],
        tenantCompanyId: null,
        seedDirectory: [],
        avatarByUid: {},
        rosterWakeSeq: 0,
        requestsWakeSeq: 0,
        onavatarmap: () => {},
        onselect: (row: unknown) => {
          selected = row;
        },
      },
    });
    await tick();

    const row = host.querySelector(
      '[data-testid="chat-companies-row-cmp_connected"]',
    ) as HTMLButtonElement | null;
    expect(row).not.toBeNull();
    row!.click();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    await tick();

    expect(calls.map((c) => c.cmd)).not.toContain("ensure_company_home_channel");
    expect(calls.map((c) => c.cmd)).toContain("frontend_log");
  });
});
