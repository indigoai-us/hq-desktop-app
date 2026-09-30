// @vitest-environment happy-dom

/**
 * hard-stop-readiness US-018: a refused invite claim shows a readable sentence
 * and the upgrade link, never raw JSON or a machine code.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import {
  ok,
  WebPlatformAdapter,
  type AdapterResult,
  type Json,
} from "@hq/platform";

import CompanyPage from "./CompanyPage.svelte";

const UPGRADE_URL = "https://hq.computer/companies/acme/billing?upgrade=1";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  host = null;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve();
    await tick();
    flushSync();
  }
}

const PENDING_COMPANY = {
  slug: "acme",
  displayName: "Acme",
  kind: "company",
  state: "cloud-only",
  cloudUid: "cmp_acme",
  bucketName: null,
  hasLocalFolder: false,
  localPath: null,
  membershipStatus: "pending",
  role: "member",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: "prs_owner",
  invitedAt: "2026-09-27T12:00:00.000Z",
};

function fakeAdapter(
  claimPendingInvite: (slug: string) => Promise<AdapterResult<Json>>,
) {
  const noop = async () => ok({} as Json);
  return {
    kind: "desktop",
    capabilities: { nativeCalls: false },
    isAvailable: () => false,
    calls: {
      preflight: async () => ok({ passed: true } as never),
      discoverOffice: noop,
      setOfficePreference: noop,
      setOfficeConnectivity: noop,
      createRoom: noop,
    },
    identity: { whoami: async () => ok({ personUid: "prs_self" } as never) },
    company: {
      listCompanies: async () => ok([] as never),
      getCompany: async () => ok({} as never),
      claimPendingInvite,
    },
    settings: { getSettings: async () => ok({} as never) },
    library: {},
    shell: {},
    sync: { startSync: vi.fn(async () => ok(undefined as never)) },
    messaging: {},
    files: {},
  } as never;
}

async function acceptInvite(adapter: unknown, openExternal = vi.fn()) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CompanyPage, {
    target: host,
    props: {
      adapter,
      openExternal,
      company: PENDING_COMPANY,
      tab: "office",
    } as never,
  });
  await settle();
  (
    host.querySelector('[data-testid="company-accept-invite"]') as HTMLButtonElement
  ).click();
  await settle();
  return { root: host, openExternal };
}

describe("CompanyPage invite claim refused by a plan limit", () => {
  it("desktop: shows the sentence the claim command returns and the upgrade link", async () => {
    const message =
      "New members cannot be added while Acme is over its Starter limits. Members: 5 of 5 used.";
    const { root, openExternal } = await acceptInvite(
      fakeAdapter(async () =>
        ok({
          ok: false,
          claimedSlugs: [],
          message,
          upgradeUrl: UPGRADE_URL,
        } as Json),
      ),
    );

    const error = root.querySelector(".company-action-error");
    expect(error?.textContent).toContain(message);
    expect(error?.textContent).not.toContain("{");
    expect(root.querySelector(".company-action-notice")).toBeNull();
    (
      root.querySelector('[data-testid="company-action-upgrade"]') as HTMLButtonElement
    ).click();
    expect(openExternal).toHaveBeenCalledWith(UPGRADE_URL);
  });

  it("web: maps the 402 body through the adapter without the machine code", async () => {
    const web = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: async () =>
        new Response(
          JSON.stringify({
            code: "PLAN_LIMIT_EXCEEDED",
            resource: "users",
            used: 5,
            limit: 5,
            requiredPlan: "team",
            upgradeUrl: UPGRADE_URL,
          }),
          { status: 402 },
        ),
    });
    const { root, openExternal } = await acceptInvite(
      fakeAdapter((slug) => web.company.claimPendingInvite(slug)),
    );

    const text = root.querySelector(".company-action-error")?.textContent ?? "";
    expect(text).toContain("Your plan limit is reached. Members: 5 of 5 used.");
    expect(text).not.toContain("PLAN_LIMIT_EXCEEDED");
    expect(text).not.toContain("{");
    (
      root.querySelector('[data-testid="company-action-upgrade"]') as HTMLButtonElement
    ).click();
    expect(openExternal).toHaveBeenCalledWith(UPGRADE_URL);
  });

  it("keeps the ordinary success notice for a claimed invite", async () => {
    const { root } = await acceptInvite(
      fakeAdapter(async () =>
        ok({ ok: true, claimedSlugs: ["acme"], message: "Joined acme." } as Json),
      ),
    );
    expect(root.querySelector(".company-action-notice")?.textContent).toContain(
      "Joined acme.",
    );
    expect(root.querySelector('[data-testid="company-action-upgrade"]')).toBeNull();
  });
});
