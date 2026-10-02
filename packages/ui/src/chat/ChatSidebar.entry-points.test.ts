// @vitest-environment happy-dom

/**
 * Lifecycle entry points offered by the sidebar: "New company" / "New bot"
 * rows in the "+" modal and a "New company" row in the company switcher. The
 * sidebar never runs the server action itself — it calls the host callbacks
 * and either closes (success) or shows the reason inline (blocked).
 *
 * New Bot opens the cloud takeover when cloud creation is available. Local
 * creation retains its existing create-bot flow and is linked from there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type AgentProvisionOptionsView } from "@hq/platform";

import ChatSidebar from "./ChatSidebar.svelte";
import { createFixtureChatSidebarApi } from "../shell/fixtures.js";
import type { Workspace } from "./workspaces.js";
import type { EntryPointResult } from "./lifecycle-entry-points.js";
import { takePendingChannelOpen } from "./open-target.js";
import { takePendingConversation } from "./pending-conversation.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function workspace(slug: string, name: string, uid: string): Workspace {
  return {
    slug,
    displayName: name,
    kind: "company",
    state: "synced",
    cloudUid: uid,
    bucketName: null,
    hasLocalFolder: true,
    localPath: null,
    membershipStatus: "active",
    role: "member",
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
  };
}

const INDIGO = workspace("indigo", "Indigo", "cmp_indigo");
const ACME = workspace("acme", "Acme", "cmp_acme");

const seedDirectory = [
  {
    channelId: "hq-desktop",
    name: "hq-desktop",
    scope: "company",
    lastActivityAt: new Date().toISOString(),
  },
];

const okTarget: EntryPointResult = {
  ok: true,
  target: {
    channelId: "setup",
    cardId: "card_create_company_2",
    cardKind: null,
  },
};

const CLOUD_PROVISION_OPTIONS: AgentProvisionOptionsView = {
  defaultInstanceType: "t4g.medium",
  catalogVersion: "test",
  options: [
    {
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
    },
  ],
};

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

function click(selector: string): void {
  const el = q<HTMLButtonElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  el.click();
}

/** Kind step → Home step (Blank is preselected) for the unchanged local flow. */
async function toHomeStep(): Promise<void> {
  click('[data-testid="chat-create-new-bot"]');
  await settle();
  expect(q('[data-testid="create-bot-kind-step"]')).toBeTruthy();
  click('[data-testid="create-bot-next"]');
  await settle();
  expect(q('[data-testid="create-bot-home-step"]')).toBeTruthy();
}

function mountSidebar(props: Record<string, unknown>): void {
  component = mount(ChatSidebar, {
    target: host,
    props: {
      api: createFixtureChatSidebarApi(),
      seedDirectory,
      loadClaudeProviderFlag: async () => ok(false),
      loadCloudProvisionOptions: async () => ok(CLOUD_PROVISION_OPTIONS),
      ...props,
    },
  });
}

async function openModal(): Promise<void> {
  host
    .querySelector<HTMLButtonElement>('[data-testid="chat-new-message"]')!
    .click();
  await settle();
}

beforeEach(() => {
  window.localStorage?.clear?.();
  takePendingChannelOpen();
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document
    .querySelectorAll(
      '[data-testid="chat-create-modal"], [data-testid="chat-scope-menu"]',
    )
    .forEach((node) => node.remove());
  window.localStorage?.clear?.();
  takePendingChannelOpen();
});

describe("ChatSidebar lifecycle entry points", () => {
  it("hides the rows when the host provides no entry-point callbacks", async () => {
    mountSidebar({ companies: [INDIGO] });
    await settle();
    await openModal();
    expect(q('[data-testid="chat-create-modal"]')).toBeTruthy();
    expect(q('[data-testid="chat-create-entry-points"]')).toBeNull();
    expect(q('[data-testid="chat-create-new-company"]')).toBeNull();
    expect(q('[data-testid="chat-create-new-bot"]')).toBeNull();
  });

  it("New company calls the host and closes the modal on success", async () => {
    const oncreatecompany = vi.fn(async () => okTarget);
    mountSidebar({ companies: [INDIGO], oncreatecompany });
    await settle();
    await openModal();
    const row = q<HTMLButtonElement>('[data-testid="chat-create-new-company"]');
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("New company");
    row!.click();
    await settle(10);
    expect(oncreatecompany).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="chat-create-modal"]')).toBeNull();
    // Focus returns to the "+" control.
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "chat-new-message",
    );
  });

  it("New Bot in the plus menu opens the dark cloud takeover", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    mountSidebar({ companies: [INDIGO], oncreateagent });
    await settle();
    await openModal();
    const row = q<HTMLButtonElement>('[data-testid="chat-create-new-bot"]');
    expect(row?.textContent).toContain("New bot");
    row!.click();
    await settle();
    expect(q('[data-testid="chat-create-modal"]')).toBeNull();
    const takeover = q('[data-testid="new-bot-takeover"]');
    expect(takeover?.getAttribute("role")).toBe("dialog");
    expect(takeover?.getAttribute("aria-modal")).toBe("true");
    expect(takeover?.style.getPropertyValue("--new-bot-wallpaper")).toContain(
      "url(",
    );
    expect(takeover?.textContent).toContain("Enter a name");
    expect(q('[data-testid="new-bot-create-screen"]')).toBeTruthy();
    expect(takeover?.querySelectorAll(".new-bot-takeover-card").length).toBe(1);
    expect(oncreateagent).not.toHaveBeenCalled();
  });

  it("offers the upgrade card instead of a waking screen when the company's plan cannot host a bot", async () => {
    // Regression: the upgrade destination (a card, no bot) used to start the
    // Waking up screen for a bot that was never created.
    const oncreateagent = vi.fn(
      async (): Promise<EntryPointResult> => ({
        ok: true,
        target: { channelId: "chn_indigo", cardId: "upgrade_plan", cardKind: null },
      }),
    );
    const opened: Array<Record<string, unknown>> = [];
    const onOpen = (event: Event) => {
      opened.push((event as CustomEvent).detail as Record<string, unknown>);
    };
    window.addEventListener("hq:open-channel", onOpen);
    try {
      mountSidebar({ companies: [INDIGO], oncreateagent });
      await settle();
      await openModal();
      click('[data-testid="chat-create-new-bot"]');
      await settle();
      const name = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
      name.value = "Nova";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
      click('[data-testid="new-bot-continue-name"]');
      await settle();
      click('[data-testid="new-bot-create-submit"]');
      await settle();

      expect(q('[data-testid="new-bot-waking-screen"]')).toBeNull();
      expect(q('[data-testid="chat-waking-bot-ring"]')).toBeNull();
      const upgrade = q<HTMLElement>('[data-testid="new-bot-upgrade"]');
      expect(upgrade?.textContent).toContain("Starter plan");
      expect(upgrade?.textContent).toContain("create Nova");

      click('[data-testid="new-bot-upgrade-open"]');
      await settle();
      expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
      // The sidebar's own boot-time open is `automatic`; only the person's is not.
      const asked = opened.filter((detail) => detail.automatic !== true);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({
        channelId: "chn_indigo",
        companyUid: "cmp_indigo",
        focusCardId: "upgrade_plan",
      });
    } finally {
      window.removeEventListener("hq:open-channel", onOpen);
    }
  });

  it("reopens the current waking progress when its sidebar bot is clicked after close", async () => {
    const oncreateagent = vi.fn(
      async (): Promise<EntryPointResult> => ({
        ok: true,
        target: {
          channelId: "chn_nova",
          cardId: null,
          cardKind: null,
          agentUid: "agt_nova",
        },
      }),
    );
    mountSidebar({
      companies: [INDIGO],
      oncreateagent,
      loadAgentStatus: async () => ({
        ok: true,
        value: { setupState: { phase: "creating" } },
      }),
    });
    await settle();
    await openModal();
    click('[data-testid="chat-create-new-bot"]');
    await settle();

    const name = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
    name.value = "Nova";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    click('[data-testid="new-bot-continue-name"]');
    await settle();
    click('[data-testid="new-bot-create-submit"]');
    await settle();

    const beforeClose = q<HTMLElement>('[data-testid="new-bot-waking-ring"]');
    expect(beforeClose?.getAttribute("aria-valuenow")).toBe("8");
    click('[data-testid="new-bot-waking-close"]');
    await settle();
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();

    // The bot's row is its direct message, and the channel an older server
    // made for it never shows.
    expect(q('[data-conversation-id="ch:chn_nova"]')).toBeNull();
    const sidebarBot = q<HTMLButtonElement>(
      '[data-conversation-id="dm:agt_nova"]',
    );
    const sidebarRing = q<HTMLElement>('[data-testid="chat-waking-bot-ring"]');
    expect(sidebarBot?.textContent).toContain("Nova");
    expect(sidebarRing?.style.getPropertyValue("--chat-waking-progress")).toBe(
      "8%",
    );
    sidebarBot!.click();
    await settle();

    expect(q('[data-testid="new-bot-waking-screen"]')?.textContent).toContain(
      "Waking up Nova",
    );
    expect(
      q('[data-testid="new-bot-waking-ring"]')?.getAttribute("aria-valuenow"),
    ).toBe("8");
  });

  it("opens the bot's direct message after the live handoff, never a channel", async () => {
    // Regression (owner walkthrough 2026-10-02): the hand-off landed in a
    // "team channel" where the bot answered in threads. "See how sheister
    // replies in a DM? That's the flow we want."
    vi.useFakeTimers();
    try {
      const oncreateagent = vi.fn(
        async (): Promise<EntryPointResult> => ({
          ok: true,
          target: {
            channelId: "chn_nova",
            cardId: null,
            cardKind: null,
            agentUid: "agt_nova",
          },
        }),
      );
      mountSidebar({
        companies: [INDIGO],
        seedDirectory: [],
        oncreateagent,
        loadAgentStatus: async () => ({
          ok: true,
          value: { setupState: { phase: "ready" } },
        }),
      });
      await settle();
      await openModal();
      click('[data-testid="chat-create-new-bot"]');
      await settle();

      const name = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
      name.value = "Nova";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
      click('[data-testid="new-bot-continue-name"]');
      await settle();
      click('[data-testid="new-bot-create-submit"]');
      await settle(10);

      await vi.advanceTimersByTimeAsync(350);
      await settle();

      expect(takePendingConversation()).toMatchObject({
        personUid: "agt_nova",
        displayName: "Nova",
      });
      expect(takePendingChannelOpen()?.channelId).not.toBe("chn_nova");
      expect(q('[data-testid="new-bot-waking-screen"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Cancel returns to the prior create surface", async () => {
    mountSidebar({ companies: [INDIGO], oncreateagent: async () => okTarget });
    await settle();
    await openModal();
    click('[data-testid="chat-create-new-bot"]');
    await settle();
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    expect(q('[data-testid="chat-create-modal"]')).toBeTruthy();
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "chat-create-query",
    );
  });

  it("links to the unchanged local creation flow from the takeover", async () => {
    const oncreatebot = vi.fn(async () => ({
      ok: true as const,
      agentUid: "agt_new",
      name: "assistant",
    }));
    mountSidebar({
      companies: [INDIGO],
      oncreateagent: async () => okTarget,
      oncreatebot,
    });
    await settle();
    await openModal();
    click('[data-testid="chat-create-new-bot"]');
    await settle();
    click('[data-testid="new-bot-takeover-local"]');
    await settle();
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    expect(q('[data-testid="create-bot-kind-step"]')).toBeTruthy();
    expect(oncreatebot).not.toHaveBeenCalled();
  });

  it("the company switcher ends with a New company row that runs the same flow", async () => {
    const oncreatecompany = vi.fn(async () => okTarget);
    mountSidebar({ companies: [INDIGO, ACME], oncreatecompany });
    await settle();
    host
      .querySelector<HTMLButtonElement>('[data-testid="chat-scope-pill"]')!
      .click();
    await settle();
    const menu = q('[data-testid="chat-scope-menu"]');
    expect(menu).toBeTruthy();
    const rows = Array.from(menu!.querySelectorAll("button"));
    const last = rows.at(-1);
    expect(last?.getAttribute("data-testid")).toBe("chat-scope-new-company");
    expect(last?.getAttribute("role")).toBe("menuitem");
    expect(last?.textContent).toContain("New company");
    last!.click();
    await settle(10);
    expect(oncreatecompany).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="chat-scope-menu"]')).toBeNull();
  });

  it("the switcher row shows a failure reason inline and stays open", async () => {
    const oncreatecompany = vi.fn(
      async (): Promise<EntryPointResult> => ({
        ok: false,
        reason: "Cloud is unreachable",
        blocked: false,
      }),
    );
    mountSidebar({ companies: [INDIGO], oncreatecompany });
    await settle();
    host
      .querySelector<HTMLButtonElement>('[data-testid="chat-scope-pill"]')!
      .click();
    await settle();
    q<HTMLButtonElement>('[data-testid="chat-scope-new-company"]')!.click();
    await settle(10);
    expect(q('[data-testid="chat-scope-menu"]')).toBeTruthy();
    expect(
      q('[data-testid="chat-scope-new-company-error"]')?.textContent,
    ).toContain("Cloud is unreachable");
  });

  it("omits the switcher row without a host callback", async () => {
    mountSidebar({ companies: [INDIGO] });
    await settle();
    host
      .querySelector<HTMLButtonElement>('[data-testid="chat-scope-pill"]')!
      .click();
    await settle();
    expect(q('[data-testid="chat-scope-menu"]')).toBeTruthy();
    expect(q('[data-testid="chat-scope-new-company"]')).toBeNull();
  });
});

describe("ChatSidebar 'New bot' entry point (local bots)", () => {
  it("hides the row when the host has no local bots", async () => {
    mountSidebar({ companies: [INDIGO] });
    await settle();
    await openModal();
    expect(q('[data-testid="chat-create-new-bot"]')).toBeNull();
  });

  it("walks kind → home → details and submits name, runtime, and pre-approval to the host", async () => {
    const oncreatebot = vi.fn(async () => ({
      ok: true as const,
      agentUid: "agt_new",
      name: "assistant",
    }));
    mountSidebar({ companies: [INDIGO], oncreatebot });
    await settle();
    await openModal();
    const plus = q<HTMLButtonElement>('[data-testid="chat-new-message"]');
    expect(plus?.getAttribute("aria-label")).toBe(
      "New message, channel, company, or bot",
    );
    const row = q<HTMLButtonElement>('[data-testid="chat-create-new-bot"]');
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("Runs on this computer");
    await toHomeStep();
    // Only a local host here → Local is checked and Cloud is not offered at all.
    expect(
      q<HTMLButtonElement>(
        '[data-testid="chat-bot-where-local"]',
      )?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(q('[data-testid="chat-bot-where-cloud"]')).toBeNull();
    click('[data-testid="chat-bot-runtime-grok"]');
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="create-bot-details-step"]')).toBeTruthy();
    const name = q<HTMLInputElement>('[data-testid="chat-bot-name"]')!;
    expect(name.value).toBe("assistant");
    expect(q('[data-testid="bot-preview-name"]')?.textContent).toBe(
      "assistant",
    );
    expect(q('[data-testid="bot-preview-thinks"]')?.textContent).toBe(
      "thinks with Grok",
    );
    click('[data-testid="chat-bot-create"]');
    await settle(10);
    expect(oncreatebot).toHaveBeenCalledWith(
      { name: "assistant", runtime: "grok", autoApprove: true },
      {},
    );
    expect(q('[data-testid="chat-create-modal"]')).toBeNull();
  });

  it("shows the host's reason inline and stays open when creation fails", async () => {
    const oncreatebot = vi.fn(async () => ({
      ok: false as const,
      reason: "Claude Code is not signed in.",
    }));
    mountSidebar({ companies: [INDIGO], oncreatebot });
    await settle();
    await openModal();
    click('[data-testid="chat-create-new-bot"]');
    await settle();
    // ⌘↵ creates from the first step once the draft is complete.
    q('[data-testid="chat-create-bot-step"]')!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
      }),
    );
    await settle(10);
    expect(oncreatebot).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="chat-create-entry-error"]')?.textContent).toContain(
      "not signed in",
    );
    expect(q('[data-testid="chat-create-modal"]')).toBeTruthy();
    expect(q('[data-testid="chat-create-bot-step"]')).toBeTruthy();
  });

  it("takes a free-form name, blocks a taken handle, gates on a signed-in runtime, and never caps the bot count", async () => {
    const oncreatebot = vi.fn(async () => ({
      ok: true as const,
      agentUid: "agt_new",
      name: "x",
    }));
    // No per-person limit: the row stays enabled no matter how many bots exist.
    mountSidebar({ companies: [INDIGO], oncreatebot });
    await settle();
    await openModal();
    const row = q<HTMLButtonElement>('[data-testid="chat-create-new-bot"]')!;
    expect(row.disabled).toBe(false);
    expect(row.textContent).not.toContain("Limit");
    await unmount(component!);
    component = null;
    mountSidebar({
      companies: [INDIGO],
      oncreatebot,
      botRuntimeReady: { claude: false, codex: true, grok: true },
      existingBotNames: ["scout"],
    });
    await settle();
    await openModal();
    await toHomeStep();
    // Claude is not signed in → the first signed-in runtime (Codex) is preselected.
    expect(
      q<HTMLButtonElement>(
        '[data-testid="chat-bot-runtime-codex"]',
      )?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      q<HTMLButtonElement>('[data-testid="chat-bot-runtime-claude"]')!
        .textContent,
    ).toContain("not signed in");
    click('[data-testid="chat-bot-runtime-claude"]');
    await settle();
    expect(
      q<HTMLButtonElement>('[data-testid="create-bot-next"]')!.disabled,
    ).toBe(true);
    expect(q('[data-testid="create-bot-issue"]')?.textContent).toContain(
      "Claude Code is not signed in",
    );
    click('[data-testid="chat-bot-runtime-codex"]');
    await settle();
    expect(
      q<HTMLButtonElement>('[data-testid="create-bot-next"]')!.disabled,
    ).toBe(false);
    click('[data-testid="create-bot-next"]');
    await settle();
    const name = q<HTMLInputElement>('[data-testid="chat-bot-name"]')!;
    // Spaces and capitals are a display name now, not an error.
    name.value = "Dr Love";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(
      q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled,
    ).toBe(false);
    expect(q('[data-testid="chat-bot-derived-handle"]')?.textContent).toBe(
      "@dr-love",
    );
    // An emoji-only name has nothing to slugify: the handle is what blocks.
    name.value = "🚀";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(
      q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled,
    ).toBe(true);
    expect(q('[data-testid="chat-bot-name-help"]')?.textContent).toContain(
      "no letters or digits",
    );
    // The handle field opens on its own so the block is fixable in place.
    const handle = q<HTMLInputElement>('[data-testid="chat-bot-handle"]')!;
    handle.value = "rocket";
    handle.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(
      q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled,
    ).toBe(false);
    handle.value = "";
    handle.dispatchEvent(new Event("input", { bubbles: true }));
    name.value = "Scout";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(
      q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled,
    ).toBe(true);
    expect(q('[data-testid="chat-bot-name-help"]')?.textContent).toContain(
      "handle @scout",
    );
    // A free name clears the block.
    name.value = "assistant";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(
      q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled,
    ).toBe(false);
    expect(oncreatebot).not.toHaveBeenCalled();
  });
});

describe("ChatSidebar offers the user's local bots in the '+' modal", () => {
  it("finds a local bot by name even though the contacts roster omits it", async () => {
    mountSidebar({
      companies: [INDIGO],
      localBots: [
        {
          name: "scout",
          agentUid: "agt_01SCOUT",
          ownerUid: "prs_me",
          runtime: "claude",
          state: "running",
          pid: 1,
          processAlive: true,
          online: true,
          lastHeartbeatAt: null,
          daemonInstalled: true,
          daemonLoaded: true,
          dir: "/tmp/scout",
        },
      ],
    });
    await settle();
    await openModal();
    const query = q<HTMLInputElement>('[data-testid="chat-create-query"]')!;
    query.value = "scout";
    query.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(30);
    await vi.waitFor(() =>
      expect(q('[data-testid="chat-create-modal"]')?.textContent).toContain(
        "scout",
      ),
    );
  });
});

describe("ChatSidebar company switcher — in-modal company creation", () => {
  const companyCreate = {
    open: async () => ({
      ok: true as const,
      form: {
        channelId: "setup",
        cardId: "card_create_company_2",
        title: "Name your company",
        summary: null,
        actionId: "submit",
        nameFieldId: "name",
        fields: [
          {
            id: "name",
            label: "Company name",
            control: "text" as const,
            options: [],
            value: "",
            required: true,
            error: null,
            hint: null,
            description: null,
          },
        ],
      },
    }),
    submit: async () => ({
      ok: true as const,
      company: {
        companyUid: "cmp_new",
        companyChannelId: "chn_new",
        inviteFailures: [],
      },
    }),
  };

  it("opens the create modal on its company step instead of #setup", async () => {
    const oncreatecompany = vi.fn(async () => okTarget);
    mountSidebar({ companies: [INDIGO, ACME], oncreatecompany, companyCreate });
    await settle();
    host
      .querySelector<HTMLButtonElement>('[data-testid="chat-scope-pill"]')!
      .click();
    await settle();
    click('[data-testid="chat-scope-new-company"]');
    await settle(10);
    expect(q('[data-testid="chat-create-company-step"]')).toBeTruthy();
    expect(
      q<HTMLInputElement>('[data-testid="chat-create-company-field-name"]')
        ?.value,
    ).toBe("");
    expect(oncreatecompany).not.toHaveBeenCalled();
  });
});
