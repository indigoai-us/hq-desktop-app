// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import type { Workspace } from "../chat/workspaces.js";

const SELF_UID = "prs_me";
const COMPANY_UID = "cmp_indigo";

const personalDm: ConversationRow = {
  id: "dm:agt_izzy",
  kind: "dm",
  title: "Izzy",
  companyUid: null,
  unreadDot: false,
  lastActivityAt: 0,
  pinned: false,
  personUid: "agt_izzy",
};

const companyDm: ConversationRow = {
  ...personalDm,
  companyUid: COMPANY_UID,
};

/** Company first so a first-workspace fallback would send the wrong uid. */
const companies = [
  {
    slug: "indigo",
    displayName: "Indigo",
    kind: "company",
    state: "synced",
    cloudUid: COMPANY_UID,
  },
  {
    slug: "personal",
    displayName: "Personal",
    kind: "personal",
    state: "personal",
    cloudUid: SELF_UID,
  },
] as Workspace[];

function adapter(
  presignVaultPut: (
    companyUid: string,
    key: string,
    contentType: string,
    integrity?: unknown,
  ) => Promise<unknown>,
): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
      listChannelMembers: async () => ok({ members: [] }),
      sendDm: async () =>
        ok({ eventId: "evt_sent", createdAt: new Date().toISOString() }),
    },
    files: {
      presignVaultPut,
      presignVaultGet: async () =>
        ok({ results: [{ url: "https://vault.example/file" }] }),
    },
    meetings: {
      listUpcoming: async () => ok([]),
      listMemberships: async () => ok([]),
      listAccounts: async () => ok([]),
      listScheduledBots: async () => ok([]),
    },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function sendPastedImage(row: ConversationRow): Promise<string[]> {
  const scopes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 200 })),
  );
  const presignVaultPut = vi.fn(
    async (
      companyUid: string,
      _key: string,
      _contentType: string,
      integrity?: unknown,
    ) => {
      scopes.push(companyUid);
      integrities.push(integrity);
      return ok({
        results: [
          {
            url: "https://bucket.s3.amazonaws.com/shot.png",
            headers: { "content-type": "image/png" },
          },
        ],
      });
    },
  );

  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(presignVaultPut),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: SELF_UID, displayName: "Corey", email: "me@example.com" },
      companies,
      initialRow: row,
      searchRows: [row],
      coreFixtures: false,
    },
  });
  await settle();

  const sendBtn = host.querySelector(
    '[data-testid="composer-send"]',
  ) as HTMLButtonElement;
  const input = host.querySelector(
    '[data-testid="composer-attach-input"]',
  ) as HTMLInputElement;
  const file = new File([new Uint8Array([1, 2, 3])], "shot.png", {
    type: "image/png",
  });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  sendBtn.click();
  await vi.waitFor(() => {
    expect(scopes.length).toBeGreaterThan(0);
  });
  return scopes;
}

// Every upload must carry the file's SHA-256: vault buckets have S3 Object
// Lock and refuse a PUT without a signed checksum.
const integrities: unknown[] = [];

describe("DesktopApp DM attachment upload scope", () => {
  it("uploads a personal-scope DM attachment with the personal vault uid", async () => {
    const scopes = await sendPastedImage(personalDm);
    expect(scopes).toEqual([SELF_UID]);
    expect(integrities.at(-1)).toEqual({
      checksumSha256: "A5BYxvLAy0ksUzsKTRTvd8wPeKvMztUofYShogEc+4E=",
      contentSha256:
        "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    });
  });

  it("uploads a company-scope DM attachment with the company uid", async () => {
    const scopes = await sendPastedImage(companyDm);
    expect(scopes).toEqual([COMPANY_UID]);
  });
});
