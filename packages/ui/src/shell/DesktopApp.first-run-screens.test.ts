// @vitest-environment happy-dom

/**
 * Visual first run through the real shell, with the team and apps hosts
 * available. The decision takeover has no team or apps screens: it joins no
 * invite and reads no integrations catalog. The setup bot is created with no
 * kickoff while the takeover is open, and everything the takeover settled
 * (the import included) reaches it as ONE bot-only note when the takeover
 * closes. Flag off, none of it runs: no claim, no catalog read.
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

/** Wait for the decision screen's question. */
async function decisionShown(timeout = 1000): Promise<void> {
  await vi.waitFor(() => expect(q('[data-testid="first-run-decision-question"]')).toBeTruthy(), { timeout });
}

/** Pick the bot path (a signed-in coding tool opens on the tool path). */
async function chooseBot(): Promise<void> {
  const path = () => q('[data-testid="first-run-decision"]')?.getAttribute("data-path");
  if (path() === "tool") {
    q<HTMLButtonElement>('[data-testid="first-run-decision-other"]')!.click();
    await settle();
  }
  expect(path()).toBe("bot");
}

function typeName(value: string): void {
  const input = q<HTMLInputElement>('[data-testid="first-run-bot-name"]')!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function confirmName(): void {
  q<HTMLButtonElement>('[data-testid="first-run-decision-primary"]')!.click();
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

describe("visual first run with a pending invite and the integrations host available", () => {
  it("joins nothing, reads no catalog, shows no team or apps screen, and the one closing note settles no team and no apps", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const claim = vi.fn(async () => ok({ ok: true, claimedSlugs: ["acme"], message: "Joined" }));
    const integrations = integrationsApi();
    const { platform, sendDm } = adapter({ create, flag: true, claim, integrations });
    await boot(platform, ROSTER);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    await decisionShown();
    await chooseBot();
    typeName("Biscuit");
    confirmName();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    expect(step()).toBe("done");
    // No team or apps screen, and no summary rows for them.
    expect(q('[data-testid="first-run-team-personal"]')).toBeNull();
    expect(q('[data-testid="first-run-team-invite:acme"]')).toBeNull();
    expect(q('[data-testid="first-run-summary-team"]')).toBeNull();
    expect(q('[data-testid="first-run-summary-notes"]')).toBeNull();
    expect(q('[data-testid="first-run-summary-projects"]')).toBeNull();
    // The create ran no kickoff, and nothing is sent while the takeover is open.
    expect((create.mock.calls[0] as unknown as [Record<string, unknown>])[0]).not.toHaveProperty("kickoff");
    await settle(12);
    expect(sendDm).not.toHaveBeenCalled();

    q<HTMLButtonElement>('[data-testid="first-run-talk"]')!.click();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    const [to, body, extras] = sendDm.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(to).toBe(SETUP_BOT_UID);
    expect(extras).toEqual({ audience: "agent", idempotencyKey: `first-run-handoff:${SETUP_BOT_UID}` });
    expect(body).toBe(
      firstRunHandoffNotice(
        { name: "Biscuit", runtime: "claude", toolsReady: ["claude"], signInChecked: false, team: null, apps: {} },
        { noun: "computer" },
      ),
    );
    expect(JSON.parse(body.match(/Handoff from the app: (\{.*?\})\. /)![1]!).done).toEqual(["name", "codingTools"]);
    await settle(12);
    expect(sendDm).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(claim).not.toHaveBeenCalled();
    expect(integrations.catalogSearch).not.toHaveBeenCalled();
    expect(integrations.install).not.toHaveBeenCalled();
  });
});

describe("a create that runs again on Retry", () => {
  it("still carries no kickoff; the one closing note goes out at close with no team and no apps", async () => {
    // The first create fails; Retry on the done screen runs it again.
    const create = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, reason: "unavailable" as const, message: "Claude Code is not signed in." })
      .mockResolvedValue(ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const claim = vi.fn(async () => ok({ ok: true, claimedSlugs: ["acme"], message: "Joined" }));
    const integrations = integrationsApi();
    const { platform, sendDm } = adapter({ create: create as never, flag: true, claim, integrations });
    await boot(platform, ROSTER);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    await decisionShown();
    await chooseBot();
    typeName("Biscuit");
    confirmName();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(q('[data-testid="first-run-done-retry"]')).toBeTruthy());
    expect(q('[data-testid="first-run-done-failed"]')).toBeTruthy();
    q<HTMLButtonElement>('[data-testid="first-run-done-retry"]')!.click();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect((create.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0]).not.toHaveProperty("kickoff");
    expect((create.mock.calls as unknown as Array<[Record<string, unknown>]>)[1]![0]).not.toHaveProperty("kickoff");
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    await settle(12);
    expect(sendDm).not.toHaveBeenCalled();
    q<HTMLButtonElement>('[data-testid="first-run-talk"]')!.click();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    const body = (sendDm.mock.calls[0] as unknown as [string, string])[1];
    const json = JSON.parse(body.match(/Handoff from the app: (\{.*?\})\. /)![1]!);
    expect(json.done).toEqual(["name", "codingTools"]);
    expect(json).not.toHaveProperty("team");
    expect(json).not.toHaveProperty("apps");
    await settle(12);
    expect(sendDm).toHaveBeenCalledTimes(1);
    expect(claim).not.toHaveBeenCalled();
  });
});

/**
 * The scan host the takeover runs on: `scanStart` waits for `finish`,
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
  it("scans first, creates with no kickoff, sends nothing while the takeover is open, then one note with the import", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const claim = vi.fn(async () => ok({ ok: true, claimedSlugs: ["acme"], message: "Joined" }));
    const integrations = integrationsApi();
    const { platform, sendDm } = adapter({ create, flag: true, claim, integrations });
    const scan = contextImportHost(platform);
    await boot(platform, ROSTER, scan.syncEvents);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());

    // 1. The takeover's scan starts by itself and finishes.
    await vi.waitFor(() => expect(scan.scanStart).toHaveBeenCalledTimes(1), { timeout: 3000 });
    scan.finish([
      { type: "start", sources: [{ id: "claude-code", label: "Claude Code" }] },
      { type: "source", id: "claude-code", status: "done", counts: { sessions: 7 } },
      { type: "done", report: "workspace/imports/20261011T221646Z/report.json", summary: { companies: 3, projects: 6, sessions: 7 } },
    ]);
    await decisionShown(3000);
    await settle(12);
    // No note for the import: the assistant does not exist yet, and hears nothing.
    expect(sendDm).not.toHaveBeenCalled();

    // 2. The assistant is created, and runs no turn.
    await chooseBot();
    typeName("Fluffy");
    confirmName();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const input = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(input).not.toHaveProperty("kickoff");
    expect(String(input.intro)).not.toContain("checking your");
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    expect(step()).toBe("done");
    await settle(12);
    expect(sendDm).not.toHaveBeenCalled();

    // 3. Done: exactly one note, with everything.
    q<HTMLButtonElement>('[data-testid="first-run-talk"]')!.click();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    const [to, body, extras] = sendDm.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(to).toBe(SETUP_BOT_UID);
    expect(extras).toEqual({ audience: "agent", idempotencyKey: `first-run-handoff:${SETUP_BOT_UID}` });
    const json = JSON.parse(body.match(/Handoff from the app: (\{.*?\})\. /)![1]!);
    expect(json.done).toEqual(["name", "codingTools", "import"]);
    expect(json.import).toEqual({
      companies: 3,
      projects: 6,
      sessions: 7,
      report: "workspace/imports/20261011T221646Z/report.json",
    });
    expect(body).toContain("do not offer it, ask me about it or scan this computer again");
    expect(body).toBe(
      firstRunHandoffNotice(
        {
          name: "Fluffy",
          runtime: "claude",
          toolsReady: ["claude"],
          signInChecked: false,
          imported: { summary: { companies: 3, projects: 6, sessions: 7 }, report: "workspace/imports/20261011T221646Z/report.json" },
          team: null,
          apps: {},
        },
        { noun: "computer" },
      ),
    );

    // 4. Nothing after it: no second note for the assistant to answer.
    await settle(20);
    expect(sendDm).toHaveBeenCalledTimes(1);
    expect(scan.scanCancel).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
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
