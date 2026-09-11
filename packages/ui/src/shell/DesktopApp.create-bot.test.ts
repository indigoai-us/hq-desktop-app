// @vitest-environment happy-dom

/**
 * local-bots: the sidebar "+" → New bot path. The host creates the bot through
 * the desktop adapter's `bots` group and opens its DM even before the intro
 * message has landed (synthetic row), so the user is never left staring at
 * the modal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";

function adapter(bots: Partial<NonNullable<PlatformAdapter["bots"]>>): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ({ ok: false as const, reason: "unavailable" }),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
    },
    settings: {
      getSetupStatus: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
    },
    sessions: {
      preflight: async () => ok({ claudeAvailable: true, claudeLoggedIn: true, codexAvailable: false, codexLoggedIn: false, grokAvailable: true, grokLoggedIn: false }),
    },
    bots: {
      list: async () => ok({ bots: [] }),
      create: async () => ok({ ok: true, name: "assistant", agentUid: "agt_new" }),
      start: async () => ok({}),
      stop: async () => ok({}),
      remove: async () => ok({}),
      workers: async () => ok({ workers: [{ id: "iris-cx", path: "companies/indigo/workers/iris-cx", company: "indigo" }] }),
      ...bots,
    },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document.querySelectorAll('[data-testid="chat-create-modal"]').forEach((n) => n.remove());
});

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return document.querySelector<T>(sel);
}

describe("DesktopApp sidebar '+' → New bot", () => {
  it("creates through adapter.bots, opens the new bot's DM, and offers workers + signed-in runtimes", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "assistant", agentUid: "agt_new" }));
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: adapter({ create }),
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: createEmptyNotificationsApi(),
        self: { uid: "prs_test", displayName: "Test", email: "test@example.com" },
        coreFixtures: false,
      },
    });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="chat-new-message"]')).toBeTruthy());
    await settle();
    host.querySelector<HTMLButtonElement>('[data-testid="chat-new-message"]')!.click();
    await vi.waitFor(() => expect(q('[data-testid="chat-create-new-bot"]')).toBeTruthy());
    q<HTMLButtonElement>('[data-testid="chat-create-new-bot"]')!.click();
    await settle();
    expect(q('[data-testid="chat-create-bot-step"]')).toBeTruthy();
    // Runtime readiness came from preflight; workers from adapter.bots.workers.
    await vi.waitFor(() => expect(q('[data-testid="chat-bot-runtime-codex"]')?.textContent).toContain("not signed in"));
    await vi.waitFor(() => expect(q<HTMLSelectElement>('[data-testid="chat-bot-worker"]')).toBeTruthy());
    const worker = q<HTMLSelectElement>('[data-testid="chat-bot-worker"]')!;
    const option = Array.from(worker.options).find((o) => o.value === "iris-cx")!;
    expect(option).toBeTruthy();
    worker.selectedIndex = option.index;
    option.selected = true;
    worker.dispatchEvent(new Event("input", { bubbles: true }));
    worker.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(worker.value).toBe("iris-cx");
    q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.click();
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith({ name: "assistant", runtime: "claude", autoApprove: true, worker: "iris-cx" });
    await vi.waitFor(() => expect(q('[data-testid="chat-create-modal"]')).toBeNull());
    // The new bot's DM is the selected conversation.
    await vi.waitFor(() =>
      expect(host.querySelector('[data-conversation-id="dm:agt_new"][aria-current], [data-conversation-id="dm:agt_new"].selected, [data-testid="conversation-title"]')?.textContent ?? host.textContent).toContain("assistant"),
    );
  });

  it("surfaces the CLI's reason and keeps the modal open when creation fails", async () => {
    const create = vi.fn(async () => ({ ok: false as const, reason: "unavailable" as const, message: "You already have 3 local bots." }));
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: adapter({ create }),
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: createEmptyNotificationsApi(),
        self: { uid: "prs_test", displayName: "Test", email: "test@example.com" },
        coreFixtures: false,
      },
    });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="chat-new-message"]')).toBeTruthy());
    await settle();
    host.querySelector<HTMLButtonElement>('[data-testid="chat-new-message"]')!.click();
    await vi.waitFor(() => expect(q('[data-testid="chat-create-new-bot"]')).toBeTruthy());
    q<HTMLButtonElement>('[data-testid="chat-create-new-bot"]')!.click();
    await settle();
    q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.click();
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(q('[data-testid="chat-create-entry-error"]')?.textContent).toContain("already have 3"));
    expect(q('[data-testid="chat-create-modal"]')).toBeTruthy();
  });
});
