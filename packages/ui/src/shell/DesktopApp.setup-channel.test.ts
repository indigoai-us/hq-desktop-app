// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount, type ComponentProps } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import ExtraPageProbe from "./ExtraPageProbe.test.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import {
  SETUP_CHANNEL_ID,
  SETUP_HERO,
  SETUP_HERO_RETURNING,
  SETUP_ROW_ID,
} from "../chat/setup-channel.js";
import type { Workspace } from "../chat/workspaces.js";

const ACME: Workspace = {
  slug: "acme",
  displayName: "Acme",
  kind: "company",
  state: "cloud-only",
  cloudUid: "cmp_acme",
  bucketName: null,
  hasLocalFolder: false,
  localPath: null,
  membershipStatus: "active",
  role: "owner",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
};

const ACME_CHANNEL_ROW = {
  channelId: "chn_acme",
  type: "chat",
  scope: "company",
  companyUid: "cmp_acme",
  name: "acme",
  lastActivityAt: new Date().toISOString(),
};

/** The seeded card every fresh account gets before the server sees the company. */
const SEEDED_CREATE_COMPANY = {
  eventId: "evt_seed_create",
  createdAt: "2026-09-05T12:00:00Z",
  messageKind: "system",
  systemEvent: {
    v: 1,
    type: "lifecycle_card",
    cardId: "card_create_company_seed",
    kind: "create_company",
    companyUid: null,
    state: "open",
    title: "Create a company",
    fields: [
      { id: "name", label: "Company name", control: "text", required: true, value: "" },
    ],
    actions: [{ id: "create", label: "Create company", style: "primary" }],
    viewer: { canAct: true },
  },
};

function setupChannelWithSeed(): Partial<PlatformAdapter["messaging"]> {
  return {
    fetchChannel: async (args: { channelId: string }) =>
      args.channelId === SETUP_CHANNEL_ID
        ? ok({ messages: [SEEDED_CREATE_COMPANY], nextCursor: null })
        : ({ ok: false as const, reason: "unavailable" as const } as never),
  };
}

function adapter(
  messaging: Partial<PlatformAdapter["messaging"]> = {},
): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ({
        ok: false as const,
        reason: "unavailable",
      }),
      ...messaging,
    },
    settings: {
      getSetupStatus: async () =>
        ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () => ({
        ok: false as const,
        reason: "unavailable",
      }),
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

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function mountApp(
  messaging: Partial<PlatformAdapter["messaging"]> = {},
  extraPages?: ComponentProps<typeof DesktopApp>["extraPages"],
  extra: Partial<ComponentProps<typeof DesktopApp>> = {},
): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(messaging),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: {
        uid: "prs_test",
        displayName: "Stefan Johnson",
        email: "stefan@example.com",
      },
      coreFixtures: false,
      extraPages,
      ...extra,
    },
  });
  await settle();
}

async function selectSetupRow(): Promise<HTMLButtonElement> {
  const row = host.querySelector<HTMLButtonElement>(
    `[data-conversation-id="${SETUP_ROW_ID}"]`,
  );
  expect(row, "pinned #setup row renders in the sidebar rail").toBeTruthy();
  row!.click();
  await settle();
  return row!;
}

describe("DesktopApp synthetic #setup channel", () => {
  it("opens the registered Sessions draft from welcome without sending", async () => {
    const sendChannelMessage = vi.fn();
    const param = vi.fn(() => "new?draft=welcome-test");
    await mountApp({ sendChannelMessage }, {
      sessions: {
        label: "Sessions",
        detail: "Local sessions",
        component: ExtraPageProbe,
        createAction: { label: "New session", param },
      },
    });
    await selectSetupRow();
    const button = host.querySelector<HTMLButtonElement>('[data-testid="setup-open-sessions"]');
    expect(button).toBeTruthy();
    button!.click();
    await settle();
    expect(param).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-testid="extra-page-probe"]')?.getAttribute("data-param")).toBe("new?draft=welcome-test");
    expect(sendChannelMessage).not.toHaveBeenCalled();
  });
  it("pins #setup in the sidebar and routes selection to the setup intro", async () => {
    await mountApp();

    const row = await selectSetupRow();
    // Pinned section hosts the row (dedup + pin ride the derivation layer).
    expect(row.closest('[aria-labelledby="chat-pinned-label"]')).toBeTruthy();

    const intro = host.querySelector('[data-testid="setup-channel-intro"]');
    expect(intro, "setup intro renders in the conversation area").toBeTruthy();
    expect(intro?.textContent).toContain(SETUP_HERO.title);
    expect(
      host.querySelector('[data-testid="setup-resource-getting-started"]'),
      "getting-started guide link renders",
    ).toBeTruthy();
    expect(
      host.querySelector('[data-testid="setup-launch-claude"]'),
    ).toBeTruthy();
    expect(
      host.querySelector('[data-testid="setup-launch-codex"]'),
    ).toBeTruthy();
    expect(
      host.querySelector('[data-testid="setup-launch-grok"]'),
    ).toBeTruthy();
    // The standard composer pipeline still hosts the thread below the intro.
    expect(host.querySelector('[data-testid="chat-stage"]')).toBeTruthy();
  });

  it("renders the setup intro inside the conversation scroller", async () => {
    await mountApp();
    await selectSetupRow();

    const intro = host.querySelector('[data-testid="setup-channel-intro"]');
    expect(intro, "setup intro renders").toBeTruthy();
    expect(
      intro?.closest(".dm-thread"),
      "intro lives inside the .dm-thread scroller so it scrolls with history",
    ).toBeTruthy();
  });

  it("sends from #setup through sendChannelMessage without a linked-channel error", async () => {
    const sendChannelMessage = vi.fn(
      async (_channelId: string, _body: string, _extras?: unknown) =>
        ok({ eventId: "evt_1", createdAt: new Date().toISOString() }),
    );
    await mountApp({ sendChannelMessage });
    await selectSetupRow();

    const composer = host.querySelector<HTMLTextAreaElement>(
      '[data-testid="conversation-composer"]',
    );
    const sendBtn = host.querySelector<HTMLButtonElement>(
      '[data-testid="composer-send"]',
    );
    expect(composer, "setup channel hosts the standard composer").toBeTruthy();
    expect(sendBtn, "send control renders").toBeTruthy();

    composer!.value = "need a hand with setup";
    composer!.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    sendBtn!.click();
    await settle(10);

    expect(sendChannelMessage).toHaveBeenCalledWith(
      SETUP_CHANNEL_ID,
      "need a hand with setup",
      expect.anything(),
    );
    expect(host.textContent).not.toMatch(/isn't linked yet/);
    expect(host.querySelector(".composer-attach-error")).toBeNull();
  });
});

describe("DesktopApp #setup leads with an existing company", () => {
  it("shows the seeded create_company card and the blank-slate hero when the roster is empty", async () => {
    await mountApp(setupChannelWithSeed(), undefined, { companies: [] });
    await selectSetupRow();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="lifecycle-card"][data-card-kind="create_company"]'),
      ).toBeTruthy();
    });
    const intro = host.querySelector('[data-testid="setup-channel-intro"]');
    expect(intro?.getAttribute("data-setup-has-company")).toBe("false");
    expect(intro?.textContent).toContain(SETUP_HERO.title);
    expect(host.querySelector('[data-testid="setup-company-actions"]')).toBeNull();
    expect(host.querySelector('[data-testid="setup-create-another-company"]')).toBeNull();
  });

  it("hides the seeded create_company card and offers Continue setup for a cloud-only company", async () => {
    const runCardAction = vi.fn();
    await mountApp({ ...setupChannelWithSeed(), runCardAction }, undefined, {
      companies: [ACME],
    });
    await selectSetupRow();
    await settle(10);

    const intro = host.querySelector('[data-testid="setup-channel-intro"]');
    expect(intro?.getAttribute("data-setup-has-company")).toBe("true");
    expect(intro?.textContent).toContain(SETUP_HERO_RETURNING.title);
    expect(intro?.textContent).not.toContain(SETUP_HERO.body);
    const open = host.querySelector<HTMLButtonElement>(
      '[data-testid="setup-open-company-acme"]',
    );
    expect(open?.textContent?.trim()).toBe("Continue setup for Acme");
    expect(
      host.querySelector('[data-testid="lifecycle-card"][data-card-kind="create_company"]'),
      "seeded create_company card is not the primary action when a company exists",
    ).toBeNull();
    // The quiet secondary affordance is still there for a second company.
    expect(host.querySelector('[data-testid="setup-create-another-company"]')).toBeTruthy();
    expect(runCardAction).not.toHaveBeenCalled();
  });

  it("Open <Company> selects that company's channel when the rail has it", async () => {
    const onselectrow = vi.fn();
    await mountApp(setupChannelWithSeed(), undefined, {
      companies: [{ ...ACME, state: "synced", hasLocalFolder: true }],
      seedDirectory: [ACME_CHANNEL_ROW],
      onselectrow,
    });
    await selectSetupRow();
    const open = host.querySelector<HTMLButtonElement>(
      '[data-testid="setup-open-company-acme"]',
    );
    expect(open?.textContent?.trim()).toBe("Open Acme");
    open!.click();
    await settle(10);
    expect(onselectrow).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "ch:chn_acme", companyUid: "cmp_acme" }),
    );
    expect(host.querySelector('[data-testid="setup-channel-intro"]')).toBeNull();
  });

  it("Create another company runs the entry point and brings the create card back", async () => {
    const runCardAction = vi.fn(async () =>
      ok({
        cardId: "card_create_company_seed",
        actionId: "create_company",
        state: "open",
        channelId: SETUP_CHANNEL_ID,
        replayed: false,
      }),
    );
    await mountApp({ ...setupChannelWithSeed(), runCardAction }, undefined, {
      companies: [ACME],
    });
    await selectSetupRow();
    await settle(10);
    expect(
      host.querySelector('[data-testid="lifecycle-card"][data-card-kind="create_company"]'),
    ).toBeNull();

    host
      .querySelector<HTMLButtonElement>('[data-testid="setup-create-another-company"]')!
      .click();
    await vi.waitFor(() => expect(runCardAction).toHaveBeenCalledOnce());
    expect(runCardAction).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: SETUP_CHANNEL_ID,
        cardId: "companies_summary",
        actionId: "create_company",
      }),
    );
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="lifecycle-card"][data-card-kind="create_company"]'),
      ).toBeTruthy();
    });
  });

  it("reports inline when the summary 404s for an account that already has a company", async () => {
    const runCardAction = vi.fn(async () => {
      throw new Error("[not_found] Request failed (status 404)");
    });
    await mountApp({ ...setupChannelWithSeed(), runCardAction }, undefined, {
      companies: [ACME],
    });
    await selectSetupRow();
    host
      .querySelector<HTMLButtonElement>('[data-testid="setup-create-another-company"]')!
      .click();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="setup-create-another-company-error"]')?.textContent,
      ).toMatch(/still syncing/);
    });
    expect(
      host.querySelector('[data-testid="lifecycle-card"][data-card-kind="create_company"]'),
    ).toBeNull();
  });
});

describe("DesktopApp #setup waits for the company roster", () => {
  it("shows a quiet loading line and no create card or create copy while the roster loads", async () => {
    await mountApp(setupChannelWithSeed(), undefined, {
      companies: [],
      rosterStatus: "loading",
    });
    await selectSetupRow();
    await settle(10);

    const intro = host.querySelector('[data-testid="setup-channel-intro"]');
    expect(intro?.getAttribute("data-setup-roster-status")).toBe("loading");
    expect(
      host.querySelector('[data-testid="setup-roster-loading"]')?.textContent,
    ).toMatch(/Loading your workspace/);
    expect(intro?.textContent).not.toContain(SETUP_HERO.body);
    expect(intro?.textContent).not.toContain(SETUP_HERO_RETURNING.title);
    expect(
      host.querySelector('[data-testid="lifecycle-card"][data-card-kind="create_company"]'),
      "seeded create_company card must wait for the roster",
    ).toBeNull();
    expect(host.querySelector('[data-testid="setup-roster-failed"]')).toBeNull();
  });

  it("shows the create flow once the roster is ready with zero companies", async () => {
    await mountApp(setupChannelWithSeed(), undefined, {
      companies: [],
      rosterStatus: "ready",
    });
    await selectSetupRow();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="lifecycle-card"][data-card-kind="create_company"]'),
      ).toBeTruthy();
    });
    const intro = host.querySelector('[data-testid="setup-channel-intro"]');
    expect(intro?.getAttribute("data-setup-roster-status")).toBe("ready");
    expect(intro?.textContent).toContain(SETUP_HERO.body);
    expect(host.querySelector('[data-testid="setup-roster-loading"]')).toBeNull();
    expect(host.querySelector('[data-testid="setup-roster-failed"]')).toBeNull();
  });

  it("shows the create flow plus a Retry line when the roster failed, and Retry re-runs the fetch", async () => {
    const onretryroster = vi.fn();
    await mountApp(setupChannelWithSeed(), undefined, {
      companies: [],
      rosterStatus: "failed",
      onretryroster,
    });
    await selectSetupRow();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="lifecycle-card"][data-card-kind="create_company"]'),
      ).toBeTruthy();
    });
    const intro = host.querySelector('[data-testid="setup-channel-intro"]');
    expect(intro?.getAttribute("data-setup-roster-status")).toBe("failed");
    expect(intro?.textContent).toContain(SETUP_HERO.body);
    const failed = host.querySelector('[data-testid="setup-roster-failed"]');
    expect(failed?.textContent).toMatch(/Couldn.t load your companies/);
    const retry = host.querySelector<HTMLButtonElement>('[data-testid="setup-roster-retry"]');
    expect(retry?.textContent?.trim()).toBe("Retry");
    retry!.click();
    await settle();
    expect(onretryroster).toHaveBeenCalledOnce();
  });

  it("leads with the company even while a later roster refresh is in flight", async () => {
    await mountApp(setupChannelWithSeed(), undefined, {
      companies: [ACME],
      rosterStatus: "loading",
    });
    await selectSetupRow();
    await settle(10);
    const intro = host.querySelector('[data-testid="setup-channel-intro"]');
    expect(intro?.textContent).toContain(SETUP_HERO_RETURNING.title);
    expect(host.querySelector('[data-testid="setup-open-company-acme"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="setup-roster-loading"]')).toBeNull();
  });
});
