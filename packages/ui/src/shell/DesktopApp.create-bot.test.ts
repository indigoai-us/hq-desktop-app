// @vitest-environment happy-dom

/**
 * local-bots: the sidebar "+" → New bot path, driven through the three-step
 * flow (kind → home → details). The host creates the bot through the desktop
 * adapter's `bots` group and opens its DM even before the intro message has
 * landed (synthetic row), so the user is never left staring at the modal.
 */
import { newBotKickoff } from "../chat/create-bot/create-bot-model.js";
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { WELCOME_SETUP_RUN_KEY } from "../chat/setup-channel.js";
import { createBotFlowDoor } from "./lazy-doors.js";

// The create modal preloads the New bot flow when it opens; load it once here
// so the flow paints in the same tick these tests click into it.
beforeAll(async () => {
  await createBotFlowDoor.load();
});

// Setup already ran on this "Mac": the setup bot must not start by itself here.
beforeEach(() => {
  window.localStorage?.setItem?.(WELCOME_SETUP_RUN_KEY, "1");
});

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
    identity: { hasFeature: async () => ok(false) },
    agents: {
      getProvisionOptions: async () => ok({
        defaultInstanceType: "t4g.medium",
        catalogVersion: "test",
        options: [{
          key: "basic",
          productName: "Basic",
          instanceType: "t4g.medium",
          listCents: 1200,
          default: true,
          selectable: true,
          netMonthlyCents: 1200,
          deltaCents: null,
          unavailableReason: null,
          notBilled: false,
          lanes: 1,
          workers: 1,
        }],
      }),
    },
    bots: {
      list: async () => ok({ bots: [] }),
      create: async () => ok({ ok: true, name: "assistant", agentUid: "agt_new" }),
      start: async () => ok({}),
      stop: async () => ok({}),
      remove: async () => ok({}),
      workers: async () =>
        ok({
          workers: [
            {
              id: "iris-cx",
              path: "companies/indigo/workers/iris-cx",
              company: "indigo",
              summary: "Answers customer questions.",
              skillCount: 3,
            },
          ],
        }),
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

function click(sel: string): void {
  const el = q<HTMLButtonElement>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  el.click();
}

function mountApp(adapterForTest: PlatformAdapter): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapterForTest,
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Test", email: "test@example.com" },
      coreFixtures: false,
    },
  });
}

/** "+" → New bot → the name → Local → the flow's coding tool step. */
async function openBotFlow(name = "assistant"): Promise<void> {
  await vi.waitFor(() => expect(host.querySelector('[data-testid="chat-new-message"]')).toBeTruthy());
  await settle();
  host.querySelector<HTMLButtonElement>('[data-testid="chat-new-message"]')!.click();
  await vi.waitFor(() => expect(q('[data-testid="chat-create-menu-agent"]')).toBeTruthy());
  click('[data-testid="chat-create-menu-agent"]');
  await settle();
  // "New bot" asks the name first, then "Where should it live?"; these are local bots.
  const input = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
  input.value = name;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  click('[data-testid="new-bot-continue-name"]');
  await settle();
  expect(q('[data-testid="new-bot-kind-choice"]')).toBeTruthy();
  click('[data-testid="new-bot-choice-local"]');
  await settle();
  // The name was given: the local steps open on the coding tool.
  expect(q('[data-testid="create-bot-runtime-section"]')).toBeTruthy();
}

describe("DesktopApp sidebar '+' → New bot", () => {
  it("creates through adapter.bots, opens the new bot's DM, and offers workers + signed-in runtimes", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "assistant", agentUid: "agt_new" }));
    mountApp(adapter({ create }));
    await openBotFlow("scout");

    // Local was picked already: no "Where does it run?" step. The coding
    // tool has its own step.
    expect(q('[data-testid="create-bot-home-step"]')).toBeNull();
    expect(q('[data-testid="create-bot-runtime-section"]')).toBeTruthy();
    // Runtime readiness came from preflight: Claude is signed in, Codex is not.
    expect(q('[data-testid="chat-bot-runtime-claude-status"]')?.textContent).toBe("Signed in");
    expect(q('[data-testid="chat-bot-runtime-codex-status"]')?.textContent).toBe("Sign in first");

    // The worker library came from adapter.bots.workers, on the Start from
    // step, with its summary; picking one says what it brings.
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="create-bot-next"]');
    await vi.waitFor(() => expect(q('[data-testid="create-bot-template-card"]')).toBeTruthy());
    const card = q<HTMLButtonElement>('[data-testid="create-bot-template-card"]')!;
    expect(card.dataset.template).toBe("iris-cx");
    expect(card.textContent).toContain("Answers customer questions.");
    card.click();
    await settle();
    expect(q('[data-testid="chat-bot-template-brings"]')?.textContent).toContain("3 skills");
    // Blank is all this test needs.
    click('[data-testid="create-bot-kind-blank"]');
    await settle();

    click('[data-testid="chat-bot-create"]');
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith({ name: "scout", runtime: "claude", autoApprove: true, kickoff: newBotKickoff() });
    await vi.waitFor(() => expect(q('[data-testid="chat-create-modal"]')).toBeNull());
    // The new bot's DM is the selected conversation.
    await vi.waitFor(() =>
      expect(
        host.querySelector('[data-conversation-id="dm:agt_new"][aria-current], [data-conversation-id="dm:agt_new"].selected, [data-testid="conversation-title"]')?.textContent ??
          host.textContent,
      ).toContain("scout"),
    );
    // A local bot runs with the person's own access: its thread greets and
    // never asks for a grant or shows the access card.
    await vi.waitFor(() => expect(host.textContent).toContain("Hi, I'm scout. I'll ask a few quick questions to finish my setup."));
    expect(q('[data-testid="share-request-card"]')).toBeNull();
    expect(host.textContent).not.toContain("grant me access");
    expect(host.textContent).not.toContain("Pick my skills");
  });

  it("surfaces the CLI's reason and keeps the modal open when creation fails", async () => {
    const create = vi.fn(async () => ({ ok: false as const, reason: "unavailable" as const, message: "You already have 3 local bots." }));
    mountApp(adapter({ create }));
    await openBotFlow();

    click('[data-testid="chat-bot-create"]');
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(q('[data-testid="chat-create-entry-error"]')?.textContent).toContain("already have 3"));
    // The flow stays put so the user can fix the draft and retry.
    expect(q('[data-testid="chat-create-modal"]')).toBeTruthy();
    expect(q('[data-testid="create-bot-runtime-section"]')).toBeTruthy();
  });
});
