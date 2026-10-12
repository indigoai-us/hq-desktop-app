// @vitest-environment happy-dom

/**
 * Visual first run, slices 2 and 5, through the real shell: "Your team"
 * joins an invite through the invite claim, Note taker and Project
 * management read the integrations catalog and connect inline. The setup
 * bot is created with no kickoff while the takeover is open, and everything
 * the takeover settled (the import included) reaches it as ONE bot-only note
 * when the takeover closes. Flag off, none of it runs: no claim, no catalog
 * read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, VISUAL_FIRST_RUN_FLAG, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import ExtraPageProbe from "./ExtraPageProbe.test.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { SETUP_BOT_KICKOFF } from "../chat/setup-bot.js";
import { firstRunHandoffNotice } from "../chat/first-run/visual-first-run.js";
import type { SetupRunApi, SetupRunSnapshot } from "../chat/setup-run.js";

const SETUP_BOT_UID = "agt_setup";

interface AdapterOptions {
  create?: NonNullable<PlatformAdapter["bots"]>["create"];
  /** `hq bot list` rows (a setup bot that already exists here). */
  bots?: unknown[];
  /** Answer `hasFeature` for the flag this way instead (timing tests). */
  hasFeatureImpl?: (name: string) => Promise<unknown>;
  /** Answer the host's setup status this way instead (timing tests). */
  setupStatusImpl?: () => Promise<unknown>;

  /** `desktop.visual-first-run`; undefined leaves `hasFeature` answering false for it. */
  flag?: boolean;
  claudeLoggedIn?: boolean;
  /** Joining invites and the integrations catalog (slices 2 and 5). */
  claim?: (slug: string) => Promise<unknown>;
  integrations?: Record<string, unknown>;
}

function adapter({
  create,
  flag = false,
  claudeLoggedIn = true,
  bots = [],
  hasFeatureImpl,
  setupStatusImpl,
  claim,
  integrations,
}: AdapterOptions = {}) {
  const hasFeature = vi.fn(
    hasFeatureImpl ?? (async (name: string) => ok(name === VISUAL_FIRST_RUN_FLAG ? flag : false)),
  );
  const updateAgentProfile = vi.fn(async () => ok({}));
  const sendDm = vi.fn(async () => ok({ eventId: "evt_1", createdAt: new Date().toISOString() }));
  const platform = {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    identity: { hasFeature, updateAgentProfile },
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ({ ok: false as const, reason: "unavailable" }),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
      sendDm,
    },
    settings: {
      getSetupStatus:
        setupStatusImpl ??
        (async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ", welcomeSetupOwed: true })),
    },
    shell: {
      detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
    },
    sessions: {
      preflight: async () =>
        ok({
          claudeAvailable: true,
          claudeLoggedIn,
          codexAvailable: false,
          codexLoggedIn: false,
          grokAvailable: false,
          grokLoggedIn: false,
        }),
    },
    ...(claim ? { company: { claimPendingInvite: claim } } : {}),
    ...(integrations ? { integrations } : {}),
    bots: {
      list: async () => ok({ bots }),
      create: create ?? (async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID })),
      start: async () => ok({}),
      stop: async () => ok({}),
      remove: async () => ok({}),
      workers: async () => ok({ workers: [] }),
      // The real sign-in check (`hq bot probe`) passes: the stored login works.
      probe: async () => ok({ ok: true, class: null }),
    },
  } as unknown as PlatformAdapter;
  return { platform, hasFeature, updateAgentProfile, sendDm };
}

function fakeSetupRun(): SetupRunApi {
  return {
    preflight: vi.fn(async () => "ready" as const),
    start: vi.fn(async () => "sess-1"),
    attach: vi.fn(async () => true),
    subscribe: vi.fn((sessionId: string, cb: (snapshot: SetupRunSnapshot) => void) => {
      cb({ sessionId, events: [], phase: "starting" });
      return () => undefined;
    }),
    answerQuestion: vi.fn(async () => undefined),
    respondPermission: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    providers: vi.fn(async () => ({
      hqReady: true,
      claudeAvailable: true,
      claudeLoggedIn: true,
      codexAvailable: false,
      codexLoggedIn: false,
    })),
    providerLoginStart: vi.fn(async () => ({ state: "waiting" as const })),
    providerLoginStatus: vi.fn(async () => ({ state: "waiting" as const })),
    providerLoginCancel: vi.fn(async () => ({ state: "disconnected" as const })),
    providerInstallUrl: vi.fn(() => "https://claude.ai/download"),
    openExternal: vi.fn(async () => undefined),
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document.querySelectorAll('[data-testid="first-run-takeover"]').forEach((el) => el.remove());
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

async function boot(platform: PlatformAdapter, companies: unknown[] = [], syncEvents?: unknown): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: platform,
      companies: companies as never,
      rosterStatus: "ready",
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Test", email: "test@example.com" },
      coreFixtures: false,
      ...(syncEvents ? { syncEvents: syncEvents as never } : {}),
      extraPages: {
        sessions: {
          label: "Sessions",
          detail: "Local sessions",
          component: ExtraPageProbe,
          setupAction: { label: "Run Setup", param: () => "new?draft=x" },
          setupRun: fakeSetupRun(),
        },
      },
    },
  });
  await settle();
}

function step(): string | null {
  return q('[data-testid="first-run-step"]')?.getAttribute("data-step") ?? null;
}

function typeName(value: string): void {
  const input = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressEnter(): void {
  q<HTMLInputElement>('[data-testid="new-bot-name"]')!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
}


function workspace(slug: string, displayName: string, status: "active" | "pending"): Record<string, unknown> {
  return {
    slug,
    displayName,
    kind: "company",
    state: status === "active" ? "synced" : "cloud-only",
    cloudUid: `cmp_${slug}`,
    bucketName: null,
    hasLocalFolder: status === "active",
    localPath: null,
    membershipStatus: status,
    role: null,
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
  };
}
const ROSTER = [workspace("acme", "Acme Robotics", "pending")];

function integrationsApi() {
  const connected: Array<Record<string, unknown>> = [];
  return {
    catalogSearch: vi.fn(async () =>
      ok({
        ok: true,
        entries: [
          { name: "Granola", domain: "granola.ai", authClass: "none" },
          { name: "Linear", domain: "linear.app", authClass: "oauth" },
          { name: "Notion", domain: "notion.so", authClass: "oauth" },
        ],
      }),
    ),
    listConnections: vi.fn(async () => ok({ viewer: { canManageIntegrations: true }, connections: connected })),
    install: vi.fn(async (input: { domain: string }) => {
      connected.push({ id: "c1", status: "connected", createdAt: new Date().toISOString(), installation: { domain: input.domain } });
      return ok({ connection: { id: "c1" } });
    }),
    startOAuth: vi.fn(),
    grantConnectionAccess: vi.fn(),
    blueprint: vi.fn(),
  };
}

describe("visual first run with Your team, Note taker and Project management", () => {
  it("joins the invite once, connects a note taker, skips project management, and hands it all to the assistant", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const claim = vi.fn(async () => ok({ ok: true, claimedSlugs: ["acme"], message: "Joined" }));
    const integrations = integrationsApi();
    const { platform, sendDm } = adapter({ create, flag: true, claim, integrations });
    await boot(platform, ROSTER);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());

    typeName("Biscuit");
    pressEnter();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await settle();
    expect(step()).toBe("team");
    // Nothing is joined by default: Just me is picked until the person picks the invite.
    expect(q('[data-testid="first-run-team-personal"]')?.getAttribute("aria-checked")).toBe("true");
    q<HTMLButtonElement>('[data-testid="first-run-team-invite:acme"]')!.click();
    await settle();
    const next = () => q<HTMLButtonElement>('[data-testid="first-run-next"]')!;
    next().click();
    next().click();
    await vi.waitFor(() => expect(step()).toBe("tools"));
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith("acme");

    next().click();
    await settle();
    expect(step()).toBe("notes");
    await vi.waitFor(() => expect(q('[data-testid="first-run-connect-granola.ai"]')).toBeTruthy());
    expect(integrations.catalogSearch).toHaveBeenCalledWith("cmp_acme", "", 100);
    // Only note takers: Linear and Notion are not on this screen.
    expect(q('[data-testid="first-run-app-linear.app"]')).toBeNull();
    q<HTMLButtonElement>('[data-testid="first-run-connect-granola.ai"]')!.click();
    await vi.waitFor(() => expect(q('[data-testid="first-run-notes-connected"]')).toBeTruthy());
    expect(integrations.install).toHaveBeenCalledWith({ companyUid: "cmp_acme", domain: "granola.ai" });

    next().click();
    await settle();
    expect(step()).toBe("projects");
    await vi.waitFor(() => expect(q('[data-testid="first-run-connect-linear.app"]')).toBeTruthy());
    next().click();
    await settle();
    expect(step()).toBe("done");
    expect(q('[data-testid="first-run-summary-team"]')?.textContent).toMatch(/^Joined /);
    expect(q('[data-testid="first-run-summary-team"] .company-label-name')?.textContent).toBe("Acme Robotics");
    expect(q('[data-testid="first-run-summary-notes"]')?.textContent?.trim()).toBe("Granola, connected");
    expect(q('[data-testid="first-run-summary-projects"]')?.textContent?.trim()).toBe("Skipped");
    expect(sendDm).not.toHaveBeenCalled();
    // The create ran no kickoff: the assistant has said nothing past its hello.
    expect((create.mock.calls[0] as unknown as [Record<string, unknown>])[0]).not.toHaveProperty("kickoff");

    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    q<HTMLButtonElement>('[data-testid="first-run-talk"]')!.click();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    const [to, body, extras] = sendDm.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(to).toBe(SETUP_BOT_UID);
    expect(extras).toEqual({ audience: "agent", idempotencyKey: `first-run-handoff:${SETUP_BOT_UID}` });
    expect(body).toBe(
      firstRunHandoffNotice(
        {
          name: "Biscuit",
          runtime: "claude",
          toolsReady: ["claude"],
          signInChecked: true,
          team: { kind: "company", how: "joined", name: "Acme Robotics", slug: "acme" },
          apps: { notes: { name: "Granola", domain: "granola.ai" }, projects: null },
        },
        { noun: "computer" },
      ),
    );
    await settle(12);
    expect(sendDm).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("Finish with defaults settles Just me; the create runs no kickoff and Continue in chat sends the one note", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const claim = vi.fn(async () => ok({ ok: true }));
    const { platform, sendDm } = adapter({ create, flag: true, claim, integrations: integrationsApi() });
    await boot(platform, ROSTER);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    typeName("Biscuit");
    q<HTMLButtonElement>('[data-testid="new-bot-finish-name"]')!.click();
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    expect(q('[data-testid="first-run-summary-team"]')?.textContent).toBe("Just me");
    expect((create.mock.calls[0] as unknown as [Record<string, unknown>])[0]).not.toHaveProperty("kickoff");
    expect(sendDm).not.toHaveBeenCalled();
    q<HTMLButtonElement>('[data-testid="first-run-continue-in-chat"]')!.click();
    await settle();
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    expect((sendDm.mock.calls[0] as unknown as [string, string])[1]).toBe(
      firstRunHandoffNotice(
        { name: "Biscuit", runtime: "claude", toolsReady: ["claude"], signInChecked: true, team: { kind: "personal" }, apps: {} },
        { noun: "computer" },
      ),
    );
    expect(claim).not.toHaveBeenCalled();
  });
});

describe("settled parts reach the assistant whatever the order", () => {
  it("a create that runs after the team is settled still carries no kickoff; the one closing note has the team and the apps", async () => {
    // The first create fails (it runs at the name step, before Your team);
    // Retry runs it after the team is settled, as a create that waited for a
    // coding tool would.
    const create = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, reason: "unavailable" as const, message: "Claude Code is not signed in." })
      .mockResolvedValue(ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const claim = vi.fn(async () => ok({ ok: true, claimedSlugs: ["acme"], message: "Joined" }));
    const integrations = integrationsApi();
    const { platform, sendDm } = adapter({ create: create as never, flag: true, claim, integrations });
    await boot(platform, ROSTER);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    typeName("Biscuit");
    pressEnter();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await settle();
    expect(step()).toBe("team");
    q<HTMLButtonElement>('[data-testid="first-run-team-invite:acme"]')!.click();
    await settle();
    q<HTMLButtonElement>('[data-testid="first-run-next"]')!.click();
    await vi.waitFor(() => expect(step()).toBe("tools"));
    await vi.waitFor(() => expect(q('[data-testid="first-run-retry"]')).toBeTruthy());
    q<HTMLButtonElement>('[data-testid="first-run-retry"]')!.click();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect((create.mock.calls as unknown as Array<[Record<string, unknown>]>)[1]![0]).not.toHaveProperty("kickoff");
    await vi.waitFor(() => expect(q('[data-testid="first-run-create-status"]')?.getAttribute("data-state")).toBe("ready"));

    q<HTMLButtonElement>('[data-testid="first-run-next"]')!.click();
    await vi.waitFor(() => expect(step()).toBe("notes"));
    await vi.waitFor(() => expect(q('[data-testid="first-run-connect-granola.ai"]')).toBeTruthy());
    q<HTMLButtonElement>('[data-testid="first-run-connect-granola.ai"]')!.click();
    await vi.waitFor(() => expect(q('[data-testid="first-run-notes-connected"]')).toBeTruthy());
    q<HTMLButtonElement>('[data-testid="first-run-next"]')!.click();
    await vi.waitFor(() => expect(step()).toBe("projects"));
    q<HTMLButtonElement>('[data-testid="first-run-next"]')!.click();
    await vi.waitFor(() => expect(step()).toBe("done"));
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    q<HTMLButtonElement>('[data-testid="first-run-talk"]')!.click();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    const body = (sendDm.mock.calls[0] as unknown as [string, string])[1];
    // Everything, whatever order it settled in, in the one note.
    expect(JSON.parse(body.match(/Handoff from the app: (\{.*?\})\. /)![1]!).done).toEqual([
      "name",
      "codingTools",
      "company",
      "noteTaker",
      "projectManagement",
    ]);
    expect(body).toContain('"team":{"kind":"company","how":"joined","name":"Acme Robotics","slug":"acme"}');
    expect(body).toContain('"apps":{"notes":{"name":"Granola","domain":"granola.ai"},"projects":"skipped"}');
    await settle(12);
    expect(sendDm).toHaveBeenCalledTimes(1);
  });
});

/**
 * The scan host the context step runs on: `scanStart` waits for `finish`,
 * and `emit` pushes the scan's progress lines through the event bus.
 */
function contextImportHost(platform: PlatformAdapter) {
  const handlers = new Set<(e: { payload?: unknown }) => void>();
  const syncEvents = {
    listen: vi.fn(async (_event: string, h: (e: { payload?: unknown }) => void) => {
      handlers.add(h);
      return () => handlers.delete(h);
    }),
    emit: vi.fn(async () => undefined),
  };
  let finishScan: (v: unknown) => void = () => undefined;
  const scanStart = vi.fn((_scanId: string) => new Promise((resolve) => (finishScan = resolve)));
  const scanCancel = vi.fn(async () => ok(true));
  (platform as unknown as Record<string, unknown>).contextImport = { scanStart, scanCancel };
  return {
    syncEvents,
    scanStart,
    scanCancel,
    finish(lines: Array<Record<string, unknown>>): void {
      const scanId = scanStart.mock.calls[0]![0];
      for (const line of lines) handlers.forEach((h) => h({ payload: { scanId, event: { v: 1, ...line } } }));
      finishScan(ok({ status: "done", lines: lines.length, dropped: 0 }));
    },
  };
}

/**
 * Owner run rc-run-1011-1449, 2026-10-11, in the order it happened: the
 * assistant was created (and its kickoff turn started) at the tools step;
 * the takeover's scan finished a few seconds later; the person passed Note
 * taker and Project management; then Done. The assistant's first message
 * offered the import the takeover had just done, a late import note made it
 * post "You can skip my last question", and a late settled note made it post
 * a third message. Now: no turn and no note while the takeover is open, then
 * one note at close carrying every outcome, the import included.
 */
describe("owner run rc-run-1011-1449: the assistant gets every outcome before its first turn", () => {
  it("creates with no kickoff, sends nothing while the takeover is open, then one note with the import, the team and the apps", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const claim = vi.fn(async () => ok({ ok: true, claimedSlugs: ["acme"], message: "Joined" }));
    const integrations = integrationsApi();
    const { platform, sendDm } = adapter({ create, flag: true, claim, integrations });
    const scan = contextImportHost(platform);
    await boot(platform, ROSTER, scan.syncEvents);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    const next = () => q<HTMLButtonElement>('[data-testid="first-run-next"]')!;

    // 1. The assistant is created early, as in the run, but runs no turn.
    typeName("Fluffy");
    pressEnter();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const input = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(input).not.toHaveProperty("kickoff");
    expect(String(input.intro)).not.toContain("checking your");
    await settle();
    expect(step()).toBe("team");
    q<HTMLButtonElement>('[data-testid="first-run-team-invite:acme"]')!.click();
    await settle();
    next().click();
    next().click();
    await vi.waitFor(() => expect(step()).toBe("tools"));
    next().click();
    await vi.waitFor(() => expect(step()).toBe("context"));

    // 2. The takeover's scan runs and finishes after the create.
    await vi.waitFor(() => expect(q('[data-testid="first-run-import-start"]')).toBeTruthy(), { timeout: 3000 });
    q<HTMLButtonElement>('[data-testid="first-run-import-start"]')!.click();
    await vi.waitFor(() => expect(scan.scanStart).toHaveBeenCalledTimes(1));
    scan.finish([
      { type: "start", sources: [{ id: "claude-code", label: "Claude Code" }] },
      { type: "source", id: "claude-code", status: "done", counts: { sessions: 7 } },
      { type: "done", report: "workspace/imports/20261011T221646Z/report.json", summary: { companies: 3, projects: 6, sessions: 7 } },
    ]);
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-next"]')?.disabled).toBe(false), { timeout: 3000 });
    await settle(12);
    // No note for the import: the assistant hears nothing while the takeover is open.
    expect(sendDm).not.toHaveBeenCalled();

    // 3. Note taker and Project management, both passed.
    next().click();
    await vi.waitFor(() => expect(step()).toBe("notes"));
    next().click();
    await vi.waitFor(() => expect(step()).toBe("projects"));
    next().click();
    await vi.waitFor(() => expect(step()).toBe("done"));
    await settle(12);
    expect(sendDm).not.toHaveBeenCalled();

    // 4. Done: exactly one note, with everything.
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    q<HTMLButtonElement>('[data-testid="first-run-talk"]')!.click();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    const [to, body, extras] = sendDm.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(to).toBe(SETUP_BOT_UID);
    expect(extras).toEqual({ audience: "agent", idempotencyKey: `first-run-handoff:${SETUP_BOT_UID}` });
    const json = JSON.parse(body.match(/Handoff from the app: (\{.*?\})\. /)![1]!);
    expect(json.done).toEqual(["name", "codingTools", "company", "import", "noteTaker", "projectManagement"]);
    expect(json.import).toEqual({
      companies: 3,
      projects: 6,
      sessions: 7,
      report: "workspace/imports/20261011T221646Z/report.json",
    });
    expect(json.apps).toEqual({ notes: "skipped", projects: "skipped" });
    expect(body).toContain("do not offer it, ask me about it or scan this computer again");
    expect(body).toBe(
      firstRunHandoffNotice(
        {
          name: "Fluffy",
          runtime: "claude",
          toolsReady: ["claude"],
          signInChecked: true,
          imported: { summary: { companies: 3, projects: 6, sessions: 7 }, report: "workspace/imports/20261011T221646Z/report.json" },
          team: { kind: "company", how: "joined", name: "Acme Robotics", slug: "acme" },
          apps: { notes: null, projects: null },
        },
        { noun: "computer" },
      ),
    );

    // 5. Nothing after it: no second note for the assistant to answer.
    await settle(20);
    expect(sendDm).toHaveBeenCalledTimes(1);
    expect(scan.scanCancel).not.toHaveBeenCalled();
  });
});

describe("flag off, with the team and apps hosts available", () => {
  it("is today's first run, unchanged: no takeover, no claim, no catalog read", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const claim = vi.fn(async () => ok({ ok: true }));
    const integrations = integrationsApi();
    const { platform, hasFeature } = adapter({ create, flag: false, claim, integrations });
    await boot(platform, ROSTER);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(hasFeature).toHaveBeenCalledWith(VISUAL_FIRST_RUN_FLAG);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ kickoff: SETUP_BOT_KICKOFF }));
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();
    await settle();
    expect(claim).not.toHaveBeenCalled();
    expect(integrations.catalogSearch).not.toHaveBeenCalled();
    expect(integrations.install).not.toHaveBeenCalled();
  });
});
