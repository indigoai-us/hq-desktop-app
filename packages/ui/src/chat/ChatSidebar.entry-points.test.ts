// @vitest-environment happy-dom

/**
 * Lifecycle entry points offered by the sidebar: "New company" / "New bot"
 * rows in the "+" modal and a "New company" row in the company switcher. The
 * sidebar never runs the server action itself — it calls the host callbacks
 * and either closes (success) or shows the reason inline (blocked).
 *
 * Every AI teammate is a bot. One "New bot" row opens the create-bot flow
 * (kind → home → details); the Home step picks Local (this Mac) or Cloud
 * (company bot, today's create-agent team action).
 *
 * The full-window New Bot takeover replaces that flow only when the host
 * read the `agents.desktop-agent-creation` flag as on for at least one
 * company (`newBotCompanyUids`), and it lists only those companies. Local
 * creation keeps the create-bot flow and is linked from the takeover.
 */
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type AgentProvisionOptionsView } from "@hq/platform";

import ChatSidebar from "./ChatSidebar.svelte";
import { createFixtureChatSidebarApi } from "../shell/fixtures.js";
import type { Workspace } from "./workspaces.js";
import type { EntryPointResult } from "./lifecycle-entry-points.js";
import { createBotFlowDoor } from "../shell/lazy-doors.js";
import { takePendingChannelOpen } from "./open-target.js";
import { takePendingConversation } from "./pending-conversation.js";

// These flows press ⌘↵: run them as the Mac host the app ships on, so the
// platform's own create chord (OWNER-D 8) is Command, not Control.
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15";
const priorUserAgent = navigator.userAgent;
beforeAll(() => Object.defineProperty(navigator, "userAgent", { configurable: true, value: MAC_UA }));
afterAll(() => Object.defineProperty(navigator, "userAgent", { configurable: true, value: priorUserAgent }));


// The create modal preloads the New bot flow when it opens; load it once here
// so the flow paints in the same tick these tests click into it.
beforeAll(async () => {
  await createBotFlowDoor.load();
});

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

/**
 * The "+" modal's own cloud create, for tests that drive the takeover. The
 * takeover has its own create (`oncreatenewbot`) and must never run this one.
 */
const modalCreate = vi.fn(async (): Promise<EntryPointResult> => okTarget);

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

/**
 * "New bot" asks "Cloud or Local?" first, inside the full-window takeover.
 * Pick one; the rest of the flow follows from that answer.
 */
async function chooseKind(kind: "cloud" | "local"): Promise<void> {
  expect(q('[data-testid="new-bot-takeover"]')).toBeTruthy();
  expect(q('[data-testid="new-bot-kind-choice"]')).toBeTruthy();
  const option = q<HTMLButtonElement>(`[data-testid="new-bot-choice-${kind}"]`);
  expect(option?.disabled).toBe(false);
  option!.click();
  await settle();
}

/** Choice → Kind step → Home step (Blank is preselected) of the "+" window's bot flow. */
/**
 * Choice (Local) → Kind step → Details. Local was picked already, so the
 * "Where does it run?" step is skipped and its coding-tool picker is on Details.
 */
async function toLocalDetails(): Promise<void> {
  click('[data-testid="chat-create-new-bot"]');
  await settle();
  await chooseKind("local");
  expect(q('[data-testid="create-bot-kind-step"]')).toBeTruthy();
  click('[data-testid="create-bot-next"]');
  await settle();
  expect(q('[data-testid="create-bot-home-step"]')).toBeNull();
  expect(q('[data-testid="create-bot-details-step"]')).toBeTruthy();
  expect(q('[data-testid="create-bot-runtime-section"]')).toBeTruthy();
}

async function toHomeStep(kind: "cloud" | "local" = "cloud"): Promise<void> {
  click('[data-testid="chat-create-new-bot"]');
  await settle();
  await chooseKind(kind);
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
  (component as unknown as { openCreateChannel: () => void }).openCreateChannel();
  await settle();
}

beforeEach(() => {
  window.localStorage?.clear?.();
  takePendingChannelOpen();
  modalCreate.mockClear();
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

  // ── The "+" modal's Cloud option (main's flow) ──────────────────────────
  // No company has the New Bot flag here: `newBotCompanyUids` is not passed,
  // which is what a host shows before it has an answer and when it has none.

  it("New bot with only Cloud available opens on Cloud and creates in the one company", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    mountSidebar({ companies: [INDIGO], oncreateagent });
    await settle();
    await openModal();
    const row = q<HTMLButtonElement>('[data-testid="chat-create-new-bot"]');
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("New bot");
    expect(row?.textContent).toContain("Indigo");
    await toHomeStep();
    // No local runtime on this host → Local is disabled and Cloud is preselected.
    const local = q<HTMLButtonElement>('[data-testid="chat-bot-where-local"]');
    const cloud = q<HTMLButtonElement>('[data-testid="chat-bot-where-cloud"]');
    expect(local?.disabled).toBe(true);
    expect(cloud?.getAttribute("aria-checked")).toBe("true");
    // One company → no picker; the details step then names the bot, because
    // the company channel's card that used to ask is not shown any more.
    expect(q('[data-testid="chat-create-agent-picker"]')).toBeNull();
    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="create-bot-cloud-details-step"]')).toBeTruthy();
    const create = q<HTMLButtonElement>('[data-testid="chat-bot-create"]');
    expect(create?.textContent).toContain("Create in Indigo");
    create!.click();
    await settle(10);
    expect(oncreateagent).toHaveBeenCalledWith("cmp_indigo", {
      name: expect.stringMatching(/\S/),
      handle: expect.stringMatching(/\S/),
      runtime: "codex",
      size: "basic",
    });
    expect(q('[data-testid="chat-create-modal"]')).toBeNull();
  });

  it("passes the Title typed on the Cloud details step through to the host", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    mountSidebar({ companies: [INDIGO], oncreateagent });
    await settle();
    await openModal();
    await toHomeStep();
    click('[data-testid="create-bot-next"]');
    await settle();
    const name = q<HTMLInputElement>('[data-testid="chat-bot-name"]')!;
    name.value = "Polar";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    const title = q<HTMLInputElement>('[data-testid="chat-bot-title"]')!;
    title.value = "Ad account analyst";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    click('[data-testid="chat-bot-create"]');
    await settle(10);
    expect(oncreateagent).toHaveBeenCalledWith("cmp_indigo", {
      name: "Polar",
      handle: "polar",
      title: "Ad account analyst",
      runtime: "codex",
      size: "basic",
    });
  });

  it("offers a company the directory knows before the workspace list refreshes", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    const directoryRow = {
      channelId: "chn_ramen_bae",
      name: "ramen-bae",
      scope: "company",
      type: "chat",
      companyUid: "cmp_ramen_bae",
      companyName: "Ramen Bae",
      lastActivityAt: new Date().toISOString(),
      unreadCount: 0,
      memberCount: 2,
    };
    const api = {
      ...createFixtureChatSidebarApi(),
      fetchChannelDirectory: async () => ({
        contractVersion: 2,
        snapshot: true,
        cursor: "entry-points-cursor",
        cursorExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        rows: [directoryRow],
      }),
    } as unknown as ReturnType<typeof createFixtureChatSidebarApi>;
    mountSidebar({ api, companies: [], oncreateagent, seedDirectory: [directoryRow] });
    await settle();
    await openModal();
    const row = q<HTMLButtonElement>('[data-testid="chat-create-new-bot"]');
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("Ramen Bae");
    await toHomeStep();
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="chat-bot-create"]');
    await settle(10);
    expect(oncreateagent).toHaveBeenCalledWith("cmp_ramen_bae", {
      name: expect.stringMatching(/\S/),
      handle: expect.stringMatching(/\S/),
      runtime: "codex",
      size: "basic",
    });
  });

  it("Cloud with several companies shows the company picker, keyboard included, and Create uses the pick", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    const oncreatebot = vi.fn(async () => ({ ok: true as const, agentUid: "agt_new", name: "assistant" }));
    mountSidebar({ companies: [INDIGO, ACME], oncreateagent, oncreatebot });
    await settle();
    await openModal();
    const row = q<HTMLButtonElement>('[data-testid="chat-create-new-bot"]');
    expect(row?.textContent).toContain("Runs on this computer or in the cloud");
    // Cloud picked on the "Cloud or Local?" question: the Home step shows
    // the company picker, and Local is still offered beside it.
    await toHomeStep("cloud");
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-where-cloud"]')?.getAttribute("aria-checked")).toBe("true");
    expect(q('[data-testid="chat-bot-where-local"]')).toBeTruthy();
    expect(oncreateagent).not.toHaveBeenCalled();
    const picker = q('[data-testid="chat-create-agent-picker"]');
    expect(picker?.getAttribute("role")).toBe("listbox");
    expect(picker?.getAttribute("aria-label")).toBe("Add a bot to which company?");
    const options = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="chat-create-agent-company"]',
      ),
    );
    expect(options.map((o) => o.dataset.company)).toEqual(["cmp_indigo", "cmp_acme"]);
    // Company rows go through CompanyLabel: with no favicon, a two-letter
    // initials badge sits before the name.
    expect(
      options.map((o) => [
        o.querySelector('[data-testid="company-label-initials"]')?.textContent,
        o.querySelector(".company-label-name")?.textContent,
      ]),
    ).toEqual([
      ["IN", "Indigo"],
      ["AC", "Acme"],
    ]);
    // First company is preselected.
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["true", "false"]);

    // Arrow keys move between the company rows.
    options[0]!.focus();
    picker!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(options[1]);

    options[1]!.click();
    await settle();
    expect(oncreateagent).not.toHaveBeenCalled();
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="chat-bot-create"]')?.textContent).toContain("Create in Acme");
    click('[data-testid="chat-bot-create"]');
    await settle(10);
    expect(oncreateagent).toHaveBeenCalledWith("cmp_acme", {
      name: expect.stringMatching(/\S/),
      handle: expect.stringMatching(/\S/),
      runtime: "codex",
      size: "basic",
    });
    expect(oncreatebot).not.toHaveBeenCalled();
    expect(q('[data-testid="chat-create-modal"]')).toBeNull();
  });

  it("shows a blocked reason inline in the bot step and keeps the modal open", async () => {
    const oncreateagent = vi.fn(
      async (): Promise<EntryPointResult> => ({
        ok: false,
        reason: "Only owners can add agents.",
        blocked: true,
      }),
    );
    mountSidebar({ companies: [INDIGO, ACME], oncreateagent });
    await settle();
    await openModal();
    await toHomeStep();
    document
      .querySelector<HTMLButtonElement>('[data-company="cmp_acme"]')!
      .click();
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="chat-bot-create"]');
    await settle(10);
    expect(oncreateagent).toHaveBeenCalledWith("cmp_acme", {
      name: expect.stringMatching(/\S/),
      handle: expect.stringMatching(/\S/),
      runtime: "codex",
      size: "basic",
    });
    expect(q('[data-testid="chat-create-modal"]')).toBeTruthy();
    expect(q('[data-testid="chat-create-bot-step"]')).toBeTruthy();
    const error = q('[data-testid="chat-create-entry-error"]');
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toContain("Only owners can add agents.");
  });

  // ── The full-window New Bot takeover ───────────────────────────────────

  it("New Bot in the plus menu opens the dark cloud takeover", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    const oncreatenewbot = vi.fn(async () => okTarget);
    mountSidebar({
      companies: [INDIGO],
      oncreateagent,
      oncreatenewbot,
      newBotCompanyUids: ["cmp_indigo"],
    });
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
    // The first screen asks where the bot runs; Cloud leads to the name step.
    expect(takeover?.textContent).toContain("Where should it run?");
    expect(q('[data-testid="new-bot-create-screen"]')).toBeNull();
    await chooseKind("cloud");
    expect(takeover?.textContent).toContain("Enter a name");
    expect(q('[data-testid="new-bot-create-screen"]')).toBeTruthy();
    expect(takeover?.querySelectorAll(".new-bot-takeover-card").length).toBe(1);
    expect(oncreateagent).not.toHaveBeenCalled();
    expect(oncreatenewbot).not.toHaveBeenCalled();
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
      mountSidebar({
        companies: [INDIGO],
        // The modal's own create is a different function and stays unused.
        oncreateagent: modalCreate,
        oncreatenewbot: oncreateagent,
        newBotCompanyUids: ["cmp_indigo"],
      });
      await settle();
      await openModal();
      click('[data-testid="chat-create-new-bot"]');
      await settle();
      await chooseKind("cloud");
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
      expect(oncreateagent).toHaveBeenCalledTimes(1);
      expect(modalCreate).not.toHaveBeenCalled();
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
      // The modal's own create is a different function and stays unused.
      oncreateagent: modalCreate,
      oncreatenewbot: oncreateagent,
      newBotCompanyUids: ["cmp_indigo"],
      loadAgentStatus: async () => ({
        ok: true,
        value: { setupState: { phase: "creating" } },
      }),
    });
    await settle();
    await openModal();
    click('[data-testid="chat-create-new-bot"]');
    await settle();
    await chooseKind("cloud");

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
    expect(oncreateagent).toHaveBeenCalledTimes(1);
    expect(modalCreate).not.toHaveBeenCalled();
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
        // The modal's own create is a different function and stays unused.
        oncreateagent: modalCreate,
        oncreatenewbot: oncreateagent,
        newBotCompanyUids: ["cmp_indigo"],
        loadAgentStatus: async () => ({
          ok: true,
          value: { setupState: { phase: "ready" } },
        }),
      });
      await settle();
      await openModal();
      click('[data-testid="chat-create-new-bot"]');
      await settle();
      await chooseKind("cloud");

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
      expect(modalCreate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Cancel returns to the prior create surface", async () => {
    mountSidebar({
      companies: [INDIGO],
      oncreateagent: async () => okTarget,
      oncreatenewbot: async () => okTarget,
      newBotCompanyUids: ["cmp_indigo"],
    });
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
      oncreatenewbot: async () => okTarget,
      newBotCompanyUids: ["cmp_indigo"],
      oncreatebot,
    });
    await settle();
    await openModal();
    click('[data-testid="chat-create-new-bot"]');
    await settle();
    await chooseKind("cloud");
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

  it("the switcher row shows plain copy, not raw text, when the callback throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = new Error('[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}');
    const oncreatecompany = vi.fn(async (): Promise<EntryPointResult> => {
      throw raw;
    });
    mountSidebar({ companies: [INDIGO], oncreatecompany });
    await settle();
    host.querySelector<HTMLButtonElement>('[data-testid="chat-scope-pill"]')!.click();
    await settle();
    q<HTMLButtonElement>('[data-testid="chat-scope-new-company"]')!.click();
    await settle(10);
    const error = q('[data-testid="chat-scope-new-company-error"]');
    expect(error?.textContent).toContain("Could not start a new company. Try again.");
    expect(document.body.textContent).not.toContain("boom");
    expect(error?.getAttribute("title") ?? "").not.toContain("boom");
    expect(warn).toHaveBeenCalledWith("[chat-sidebar] new company failed", raw);
    warn.mockRestore();
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

/**
 * The full-window New Bot flow is for companies with the
 * `agents.desktop-agent-creation` flag, and for no other. The host reads the
 * flag and hands the answer down as `newBotCompanyUids`.
 */
describe("ChatSidebar New Bot takeover: only for companies with the flag", () => {
  const GLOBEX = workspace("globex", "Globex", "cmp_globex");

  /** Type a name in the takeover and move past its first step. */
  async function nameTakeoverBot(name: string): Promise<void> {
    const field = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
    field.value = name;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    click('[data-testid="new-bot-continue-name"]');
    await settle();
  }

  /** The company grid's uids, in order. */
  function takeoverCompanyUids(): string[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid="new-bot-company-grid"] [data-company-uid]',
      ),
    ).map((el) => el.dataset.companyUid ?? "");
  }

  it("with no flagged company, Cloud on the choice opens the in-modal step in the takeover shell", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    const oncreatenewbot = vi.fn(async () => okTarget);
    mountSidebar({
      companies: [INDIGO, ACME],
      oncreateagent,
      oncreatenewbot,
      newBotCompanyUids: [],
    });
    await settle();
    await openModal();
    click('[data-testid="chat-create-new-bot"]');
    await settle();
    await chooseKind("cloud");

    // The "+" window's own bot flow, worn in the takeover shell.
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    expect(q('[data-testid="chat-create-modal"]')?.getAttribute("data-sunrise")).toBe("true");
    expect(q('[data-testid="chat-create-bot-step"]')).toBeTruthy();
    expect(q('[data-testid="create-bot-kind-step"]')).toBeTruthy();

    // And its Cloud option creates through the modal's own create.
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-company="cmp_acme"]');
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="chat-bot-create"]');
    await settle(10);
    expect(oncreateagent).toHaveBeenCalledTimes(1);
    expect(oncreateagent).toHaveBeenCalledWith(
      "cmp_acme",
      expect.objectContaining({ runtime: "codex", size: "basic" }),
    );
    expect(oncreatenewbot).not.toHaveBeenCalled();
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
  });

  it("does not offer the takeover's cloud create when the host has no takeover create", async () => {
    mountSidebar({
      companies: [INDIGO],
      oncreateagent: async () => okTarget,
      newBotCompanyUids: ["cmp_indigo"],
    });
    await settle();
    await openModal();
    click('[data-testid="chat-create-new-bot"]');
    await settle();
    await chooseKind("cloud");
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    expect(q('[data-testid="create-bot-kind-step"]')).toBeTruthy();
  });

  it("with one flagged company, opens the takeover for that company alone", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    const oncreatenewbot = vi.fn(
      async (): Promise<EntryPointResult> => ({
        ok: true,
        target: { channelId: "", cardId: null, cardKind: null, agentUid: "agt_nova" },
      }),
    );
    mountSidebar({
      // Two companies a cloud bot can be made in; only Acme has the flag.
      companies: [INDIGO, ACME],
      oncreateagent,
      oncreatenewbot,
      newBotCompanyUids: ["cmp_acme"],
      loadAgentStatus: async () => ({
        ok: true,
        value: { setupState: { phase: "creating" } },
      }),
    });
    await settle();
    await openModal();
    click('[data-testid="chat-create-new-bot"]');
    await settle();
    await chooseKind("cloud");
    expect(q('[data-testid="new-bot-takeover"]')).toBeTruthy();
    expect(q('[data-testid="chat-create-modal"]')).toBeNull();

    // One company: no company step, and the create goes to that company.
    await nameTakeoverBot("Nova");
    expect(q('[data-testid="new-bot-company-grid"]')).toBeNull();
    click('[data-testid="new-bot-create-submit"]');
    await settle(10);
    expect(oncreatenewbot).toHaveBeenCalledTimes(1);
    expect(oncreatenewbot).toHaveBeenCalledWith(
      "cmp_acme",
      expect.objectContaining({ name: "Nova" }),
    );
    expect(oncreateagent).not.toHaveBeenCalled();
  });

  it("with a mixed account, the takeover lists only the flagged companies", async () => {
    const oncreatenewbot = vi.fn(async () => okTarget);
    mountSidebar({
      companies: [INDIGO, ACME, GLOBEX],
      oncreateagent: async () => okTarget,
      oncreatenewbot,
      // Acme has no flag. The last uid is a company this person cannot add a
      // bot to: a flag alone never puts a company on the list.
      newBotCompanyUids: ["cmp_globex", "cmp_indigo", "cmp_elsewhere"],
    });
    await settle();
    await openModal();
    click('[data-testid="chat-create-new-bot"]');
    await settle();
    await chooseKind("cloud");
    expect(q('[data-testid="new-bot-takeover"]')).toBeTruthy();
    await nameTakeoverBot("Nova");
    click('[data-testid="new-bot-continue-brain"]');
    await settle();

    expect(takeoverCompanyUids()).toEqual(["cmp_indigo", "cmp_globex"]);
    expect(q('[data-testid="new-bot-company-grid"]')?.textContent).not.toContain("Acme");

    click('[data-company-uid="cmp_globex"]');
    await settle();
    click('[data-testid="new-bot-create-submit"]');
    await settle(10);
    expect(oncreatenewbot).toHaveBeenCalledWith(
      "cmp_globex",
      expect.objectContaining({ name: "Nova" }),
    );
  });

  it("a flag for a company the person cannot add a bot to opens no takeover cloud create", async () => {
    mountSidebar({
      companies: [INDIGO],
      oncreateagent: async () => okTarget,
      oncreatenewbot: async () => okTarget,
      newBotCompanyUids: ["cmp_elsewhere"],
    });
    await settle();
    await openModal();
    click('[data-testid="chat-create-new-bot"]');
    await settle();
    await chooseKind("cloud");
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    expect(q('[data-testid="create-bot-kind-step"]')).toBeTruthy();
  });

  it("from the takeover, 'create a local bot instead' then Cloud uses the modal's own create", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    const oncreatenewbot = vi.fn(async () => okTarget);
    const oncreatebot = vi.fn(async () => ({
      ok: true as const,
      agentUid: "agt_new",
      name: "assistant",
    }));
    mountSidebar({
      companies: [INDIGO],
      oncreateagent,
      oncreatenewbot,
      oncreatebot,
      newBotCompanyUids: ["cmp_indigo"],
    });
    await settle();
    await openModal();
    click('[data-testid="chat-create-new-bot"]');
    await settle();
    await chooseKind("cloud");
    click('[data-testid="new-bot-takeover-local"]');
    await settle();
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    expect(q('[data-testid="create-bot-kind-step"]')).toBeTruthy();

    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="chat-bot-where-cloud"]');
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="chat-bot-create"]');
    await settle(10);
    expect(oncreateagent).toHaveBeenCalledTimes(1);
    expect(oncreateagent).toHaveBeenCalledWith(
      "cmp_indigo",
      expect.objectContaining({ runtime: "codex", size: "basic" }),
    );
    expect(oncreatenewbot).not.toHaveBeenCalled();
    expect(oncreatebot).not.toHaveBeenCalled();
    expect(q('[data-testid="chat-create-modal"]')).toBeNull();
  });

  it("names no company when the person has none", async () => {
    const onagentcompanies = vi.fn();
    mountSidebar({ companies: [], seedDirectory: [], onagentcompanies });
    await settle();
    expect(onagentcompanies).toHaveBeenLastCalledWith([]);
  });
});

describe("ChatSidebar 'New bot' entry point (local bots)", () => {
  it("hides the row when the host has no local bots", async () => {
    mountSidebar({ companies: [INDIGO] });
    await settle();
    await openModal();
    expect(q('[data-testid="chat-create-new-bot"]')).toBeNull();
  });

  it("walks kind → details (Local already picked) and submits name, runtime, and pre-approval to the host", async () => {
    const oncreatebot = vi.fn(async () => ({
      ok: true as const,
      agentUid: "agt_new",
      name: "assistant",
    }));
    mountSidebar({ companies: [INDIGO], oncreatebot });
    await settle();
    await openModal();
    const plus = q<HTMLButtonElement>('[data-testid="chat-new-message"]');
    expect(plus?.getAttribute("aria-label")).toBe("New message, channel, or agent");
    const row = q<HTMLButtonElement>('[data-testid="chat-create-new-bot"]');
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("Runs on this computer");
    await toLocalDetails();
    click('[data-testid="chat-bot-runtime-grok"]');
    await settle();
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
    await chooseKind("local");
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
    await toLocalDetails();
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
      q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled,
    ).toBe(true);
    expect(q('[data-testid="create-bot-issue"]')?.textContent).toContain(
      "Claude Code is not signed in",
    );
    click('[data-testid="chat-bot-runtime-codex"]');
    await settle();
    expect(
      q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled,
    ).toBe(false);
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
        cloudError: null,
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

/**
 * Review G-1: "New bot" follows where the person stands.
 *
 * One company with the flag used to send "New bot" to the takeover for every
 * company. A person in Indigo (flag on) and Acme (flag off), looking at
 * Acme, got the takeover, which listed Indigo alone, skipped the company
 * step without naming it, and made a billed bot in Indigo.
 */
describe("ChatSidebar New Bot takeover: the company in view decides (review G-1)", () => {
  const GLOBEX = workspace("globex", "Globex", "cmp_globex");
  const created = async (): Promise<EntryPointResult> => ({
    ok: true,
    target: { channelId: "", cardId: null, cardKind: null, agentUid: "agt_nova" },
  });
  const STATUS = async () => ({ ok: true, value: { setupState: { phase: "creating" } } });

  /** Press "+" then "New bot", then answer "Cloud or Local?" with Cloud. */
  async function pressNewBot(): Promise<void> {
    await openModal();
    click('[data-testid="chat-create-new-bot"]');
    await settle();
    await chooseKind("cloud");
  }

  async function nameTakeoverBot(name: string): Promise<void> {
    const field = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
    field.value = name;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    click('[data-testid="new-bot-continue-name"]');
    await settle();
  }

  function targetLine(): string {
    return q('[data-testid="new-bot-target-company"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  }

  it("looking at a company without the flag, New bot never creates in the company that has it", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    const oncreatenewbot = vi.fn(created);
    mountSidebar({
      companies: [INDIGO, ACME],
      scopeUid: "cmp_acme",
      oncreateagent,
      oncreatenewbot,
      newBotCompanyUids: ["cmp_indigo"],
      loadAgentStatus: STATUS,
    });
    await settle();
    await pressNewBot();

    // Whatever opened, go through it the way a person would: name, then create.
    if (q('[data-testid="new-bot-name"]')) {
      await nameTakeoverBot("Nova");
      q<HTMLButtonElement>('[data-testid="new-bot-create-submit"]')?.click();
      await settle(10);
    }
    // No bot was made in Indigo, the company the person was not looking at.
    expect((oncreatenewbot.mock.calls as unknown[][]).map((call) => call[0])).toEqual([]);

    // What opened is the "+" window's own flow, in the takeover shell.
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    expect(q('[data-testid="chat-create-modal"]')?.getAttribute("data-sunrise")).toBe("true");
    expect(q('[data-testid="create-bot-kind-step"]')).toBeTruthy();

    // And its Cloud create carries the company the person picks there.
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-company="cmp_acme"]');
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="chat-bot-create"]')?.textContent).toContain("Create in Acme");
    click('[data-testid="chat-bot-create"]');
    await settle(10);
    expect(oncreateagent).toHaveBeenCalledTimes(1);
    expect(oncreateagent).toHaveBeenCalledWith("cmp_acme", expect.objectContaining({ runtime: "codex" }));
    expect(oncreatenewbot).not.toHaveBeenCalled();
  });

  it("looking at a company with the flag, opens the takeover for that company and names it before Create", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    const oncreatenewbot = vi.fn(created);
    mountSidebar({
      // Globex has the flag too, and is not the company in view.
      companies: [INDIGO, ACME, GLOBEX],
      scopeUid: "cmp_indigo",
      oncreateagent,
      oncreatenewbot,
      newBotCompanyUids: ["cmp_indigo", "cmp_globex"],
      loadAgentStatus: STATUS,
    });
    await settle();
    await pressNewBot();
    expect(q('[data-testid="new-bot-takeover"]')).toBeTruthy();
    expect(q('[data-testid="chat-create-modal"]')).toBeNull();
    // The way to another company, or to a bot on this computer, says what it is for.
    expect(q('[data-testid="new-bot-takeover-local"]')?.textContent?.trim()).toBe("Create in another company");

    await nameTakeoverBot("Nova");
    // One target, so nothing to pick. It is named where Create is pressed.
    expect(q('[data-testid="new-bot-company-grid"]')).toBeNull();
    expect(targetLine()).toBe("Nova will be created in Indigo.");
    click('[data-testid="new-bot-create-submit"]');
    await settle(10);
    expect(oncreatenewbot).toHaveBeenCalledTimes(1);
    expect(oncreatenewbot).toHaveBeenCalledWith("cmp_indigo", expect.objectContaining({ name: "Nova" }));
    expect(oncreateagent).not.toHaveBeenCalled();
  });

  it("with all companies in view and one with the flag, the takeover names that company and offers the way to the others", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    const oncreatenewbot = vi.fn(created);
    const oncreatebot = vi.fn(async () => ({ ok: true as const, agentUid: "agt_new", name: "assistant" }));
    mountSidebar({
      companies: [INDIGO, ACME],
      oncreateagent,
      oncreatenewbot,
      oncreatebot,
      newBotCompanyUids: ["cmp_indigo"],
      loadAgentStatus: STATUS,
    });
    await settle();
    await pressNewBot();
    expect(q('[data-testid="new-bot-takeover"]')).toBeTruthy();
    expect(q('[data-testid="new-bot-takeover-local"]')?.textContent?.trim()).toBe("Another company or a local bot");

    await nameTakeoverBot("Nova");
    expect(q('[data-testid="new-bot-company-grid"]')).toBeNull();
    expect(targetLine()).toBe("Nova will be created in Indigo.");
    click('[data-testid="new-bot-create-submit"]');
    await settle(10);
    expect(oncreatenewbot).toHaveBeenCalledWith("cmp_indigo", expect.objectContaining({ name: "Nova" }));
    expect(oncreateagent).not.toHaveBeenCalled();
  });

  it("the way to the others opens the '+' window's bot step, where Acme can be chosen", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    const oncreatenewbot = vi.fn(created);
    mountSidebar({
      companies: [INDIGO, ACME],
      oncreateagent,
      oncreatenewbot,
      newBotCompanyUids: ["cmp_indigo"],
    });
    await settle();
    await pressNewBot();
    click('[data-testid="new-bot-takeover-local"]');
    await settle();
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    expect(q('[data-testid="chat-create-bot-step"]')).toBeTruthy();

    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-company="cmp_acme"]');
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="chat-bot-create"]');
    await settle(10);
    expect(oncreateagent).toHaveBeenCalledWith("cmp_acme", expect.objectContaining({ runtime: "codex" }));
    expect(oncreatenewbot).not.toHaveBeenCalled();
  });

  it("with all companies in view and several with the flag, the company is chosen and named on the last step", async () => {
    const oncreatenewbot = vi.fn(created);
    mountSidebar({
      companies: [INDIGO, ACME, GLOBEX],
      oncreateagent: async () => okTarget,
      oncreatenewbot,
      newBotCompanyUids: ["cmp_indigo", "cmp_globex"],
      loadAgentStatus: STATUS,
    });
    await settle();
    await pressNewBot();
    await nameTakeoverBot("Nova");
    click('[data-testid="new-bot-continue-brain"]');
    await settle();

    // Only the companies with the flag are listed, and the line follows the pick.
    expect(q('[data-testid="new-bot-company-grid"]')?.textContent).not.toContain("Acme");
    expect(targetLine()).toBe("Nova will be created in Indigo.");
    click('[data-company-uid="cmp_globex"]');
    await settle();
    expect(targetLine()).toBe("Nova will be created in Globex.");
    click('[data-testid="new-bot-create-submit"]');
    await settle(10);
    expect(oncreatenewbot).toHaveBeenCalledWith("cmp_globex", expect.objectContaining({ name: "Nova" }));
  });

  it("a person with one company in total is not asked or told which company", async () => {
    const oncreatenewbot = vi.fn(created);
    const oncreatebot = vi.fn(async () => ({ ok: true as const, agentUid: "agt_new", name: "assistant" }));
    mountSidebar({
      companies: [INDIGO],
      oncreateagent: async () => okTarget,
      oncreatenewbot,
      oncreatebot,
      newBotCompanyUids: ["cmp_indigo"],
      loadAgentStatus: STATUS,
    });
    await settle();
    await pressNewBot();
    // No other company to send them to: the button is about a local bot only.
    expect(q('[data-testid="new-bot-takeover-local"]')?.textContent?.trim()).toBe("Create a local bot instead");
    await nameTakeoverBot("Nova");
    expect(q('[data-testid="new-bot-company-grid"]')).toBeNull();
    expect(q('[data-testid="new-bot-target-company"]')).toBeNull();
    click('[data-testid="new-bot-create-submit"]');
    await settle(10);
    expect(oncreatenewbot).toHaveBeenCalledWith("cmp_indigo", expect.objectContaining({ name: "Nova" }));
  });

  it("follows the company in view when the person changes it", async () => {
    mountSidebar({
      companies: [INDIGO, ACME],
      oncreateagent: async () => okTarget,
      oncreatenewbot: vi.fn(created),
      newBotCompanyUids: ["cmp_indigo"],
    });
    await settle();
    // The sidebar starts on all companies, where New bot would open the
    // takeover. The person switches it to Acme, which has no flag.
    host.querySelector<HTMLButtonElement>('[data-testid="chat-scope-pill"]')!.click();
    await settle();
    const acme = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="chat-scope-menu"] [role="menuitemradio"]')).find(
      (option) => option.textContent?.includes("Acme"),
    );
    expect(acme).toBeTruthy();
    acme!.click();
    await settle();
    await pressNewBot();
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    expect(q('[data-testid="create-bot-kind-step"]')).toBeTruthy();
  });
});
