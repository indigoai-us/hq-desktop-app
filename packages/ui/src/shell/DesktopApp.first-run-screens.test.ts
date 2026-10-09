// @vitest-environment happy-dom

/**
 * Visual first run, slices 2 and 5, through the real shell: "Your team"
 * joins an invite through the invite claim, Note taker and Project
 * management read the integrations catalog and connect inline, and what
 * they settled reaches the setup bot as one bot-only note when the takeover
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
import { firstRunKickoff, firstRunSettledNotice } from "../chat/first-run/visual-first-run.js";
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

async function boot(platform: PlatformAdapter, companies: unknown[] = []): Promise<void> {
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
    expect(q('[data-testid="first-run-summary-team"]')?.textContent).toBe("Joined Acme Robotics");
    expect(q('[data-testid="first-run-summary-notes"]')?.textContent?.trim()).toBe("Granola, connected");
    expect(q('[data-testid="first-run-summary-projects"]')?.textContent?.trim()).toBe("Skipped");
    expect(sendDm).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    q<HTMLButtonElement>('[data-testid="first-run-talk"]')!.click();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    const [to, body, extras] = sendDm.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(to).toBe(SETUP_BOT_UID);
    expect(extras).toEqual({ audience: "agent", idempotencyKey: `first-run-settled:${SETUP_BOT_UID}` });
    expect(body).toBe(
      firstRunSettledNotice({
        team: { kind: "company", how: "joined", name: "Acme Robotics", slug: "acme" },
        apps: { notes: { name: "Granola", domain: "granola.ai" }, projects: null },
      }),
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("Finish with defaults settles Just me before the create, so the kickoff carries it and no extra note goes", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const claim = vi.fn(async () => ok({ ok: true }));
    const { platform, sendDm } = adapter({ create, flag: true, claim, integrations: integrationsApi() });
    await boot(platform, ROSTER);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    typeName("Biscuit");
    q<HTMLButtonElement>('[data-testid="new-bot-finish-name"]')!.click();
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    expect(q('[data-testid="first-run-summary-team"]')?.textContent).toBe("Just me");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        kickoff: firstRunKickoff({ name: "Biscuit", runtime: "claude", toolsReady: ["claude"], team: { kind: "personal" }, apps: {} }),
      }),
    );
    q<HTMLButtonElement>('[data-testid="first-run-continue-in-chat"]')!.click();
    await settle();
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();
    expect(sendDm).not.toHaveBeenCalled();
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
