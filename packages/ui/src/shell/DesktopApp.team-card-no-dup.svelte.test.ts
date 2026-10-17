// @vitest-environment happy-dom

/**
 * The team card must never create a second company. A create can succeed
 * while its reply to the setup bot fails: the card then keeps that company
 * until the reply goes through, across a new name, a Retry and a restart, and
 * an account switch starts the card clean. Harness copied from the team card
 * suite; the create flow's server calls are stubbed at its module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { ok, type LocalBotRow, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import { WELCOME_SETUP_RUN_KEY } from "../chat/setup-channel.js";
import { takePendingChannelOpen } from "../chat/open-target.js";
import { CREATE_COMPANY_NO_RESULT_REASON } from "../chat/create-company/create-company-flow.js";

const flow = vi.hoisted(() => ({
  open: vi.fn(),
  submit: vi.fn(),
}));

vi.mock("../chat/create-company/create-company-flow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chat/create-company/create-company-flow.js")>();
  return { ...actual, openCreateCompanyDraft: flow.open, submitCreateCompany: flow.submit };
});

const SETUP_UID = "agt_setup_team";
const SETUP_DM_ROW = { id: `dm:${SETUP_UID}`, kind: "dm", title: "setup", personUid: SETUP_UID } as ConversationRow;
const ME = { uid: "prs_me", displayName: "Corey", email: "me@example.com" };

const TEAM_FIRST =
  "Hi, I'm Pickles, your setup bot.\n\n" + "```hq-block\n" + JSON.stringify({ v: 1, blocks: [{ kind: "team" }] }) + "\n```";
const teamMessage = {
  eventId: "evt_team",
  body: TEAM_FIRST,
  fromPersonUid: SETUP_UID,
  fromDisplayName: "setup",
  createdAt: "2026-10-02T10:00:00.000Z",
  direction: "in",
};

const DRAFT = {
  channelId: "setup",
  cardId: "card_create_company_1",
  title: "Name your company",
  summary: null,
  fields: [{ id: "name", label: "Company name", control: "text", required: true, value: "" }],
  actionId: "submit",
  nameFieldId: "name",
};

function botRow(): LocalBotRow {
  return {
    name: "setup",
    agentUid: SETUP_UID,
    ownerUid: "prs_me",
    runtime: "claude",
    state: "running",
    pid: 42,
    processAlive: true,
    online: true,
    lastHeartbeatAt: new Date().toISOString(),
    daemonInstalled: true,
    daemonLoaded: true,
    dir: "/tmp/.hq/bots/setup",
    workerId: "setup",
  } as LocalBotRow;
}

let sendDm: ReturnType<typeof vi.fn>;
/** The server's per-person handle check: someone else's company reads as not available. */
let checkCompanySlug: ReturnType<typeof vi.fn>;
let logToFile: ReturnType<typeof vi.fn>;
let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function adapter(messages: Array<Record<string, unknown>>): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [{ personUid: SETUP_UID, displayName: "setup", companyUid: null }] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok({ messages: [...messages].reverse() }),
      fetchDmThread: async () => ok({ messages: [...messages].reverse() }),
      sendDm,
      checkCompanySlug,
      sendChannelMessage: async () => ok({ eventId: "evt_self_1", createdAt: new Date().toISOString() }),
      fetchReactions: async () => ok({ reactions: [] }),
      // Creating a company runs card actions; the flow is stubbed above.
      runCardAction: async () => ({ ok: false as const, reason: "unavailable" }),
    },
    notifications: { fetchDmInbox: async () => ok({}) },
    settings: {
      getSetupStatus: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () =>
        ok({ claude_cli: false, claude_desktop: false, codex_cli: false, codex_desktop: false, grok_cli: false, any: false }),
    },
    sessions: {
      preflight: async () =>
        ok({ claudeAvailable: true, claudeLoggedIn: true, codexAvailable: false, codexLoggedIn: false, grokAvailable: false, grokLoggedIn: false }),
    },
    bots: {
      list: async () => ok({ bots: [botRow()] }),
      create: async () => ok({}),
      start: async () => ok({}),
      stop: async () => ok({}),
      remove: async () => ok({}),
      workers: async () => ok({ workers: [] }),
    },
    appShell: { logToFile },
  } as unknown as PlatformAdapter;
}

beforeEach(() => {
  takePendingChannelOpen();
  window.localStorage.clear();
  window.localStorage.setItem(WELCOME_SETUP_RUN_KEY, "1");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  sendDm = vi.fn(async () => ok({ eventId: "evt_self_1", createdAt: new Date().toISOString() }));
  checkCompanySlug = vi.fn(async (slug: string) => ok({ valid: true, available: true, normalized: slug }));
  logToFile = vi.fn(async () => undefined);
  flow.open.mockReset().mockResolvedValue({ ok: true, form: DRAFT });
  flow.submit.mockReset().mockImplementation(async (_api: unknown, _form: unknown, values: Record<string, string>) => ({
    ok: true,
    company: {
      companyUid: `cmp_${values.name.toLowerCase()}`,
      companyChannelId: null,
      inviteFailures: [],
      queuedInvites: [],
      cloudError: null,
    },
  }));
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

const q = <T extends Element = HTMLElement>(sel: string): T | null => host.querySelector<T>(sel);

async function waitFor<T extends Element = HTMLElement>(sel: string): Promise<T> {
  return vi.waitFor(() => {
    const el = q<T>(sel);
    expect(el).toBeTruthy();
    return el!;
  });
}

/** The fixture sidebar, with the setup bot's conversation listed so a test can come back to it. */
function sidebarWithSetupBot() {
  const api = createFixtureChatSidebarApi();
  return {
    ...api,
    listContacts: async () => {
      const { contacts } = await api.listContacts();
      const now = new Date().toISOString();
      return { contacts: [{ personUid: SETUP_UID, email: "", displayName: "setup", lastMessageAt: now, lastActivityAt: now }, ...contacts] };
    },
  };
}

/** Creating a company switches the app into it; the person comes back to the setup bot. */
async function backToSetupBot(): Promise<void> {
  await vi.waitFor(() => expect(flow.submit).toHaveBeenCalled());
  await vi.waitFor(() => expect(sendDm).toHaveBeenCalled());
  const row = await waitFor(`[data-conversation-id="${SETUP_DM_ROW.id}"]`);
  row.click();
  await waitFor('[data-event-id="evt_team"]');
}

/** Mounts the app on the setup bot's conversation; `props.self` can be changed afterwards. */
async function openSetupDm(messages: Array<Record<string, unknown>>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const props = $state({
    adapter: adapter(messages),
    wakes: null,
    companies: null,
    sidebarApi: sidebarWithSetupBot(),
    notificationsApi: createEmptyNotificationsApi(),
    self: ME as typeof ME | null,
    coreFixtures: false,
    initialRow: SETUP_DM_ROW,
  });
  component = mount(DesktopApp, { target: host, props });
  await vi.waitFor(() => expect(q('[data-testid="channel-name"]')?.textContent).toContain("setup"));
  return props;
}

async function restart(messages: Array<Record<string, unknown>>) {
  if (component) await unmount(component);
  component = null;
  host.remove();
  return openSetupDm(messages);
}

function typeName(name: string): void {
  const input = q<HTMLInputElement>('[data-testid="team-card-name"]')!;
  input.value = name;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

/** Opens the create row, types a name and presses Create. */
async function create(name: string): Promise<void> {
  (await waitFor<HTMLButtonElement>('[data-testid="team-card-create"]')).click();
  await waitFor('[data-testid="team-card-name"]');
  typeName(name);
  q<HTMLButtonElement>('[data-testid="team-card-create-submit"]')!.click();
}

const sentTexts = () => sendDm.mock.calls.map((call) => call[1]);

/** The roster row the server's company shows up as once the host reloads it. */
function pickleWorkspace() {
  return {
    slug: "pickle",
    displayName: "Pickle",
    kind: "company",
    state: "synced",
    cloudUid: "cmp_pickle",
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
}

/** A create that ends with a company switches into it; come back to the setup bot if so. */
async function toSetupBot(): Promise<void> {
  await vi.waitFor(() => {
    if (q('[data-event-id="evt_team"]')) return;
    const row = q<HTMLElement>(`[data-conversation-id="${SETUP_DM_ROW.id}"]`);
    row?.click();
    expect(q('[data-event-id="evt_team"]')).toBeTruthy();
  });
}

/** Types a new name into the locked field and presses Create. */
function renameAndCreate(): void {
  typeName("Brine");
  expect(q<HTMLInputElement>('[data-testid="team-card-name"]')!.value).toBe("Pickle");
  q<HTMLButtonElement>('[data-testid="team-card-create-submit"]')!.click();
}

describe("the team card never creates a second company", () => {
  it("create succeeds, the reply fails, a new name and Create again resend the first company's reply", async () => {
    sendDm.mockResolvedValueOnce({ ok: false, message: "network down" });
    await openSetupDm([teamMessage]);
    await create("Pickle");
    await backToSetupBot();
    await waitFor('[data-testid="team-card-error"]');
    expect(flow.submit).toHaveBeenCalledOnce();

    // The person types another name: the field keeps the created company's.
    typeName("Brine");
    expect(q<HTMLInputElement>('[data-testid="team-card-name"]')!.value).toBe("Pickle");
    q<HTMLButtonElement>('[data-testid="team-card-create-submit"]')!.click();

    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(q('[data-testid="team-card-settled"]')?.textContent).toContain("Created Pickle"));
    expect(flow.submit).toHaveBeenCalledOnce();
    expect(sentTexts()).toEqual(["I created Pickle.", "I created Pickle."]);
    expect(sendDm.mock.calls[1]![2]).toEqual({ idempotencyKey: `first-run-team:${SETUP_UID}:create:pickle` });
  });

  it("Retry after a failed reply resends it for the created company only", async () => {
    sendDm.mockResolvedValueOnce({ ok: false, message: "network down" });
    await openSetupDm([teamMessage]);
    await create("Pickle");
    await backToSetupBot();
    (await waitFor<HTMLButtonElement>('[data-testid="team-card-retry"]')).click();
    await vi.waitFor(() => expect(q('[data-testid="team-card-settled"]')?.textContent).toContain("Created Pickle"));
    expect(flow.submit).toHaveBeenCalledOnce();
    expect(sentTexts()).toEqual(["I created Pickle.", "I created Pickle."]);
  });

  it("a restart between the create and its reply creates nothing again and resends the reply", async () => {
    sendDm.mockResolvedValueOnce({ ok: false, message: "network down" });
    const messages = [teamMessage];
    await openSetupDm(messages);
    await create("Pickle");
    await backToSetupBot();
    await waitFor('[data-testid="team-card-error"]');

    await restart(messages);
    // The card comes back locked to the company already made.
    const input = await waitFor<HTMLInputElement>('[data-testid="team-card-name"]');
    expect(input.value).toBe("Pickle");
    typeName("Brine");
    q<HTMLButtonElement>('[data-testid="team-card-create-submit"]')!.click();

    await vi.waitFor(() => expect(q('[data-testid="team-card-settled"]')?.textContent).toContain("Created Pickle"));
    expect(flow.submit).toHaveBeenCalledOnce();
    expect(sentTexts()).toEqual(["I created Pickle.", "I created Pickle."]);
  });

  it("an account switch clears the running pick and the error", async () => {
    sendDm.mockResolvedValueOnce({ ok: false, message: "network down" });
    const props = await openSetupDm([teamMessage]);
    (await waitFor<HTMLButtonElement>('[data-testid="team-card-personal"]')).click();
    await waitFor('[data-testid="team-card-error"]');

    props.self = { uid: "prs_other", displayName: "Sam", email: "sam@example.com" };
    await vi.waitFor(() => expect(q('[data-testid="team-card-error"]')).toBeNull());
    expect(q('[data-testid="team-card"]')?.getAttribute("aria-busy")).toBe("false");
  });

  it("an account switch while a pick runs leaves the new account's card idle", async () => {
    let release!: (value: unknown) => void;
    sendDm.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const props = await openSetupDm([teamMessage]);
    (await waitFor<HTMLButtonElement>('[data-testid="team-card-personal"]')).click();
    await vi.waitFor(() => expect(q('[data-testid="team-card"]')?.getAttribute("aria-busy")).toBe("true"));

    props.self = { uid: "prs_other", displayName: "Sam", email: "sam@example.com" };
    await vi.waitFor(() => expect(q('[data-testid="team-card"]')?.getAttribute("aria-busy")).toBe("false"));
    release({ ok: false, message: "network down" });
    await new Promise((r) => setTimeout(r, 20));
    expect(q('[data-testid="team-card-error"]')).toBeNull();
  });

  it("a refreshed profile for the same account keeps a running pick", async () => {
    let release!: (value: unknown) => void;
    sendDm.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const props = await openSetupDm([teamMessage]);
    (await waitFor<HTMLButtonElement>('[data-testid="team-card-personal"]')).click();
    await vi.waitFor(() => expect(q('[data-testid="team-card"]')?.getAttribute("aria-busy")).toBe("true"));

    props.self = { ...ME };
    flushSync();
    expect(q('[data-testid="team-card"]')?.getAttribute("aria-busy")).toBe("true");
    release({ ok: true });
    await vi.waitFor(() => expect(q('[data-testid="team-card-settled"]')?.textContent).toContain("Working solo"));
  });

  it("no pick runs before the account is known", async () => {
    const props = await openSetupDm([teamMessage]);
    props.self = null;
    (await waitFor<HTMLButtonElement>('[data-testid="team-card-personal"]')).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(sendDm).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("hq.firstRun.teamCard.v1")).toBeNull();
  });

  it("a create that times out keeps the card on its name, and the company it made is found, not made again", async () => {
    flow.submit.mockResolvedValueOnce({ ok: false, reason: CREATE_COMPANY_NO_RESULT_REASON, blocked: false });
    const props = await openSetupDm([teamMessage]);
    await create("Pickle");
    await waitFor('[data-testid="team-card-error"]');
    expect(sendDm).not.toHaveBeenCalled();

    // The server made the company after all; the roster now has it.
    props.companies = [pickleWorkspace()] as never;
    renameAndCreate();

    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledOnce());
    await toSetupBot();
    await vi.waitFor(() => expect(q('[data-testid="team-card-settled"]')?.textContent).toContain("Created Pickle"));
    expect(flow.submit).toHaveBeenCalledOnce();
    expect(sentTexts()).toEqual(["I created Pickle."]);
  });

  it("a company found on retry is kept when its reply fails, so a new name and Create resend it", async () => {
    flow.submit.mockResolvedValueOnce({ ok: false, reason: CREATE_COMPANY_NO_RESULT_REASON, blocked: false });
    sendDm.mockResolvedValueOnce({ ok: false, message: "network down" });
    const props = await openSetupDm([teamMessage]);
    await create("Pickle");
    await waitFor('[data-testid="team-card-error"]');

    props.companies = [pickleWorkspace()] as never;
    renameAndCreate();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledOnce());
    await toSetupBot();
    await waitFor('[data-testid="team-card-error"]');

    renameAndCreate();
    await vi.waitFor(() => expect(q('[data-testid="team-card-settled"]')?.textContent).toContain("Created Pickle"));
    expect(flow.submit).toHaveBeenCalledOnce();
    expect(sentTexts()).toEqual(["I created Pickle.", "I created Pickle."]);
  });

  it("a restart while a create is in flight keeps the card on its name and finds the company", async () => {
    flow.submit.mockImplementationOnce(() => new Promise(() => undefined));
    const messages = [teamMessage];
    await openSetupDm(messages);
    await create("Pickle");
    await vi.waitFor(() => expect(flow.submit).toHaveBeenCalledOnce());

    const props = await restart(messages);
    const input = await waitFor<HTMLInputElement>('[data-testid="team-card-name"]');
    expect(input.value).toBe("Pickle");
    props.companies = [pickleWorkspace()] as never;
    renameAndCreate();

    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledOnce());
    await toSetupBot();
    await vi.waitFor(() => expect(q('[data-testid="team-card-settled"]')?.textContent).toContain("Created Pickle"));
    expect(flow.submit).toHaveBeenCalledOnce();
    expect(sentTexts()).toEqual(["I created Pickle."]);
  });

  it("a reply that keeps failing settles after the first try and two Retries", async () => {
    sendDm.mockResolvedValue({ ok: false, message: "network down" });
    await openSetupDm([teamMessage]);
    await create("Pickle");
    await backToSetupBot();

    (await waitFor<HTMLButtonElement>('[data-testid="team-card-retry"]')).click();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(2));
    (await waitFor<HTMLButtonElement>('[data-testid="team-card-retry"]')).click();

    await vi.waitFor(() => expect(q('[data-testid="team-card-settled"]')?.textContent).toContain("Created Pickle"));
    expect(sendDm).toHaveBeenCalledTimes(3);
    expect(flow.submit).toHaveBeenCalledOnce();
    expect(logToFile.mock.calls.some((call) => String(call[1]).includes("kind=team-card event=reply-abandoned"))).toBe(true);
  });

  /** The pending create kept for the setup bot's card. */
  function storedCreating(): unknown {
    const raw = window.localStorage.getItem("hq.firstRun.teamCard.v1");
    const entries = raw ? (JSON.parse(raw) as Record<string, { creating?: unknown }>) : {};
    return entries[`prs_me:${SETUP_UID}`]?.creating ?? null;
  }

  /** The card holds no name: the field takes what is typed and every other pick is open. */
  function expectUnlocked(): void {
    typeName("Brine");
    expect(q<HTMLInputElement>('[data-testid="team-card-name"]')!.value).toBe("Brine");
    expect(q<HTMLButtonElement>('[data-testid="team-card-personal"]')!.disabled).toBe(false);
  }

  it("a create sent again after a timeout and refused keeps the card on its name, and only looks for the company", async () => {
    flow.submit
      .mockResolvedValueOnce({ ok: false, reason: CREATE_COMPANY_NO_RESULT_REASON, blocked: false })
      .mockResolvedValueOnce({ ok: false, reason: "That handle is taken.", blocked: true });
    const props = await openSetupDm([teamMessage]);
    await create("Pickle");
    await waitFor('[data-testid="team-card-error"]');

    // Not in the roster yet: the same name is sent again, and the server
    // refuses it; the handle check does not say it is someone else's.
    renameAndCreate();
    await vi.waitFor(() => expect(flow.submit).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(q('[data-testid="team-card"]')?.getAttribute("aria-busy")).toBe("false"));
    await waitFor('[data-testid="team-card-error"]');
    expect(checkCompanySlug).toHaveBeenCalledWith("pickle");
    expect(q<HTMLInputElement>('[data-testid="team-card-name"]')!.value).toBe("Pickle");

    // The company shows up; Retry only looks, and finds it.
    props.companies = [pickleWorkspace()] as never;
    (await waitFor<HTMLButtonElement>('[data-testid="team-card-retry"]')).click();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledOnce());
    await toSetupBot();
    await vi.waitFor(() => expect(q('[data-testid="team-card-settled"]')?.textContent).toContain("Created Pickle"));
    expect(flow.submit).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(flow.submit.mock.calls)).not.toMatch(/brine/i);
    expect(sentTexts()).toEqual(["I created Pickle."]);
  });

  it("a lookup that never finds the company unlocks the card after two looks, and a later find still settles it", async () => {
    flow.submit
      .mockResolvedValueOnce({ ok: false, reason: CREATE_COMPANY_NO_RESULT_REASON, blocked: false })
      .mockResolvedValueOnce({ ok: false, reason: "That handle is taken.", blocked: true });
    const messages = [teamMessage];
    const props = await openSetupDm(messages);
    await create("Pickle");
    await waitFor('[data-testid="team-card-error"]');

    // First look: not found, refused, still locked on the name.
    renameAndCreate();
    await vi.waitFor(() => expect(flow.submit).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(q('[data-testid="team-card"]')?.getAttribute("aria-busy")).toBe("false"));
    expect(q<HTMLButtonElement>('[data-testid="team-card-personal"]')!.disabled).toBe(true);

    // Second look: still not found. The card unlocks with the same error line.
    renameAndCreate();
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="team-card-personal"]')?.disabled).toBe(false));
    expect(q('[data-testid="team-card-error"]')?.textContent).toContain("Something went wrong. Try again.");
    expect(flow.submit).toHaveBeenCalledTimes(2);
    expectUnlocked();
    // The old name stays only as a lookup hint, across a restart too.
    expect(storedCreating()).toEqual({ name: "Pickle", slug: "pickle", failedLooks: 2 });
    await restart(messages);
    (await waitFor<HTMLButtonElement>('[data-testid="team-card-create"]')).click();
    await waitFor('[data-testid="team-card-name"]');
    expectUnlocked();

    // The company shows up later: a create under another name finds it and creates nothing.
    props.companies = null;
    const after = await restart(messages);
    after.companies = [pickleWorkspace()] as never;
    await create("Brine");
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledOnce());
    await toSetupBot();
    await vi.waitFor(() => expect(q('[data-testid="team-card-settled"]')?.textContent).toContain("Created Pickle"));
    expect(flow.submit).toHaveBeenCalledTimes(2);
    expect(sentTexts()).toEqual(["I created Pickle."]);
  });

  it("an unlocked card still lets the person work solo", async () => {
    flow.submit
      .mockResolvedValueOnce({ ok: false, reason: CREATE_COMPANY_NO_RESULT_REASON, blocked: false })
      .mockResolvedValueOnce({ ok: false, reason: "That handle is taken.", blocked: true });
    await openSetupDm([teamMessage]);
    await create("Pickle");
    await waitFor('[data-testid="team-card-error"]');
    renameAndCreate();
    await vi.waitFor(() => expect(flow.submit).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(q('[data-testid="team-card"]')?.getAttribute("aria-busy")).toBe("false"));
    renameAndCreate();
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="team-card-personal"]')?.disabled).toBe(false));

    q<HTMLButtonElement>('[data-testid="team-card-personal"]')!.click();
    await vi.waitFor(() => expect(q('[data-testid="team-card-settled"]')?.textContent).toContain("Working solo"));
    expect(sentTexts()).toEqual(["Just me for now."]);
  });

  it("a handle taken by someone else clears the pending create at once and unlocks the card", async () => {
    flow.submit
      .mockResolvedValueOnce({ ok: false, reason: CREATE_COMPANY_NO_RESULT_REASON, blocked: false })
      .mockResolvedValueOnce({ ok: false, reason: "That handle is taken.", blocked: true });
    checkCompanySlug.mockResolvedValue(ok({ valid: true, available: false, normalized: "pickle" }));
    await openSetupDm([teamMessage]);
    await create("Pickle");
    await waitFor('[data-testid="team-card-error"]');
    expect(storedCreating()).toEqual({ name: "Pickle", slug: "pickle" });

    renameAndCreate();
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="team-card-personal"]')?.disabled).toBe(false));
    expect(checkCompanySlug).toHaveBeenCalledWith("pickle");
    expect(q('[data-testid="team-card-error"]')?.textContent).toContain("That handle is taken.");
    expect(storedCreating()).toBeNull();
    expectUnlocked();

    // A new name creates.
    q<HTMLButtonElement>('[data-testid="team-card-create-submit"]')!.click();
    await vi.waitFor(() => expect(flow.submit).toHaveBeenCalledTimes(3));
    expect(JSON.stringify(flow.submit.mock.calls[2])).toMatch(/brine/i);
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledOnce());
    // The create switches into Brine; once that has landed, come back to the setup bot.
    await vi.waitFor(() => {
      if (!q('[data-testid="team-card-settled"]')) q<HTMLElement>(`[data-conversation-id="${SETUP_DM_ROW.id}"]`)?.click();
      expect(q('[data-testid="team-card-settled"]')?.textContent).toContain("Created Brine");
    });
    expect(sentTexts()).toEqual(["I created Brine."]);
  });

  it("the failed sends of a reply count across a restart", async () => {
    sendDm.mockResolvedValue({ ok: false, message: "network down" });
    const messages = [teamMessage];
    await openSetupDm(messages);
    await create("Pickle");
    await backToSetupBot();
    await waitFor('[data-testid="team-card-error"]');

    await restart(messages);
    await waitFor('[data-testid="team-card-name"]');
    renameAndCreate();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(2));
    (await waitFor<HTMLButtonElement>('[data-testid="team-card-retry"]')).click();

    await vi.waitFor(() => expect(q('[data-testid="team-card-settled"]')?.textContent).toContain("Created Pickle"));
    expect(sendDm).toHaveBeenCalledTimes(3);
    expect(flow.submit).toHaveBeenCalledOnce();
  });

  it("a lock the browser cannot store still holds for the session", async () => {
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === "hq.firstRun.teamCard.v1") throw new Error("quota");
      setItem.call(this, key, value);
    });
    flow.submit.mockResolvedValueOnce({ ok: false, reason: CREATE_COMPANY_NO_RESULT_REASON, blocked: false });
    const props = await openSetupDm([teamMessage]);
    await create("Pickle");
    await waitFor('[data-testid="team-card-error"]');

    props.companies = [pickleWorkspace()] as never;
    renameAndCreate();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledOnce());
    await toSetupBot();
    await vi.waitFor(() => expect(q('[data-testid="team-card-settled"]')?.textContent).toContain("Created Pickle"));
    expect(flow.submit).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalled();
  });
});
