// @vitest-environment happy-dom

/**
 * Company-switch isolation — the canonical tenant-boundary seam test.
 *
 * Every other company test covers one piece: `company-store.svelte.test.ts`,
 * `tenant-storage.test.ts`, `meetings-cache.tenant.test.ts`. This one drives
 * the ACT of switching from company A to company B in a mounted DesktopApp and
 * asserts the whole surface re-scopes:
 *
 *  1. every tenant-scoped surface shows B (or nothing), never A;
 *  2. nothing from A is readable as B — not through a store, not through a
 *     storage key, not through the rendered DOM;
 *  3. switching back to A restores A's own state;
 *  4. an A request still in flight when the switch happens cannot paint into
 *     B's view when it finally resolves.
 *
 * The platform adapter is mocked at the NETWORK boundary only: the real
 * `createTenantStorage`, the real sidebar stores and the real shell wiring all
 * run, so a regression at the seam fails here rather than in a mock.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createTenantStorage } from "../identity/tenant-storage.js";
import {
  listDraftRowIds,
  loadDraft,
  saveDraft,
} from "../chat/messaging/composer-drafts.js";
import {
  CONVERSATION_CACHE_KEY,
  loadDmDots,
  loadPins,
  saveConversationCache,
  saveDmDots,
  savePins,
} from "../chat/sidebar-model.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";
import type {
  ChannelDirectoryFeed,
  ChannelDirectoryRow,
} from "../chat/channel-directory-reconciler.js";
import type { ChatSidebarApi } from "../chat/chat-api.js";
import type { Workspace } from "../chat/workspaces.js";

// ── Two tenants. Every A identifier is a distinct, greppable token. ──────────

const ACCOUNT_ID = "prs_owner";
const SELF = { uid: ACCOUNT_ID, displayName: "Ada Lovelace", email: "ada@x.y" };

const A_UID = "cmp_alpha";
const B_UID = "cmp_beta";
/** Never legitimately visible under company B — the leak canary. */
const A_CHANNEL = "alpha-secret";
const A_ROW_ID = `ch:${A_CHANNEL}`;
const B_CHANNEL = "beta-open";
const A_DRAFT_TEXT = "alpha-draft-canary";
const A_PERSON = "prs_alpha_only";
const A_PERSON_NAME = "Alphaonly Teammate";
const B_PERSON = "prs_beta_only";
const B_PERSON_NAME = "Betaonly Teammate";
const A_INFLIGHT_BODY = "alpha-inflight-canary";

function workspace(uid: string, slug: string, name: string): Workspace {
  return {
    slug,
    displayName: name,
    kind: "company",
    state: "synced",
    cloudUid: uid,
    role: "member",
    membershipStatus: "active",
  } as Workspace;
}

const COMPANIES: Workspace[] = [
  workspace(A_UID, "alpha", "Alpha"),
  workspace(B_UID, "beta", "Beta"),
];

function directoryRow(
  channelId: string,
  companyUid: string,
  unreadCount: number,
): ChannelDirectoryRow {
  return {
    channelId,
    type: "project",
    scope: "project",
    companyUid,
    name: channelId,
    subtitle: `${companyUid} · project`,
    lastActivityAt: new Date().toISOString(),
    unreadCount,
    memberCount: 3,
  };
}

/** The directory feed is NOT company-filtered server-side — the shell is what
 *  has to scope it. Serving both companies' rows is the honest fixture. */
const DIRECTORY_ROWS: ChannelDirectoryRow[] = [
  directoryRow(A_CHANNEL, A_UID, 3),
  directoryRow(B_CHANNEL, B_UID, 0),
];

// ── Harness ─────────────────────────────────────────────────────────────────

const memoryStorage = installMemoryLocalStorage();

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

/** Contact-roster calls made by the shell, with the scope each asked for. */
let rosterScopes: Array<string | null>;
/** Resolver for a channel fetch we deliberately leave in flight. */
let pendingChannelFetch: ((body: string) => void) | null;
let holdChannelFetch: boolean;
/** Resolver for company A's contact-roster fetch, held open across a switch. */
let pendingRoster: (() => void) | null;
let holdRosterFor: string | null;

function sidebarApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async (): Promise<ChannelDirectoryFeed> => ({
      contractVersion: 2,
      snapshot: true,
      cursor: "companyswitchcursor000000000000000000",
      cursorExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      rows: DIRECTORY_ROWS,
    }),
    listContacts: async () => ({ contacts: [] }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => ({ channels: [] }),
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    searchMessages: async () => ({ results: [] }),
  } as unknown as ChatSidebarApi;
}

function adapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async (args?: { companyUid?: string }) => {
        const scope = args?.companyUid ?? null;
        rosterScopes.push(scope);
        if (holdRosterFor && scope === holdRosterFor) {
          return new Promise((resolve) => {
            pendingRoster = () =>
              resolve(
                ok({
                  contacts: [
                    { personUid: A_PERSON, displayName: A_PERSON_NAME },
                  ],
                }),
              );
          });
        }
        return ok({
          contacts: [{ personUid: B_PERSON, displayName: B_PERSON_NAME }],
        });
      },
      fetchChannel: async ({ channelId }: { channelId: string }) => {
        if (holdChannelFetch && channelId === A_CHANNEL) {
          return new Promise((resolve) => {
            pendingChannelFetch = (body: string) =>
              resolve(
                ok({
                  messages: [
                    {
                      eventId: "alpha-inflight-1",
                      fromDisplayName: "Alpha teammate",
                      body,
                      createdAt: new Date().toISOString(),
                      direction: "in",
                    },
                  ],
                  nextCursor: null,
                }),
              );
          });
        }
        return ok({ messages: [], nextCursor: null });
      },
      fetchDm: async () => ok(null),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
      listChannelMembers: async () => ok({ members: [] }),
    },
    meetings: { listAccounts: async () => ok([]) },
    appShell: { notificationPermissionState: async () => ok("default") },
    settings: { getSettings: async () => ok({}) },
  } as unknown as PlatformAdapter;
}

/** A tenant-scoped storage facade built exactly the way the shell builds it. */
function tenantStorageFor(companyId: string | null) {
  return createTenantStorage(window.localStorage, {
    accountId: ACCOUNT_ID,
    companyId: companyId ?? "all",
  });
}

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function mountShell(): Promise<void> {
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(),
      sidebarApi: sidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: SELF,
      companies: COMPANIES,
      tenantAccountId: ACCOUNT_ID,
      coreFixtures: false,
    },
  });
  await settle();
}

/** Drive the real scope switcher: open the pill menu, click the company. */
async function switchCompany(uid: string | "all"): Promise<void> {
  const pill = host.querySelector<HTMLButtonElement>(
    '[data-testid="chat-scope-pill"]',
  );
  expect(pill, "scope pill is rendered").toBeTruthy();
  pill!.click();
  await settle(2);
  const option = document.querySelector<HTMLButtonElement>(
    `[data-testid="chat-scope-option"][data-scope="${uid}"]`,
  );
  expect(option, `scope option for ${uid} is offered`).toBeTruthy();
  option!.click();
  await settle();
}

function railTitles(): string[] {
  return Array.from(host.querySelectorAll(".chat-row-title")).map(
    (el) => el.textContent?.trim() ?? "",
  );
}

function unreadBadges(): string[] {
  return Array.from(
    host.querySelectorAll('[data-testid="chat-unread-badge"]'),
  ).map((el) => el.textContent?.trim() ?? "");
}

function draftMarkedRows(): number {
  return host.querySelectorAll('[data-testid="chat-row-draft"]').length;
}

/** Everything the user can currently see, as one string, for leak grepping. */
function renderedText(): string {
  return `${host.innerHTML}\n${document.body.innerHTML}`;
}

/** Populate company A's tenant partition through the real store helpers. */
function seedCompanyAState(): void {
  const storage = tenantStorageFor(A_UID);
  savePins([A_ROW_ID], storage);
  saveDmDots([A_PERSON], storage);
  saveDraft(storage, A_ROW_ID, A_DRAFT_TEXT);
  saveConversationCache(
    {
      channels: [
        {
          channelId: A_CHANNEL,
          name: A_CHANNEL,
          scope: "project",
          companyUid: A_UID,
          lastActivityAt: new Date().toISOString(),
        },
      ],
      contacts: [
        {
          personUid: A_PERSON,
          displayName: "Alpha Only",
          email: "alpha-only@example.invalid",
        },
      ],
    } as never,
    storage,
  );
}

function resetSharedState(): void {
  memoryStorage.clear();
  rosterScopes = [];
  pendingChannelFetch = null;
  holdChannelFetch = false;
  pendingRoster = null;
  holdRosterFor = null;
}

beforeEach(resetSharedState);

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  // The scope menu portals outside `host`; clear anything it left behind.
  document.body.innerHTML = "";
  resetSharedState();
});

// ── 1. Re-scoping ───────────────────────────────────────────────────────────

describe("DesktopApp company switch", () => {
  it("Given company A is selected with its own rail, unread counts, pins and draft, when the user switches to company B, then every tenant-scoped surface shows B's state instead", async () => {
    seedCompanyAState();
    await mountShell();

    await switchCompany(A_UID);
    expect(railTitles()).toContain(A_CHANNEL);
    expect(railTitles()).not.toContain(B_CHANNEL);
    expect(unreadBadges()).toContain("3");
    expect(draftMarkedRows()).toBe(1);

    await switchCompany(B_UID);
    expect(railTitles()).toContain(B_CHANNEL);
    expect(railTitles()).not.toContain(A_CHANNEL);
    // B's only channel has no unread; A's badge must not survive the switch.
    expect(unreadBadges()).not.toContain("3");
    // The draft belongs to A's partition — B's rail shows no draft marker.
    expect(draftMarkedRows()).toBe(0);
    // The mention roster refetches for the company now on screen.
    expect(rosterScopes.at(-1)).toBe(B_UID);
  });

  // ── 2. Isolation ──────────────────────────────────────────────────────────

  it("Given company A's cached state, when the shell is scoped to company B, then none of A's data is readable as B through a store, a storage key, or the DOM", async () => {
    seedCompanyAState();
    await mountShell();
    await switchCompany(A_UID);
    await switchCompany(B_UID);

    const asB = tenantStorageFor(B_UID);
    expect(loadPins(asB)).toEqual([]);
    expect(loadDmDots(asB)).toEqual([]);
    expect(listDraftRowIds(asB)).toEqual([]);
    expect(loadDraft(asB, A_ROW_ID)).toBe("");

    // Every stored value carrying an A identifier lives under a key that names
    // A's partition. A key without A's segment must not hold A's data.
    //
    // ONE documented exception, asserted below rather than hidden: the
    // conversation cache (`hq.chat.conversation-cache`) is the warm-start
    // snapshot of the ACCOUNT-wide channel directory. The server feed is not
    // company-filtered — the user is a member of both companies — so the
    // snapshot written while B is on screen still lists A's channels. It is a
    // superset at rest, never a superset on screen: the rail filters by the
    // active scope, which is what the DOM assertions below pin. If that filter
    // ever moves or a new consumer reads the cache without re-scoping, the
    // DOM assertions fail here first.
    const keys = Array.from(
      { length: memoryStorage.length },
      (_, i) => memoryStorage.key(i) ?? "",
    );
    const leaked = keys.filter((key) => {
      if (key.endsWith(CONVERSATION_CACHE_KEY)) return false;
      const value = memoryStorage.getItem(key) ?? "";
      const holdsA =
        value.includes(A_CHANNEL) ||
        value.includes(A_DRAFT_TEXT) ||
        value.includes(A_PERSON);
      return holdsA && !key.includes(A_UID);
    });
    expect(
      leaked,
      `storage keys holding company A data outside A's partition: ${leaked.join(", ")}`,
    ).toEqual([]);

    // The tenant-scoped surfaces that decide what B renders carry nothing of
    // A's — the exception above is confined to the directory snapshot.
    const scopedKeys = keys.filter(
      (key) => !key.endsWith(CONVERSATION_CACHE_KEY) && key.includes(B_UID),
    );
    for (const key of scopedKeys) {
      expect(memoryStorage.getItem(key) ?? "").not.toContain(A_CHANNEL);
    }

    const rendered = renderedText();
    expect(rendered).not.toContain(A_CHANNEL);
    expect(rendered).not.toContain(A_DRAFT_TEXT);
    expect(rendered).not.toContain(A_PERSON);
    expect(rendered).not.toContain(A_UID);
  });

  // ── 3. Return trip ────────────────────────────────────────────────────────

  it("Given the user switched away to company B, when they switch back to company A, then A's rail, pin and draft come back intact", async () => {
    seedCompanyAState();
    await mountShell();
    await switchCompany(A_UID);
    await switchCompany(B_UID);
    await switchCompany(A_UID);

    expect(railTitles()).toContain(A_CHANNEL);
    expect(railTitles()).not.toContain(B_CHANNEL);
    expect(draftMarkedRows()).toBe(1);
    expect(loadPins(tenantStorageFor(A_UID))).toEqual([A_ROW_ID]);
    expect(loadDraft(tenantStorageFor(A_UID), A_ROW_ID)).toBe(A_DRAFT_TEXT);
    expect(rosterScopes.at(-1)).toBe(A_UID);
  });

  // ── 4. Race guard ─────────────────────────────────────────────────────────

  it("Given company A requests still in flight, when the user switches to company B before they resolve, then A's late responses cannot write into B's view", async () => {
    holdChannelFetch = true;
    holdRosterFor = A_UID;
    await mountShell();

    // Scoping to A starts both A-scoped reads. Neither is allowed to resolve.
    await switchCompany(A_UID);
    expect(rosterScopes, "the roster was requested for A").toContain(A_UID);
    expect(pendingRoster, "A's roster request is in flight").toBeTruthy();

    const alphaRow = Array.from(
      host.querySelectorAll<HTMLElement>(".chat-row-title"),
    ).find((el) => el.textContent?.trim() === A_CHANNEL);
    expect(alphaRow, "A's channel row is on the rail").toBeTruthy();
    alphaRow!.closest("button")?.click();
    await settle();
    expect(pendingChannelFetch, "A's channel fetch is in flight").toBeTruthy();

    // The tenant boundary moves while both requests are still open.
    await switchCompany(B_UID);
    pendingRoster!();
    pendingChannelFetch!(A_INFLIGHT_BODY);
    await settle();

    // Open B's channel and ask the composer for mention candidates. A's late
    // roster must not be offered here — the picker is the surface where a
    // stale tenant response becomes a real cross-company disclosure.
    const betaRow = Array.from(
      host.querySelectorAll<HTMLElement>(".chat-row-title"),
    ).find((el) => el.textContent?.trim() === B_CHANNEL);
    expect(betaRow, "B's channel row is on the rail").toBeTruthy();
    betaRow!.closest("button")?.click();
    await settle();

    const composer = host.querySelector<HTMLTextAreaElement>(
      '[data-testid="conversation-composer"]',
    );
    expect(composer, "B's composer is mounted").toBeTruthy();
    composer!.value = "@alpha";
    composer!.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();

    const candidates = Array.from(
      host.querySelectorAll('[data-testid="mention-picker"] button'),
    ).map((el) => el.textContent?.trim() ?? "");
    expect(
      candidates.join(" | "),
      "A's late roster leaked into B's mention picker",
    ).not.toContain(A_PERSON_NAME);

    // Vacuity guard: the same picker, asked for a name B really has, answers.
    // Without this, an empty picker would pass the assertion above for free.
    composer!.value = `@${B_PERSON_NAME.slice(0, 4)}`;
    composer!.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const betaCandidates = Array.from(
      host.querySelectorAll('[data-testid="mention-picker"] button'),
    ).map((el) => el.textContent?.trim() ?? "");
    expect(
      betaCandidates.join(" | "),
      "B's own roster is offered, so the picker is live",
    ).toContain(B_PERSON_NAME);

    // A's late message body, and A's channel itself, stay out of B's view.
    expect(renderedText()).not.toContain(A_INFLIGHT_BODY);
    expect(renderedText()).not.toContain(A_CHANNEL);
    expect(railTitles()).toContain(B_CHANNEL);
  });
});
