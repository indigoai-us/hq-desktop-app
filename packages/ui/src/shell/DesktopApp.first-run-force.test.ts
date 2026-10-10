// @vitest-environment happy-dom

/**
 * The dev-only build switches (dev-switches.ts, docs/dev-switches.md), as a
 * build that set them sees them. FORCE alone: the takeover opens every launch and the walk is real.
 * (Off by default: dev-switches.test.ts; every other shell test runs with them off.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, VISUAL_FIRST_RUN_FLAG, type PlatformAdapter } from "@hq/platform";

vi.mock("../chat/first-run/dev-switches.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chat/first-run/dev-switches.js")>();
  return { ...actual, FIRST_RUN_DEV_SWITCHES: { force: true, dry: false }, FIRST_RUN_DRY_DELAY_MS: 0 };
});

import DesktopApp from "./DesktopApp.svelte";
import ExtraPageProbe from "./ExtraPageProbe.test.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { WELCOME_SETUP_RUN_KEY } from "../chat/setup-channel.js";
import { VISUAL_FIRST_RUN_DONE_KEY } from "../chat/first-run/visual-first-run.js";
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



describe("VITE_HQ_DEV_FIRST_RUN_FORCE alone (a real walk)", () => {
  it("opens the takeover after setup ran, without reading the flag, and creates the named setup bot", async () => {
    window.localStorage.setItem(WELCOME_SETUP_RUN_KEY, "1");
    window.localStorage.setItem(VISUAL_FIRST_RUN_DONE_KEY, "1");
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const { platform, hasFeature } = adapter({ create, flag: false });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    expect(hasFeature).not.toHaveBeenCalledWith(VISUAL_FIRST_RUN_FLAG);
    typeName("Biscuit");
    pressEnter();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ displayName: "Biscuit", worker: "setup" }));
  });
});
