// @vitest-environment happy-dom

// BLANK-1 at the layer the desktop app really runs: every page read goes
// through the adapter the shell builds (createSyncPlatformAdapter, wired by
// apps/work WorkShell and apps/sync HqWorkWorkShell), whose every read is a
// Tauri `invoke`. Here that invoke never settles, the page is mounted through
// the same host / lazy door DesktopApp mounts, with the props DesktopApp
// passes. BLANK-3: no timer turns the pending read into a failure; the page
// keeps its loader, adds a waiting line and then a quiet Try again.

import { createSyncPlatformAdapter, type PlatformAdapter } from "@hq/platform";
import { flushSync, mount, unmount, type Component } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectPendingRead } from "./read-loader.test-support.js";
import { brainPageDoor, filesConnectDoor } from "../shell/lazy-doors.js";
import { configureCompanyApi, stopCompanyStore } from "../company/company-store.svelte.js";
import { clearPersonalRailCache } from "../personal/personal-rail-model.js";
import { clearIntegrationsCache } from "../personal/personal-integrations.js";
import { loadPersonalRail } from "../shell/personal-rail-lazy.js";
import LazyDoor from "../shell/LazyDoor.svelte";
import GoalsRailHost from "../shell/GoalsRailHost.svelte";
import DeploymentsRailHost from "../shell/DeploymentsRailHost.svelte";
import PersonalRailHost from "../shell/PersonalRailHost.svelte";
import TeamPage from "../company/TeamPage.svelte";
import BotsPage from "../company/BotsPage.svelte";
import VaultExplorer from "../files/explorer/VaultExplorer.svelte";
import ProjectsHome from "../projects/ProjectsHome.svelte";
import type { Workspace } from "../chat/workspaces.js";

const realSetImmediate = globalThis.setImmediate;

let component: ReturnType<typeof mount> | null = null;
let adapter: PlatformAdapter | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  void adapter?.dispose?.();
  adapter = null;
  document.body.innerHTML = "";
  localStorage.clear();
  stopCompanyStore();
  configureCompanyApi(null);
  clearPersonalRailCache();
  clearIntegrationsCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The shell's adapter with a native bridge that never answers. */
function hungAdapter(): { adapter: PlatformAdapter; commands: string[] } {
  const commands: string[] = [];
  const built = createSyncPlatformAdapter({
    invoke: (cmd, args) => {
      // hq-pro REST rides invoke("hq_pro_fetch"); record its path too.
      commands.push(cmd === "hq_pro_fetch" ? `${cmd} ${String(args?.url ?? "")}` : cmd);
      return new Promise<never>(() => {});
    },
    primeMirrorQuarantineGate: true,
    // Production REST goes through invoke("hq_pro_fetch"); window fetch is never used.
    fetch: (() => {
      throw new Error("window fetch must not be used on desktop");
    }) as typeof globalThis.fetch,
  });
  adapter = built;
  return { adapter: built, commands };
}

const ACME: Workspace = {
  slug: "acme-real",
  displayName: "Acme",
  kind: "company",
  state: "synced",
  cloudUid: "cmp_acme_real",
  bucketName: null,
  hasLocalFolder: true,
  localPath: null,
  membershipStatus: "active",
  role: "owner",
  lastSyncedAt: null,
  brokenReason: null,
} as Workspace;

function quiet(): void {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}

function fakeTimers(): void {
  // setImmediate stays real so lazy page chunks can finish loading.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
}

/** Wait (without moving the fake clock) until the real page body has mounted. */
async function until(ready: string | (() => boolean)): Promise<void> {
  const check = typeof ready === "string" ? () => document.querySelector(ready) !== null : ready;
  for (let i = 0; i < 500; i += 1) {
    flushSync();
    if (check()) return;
    await new Promise<void>((resolve) => realSetImmediate(resolve));
  }
  throw new Error(`page never mounted: ${String(ready)}`);
}


/** Mount a shell host or page with the props DesktopApp passes it. */
function mountInBody(c: unknown, props: Record<string, unknown>): void {
  component = mount(c as Component<Record<string, unknown>>, { target: document.body, props });
}


describe("pending reads through the real desktop adapter (BLANK-3)", () => {
  it.each(["knowledge", "policies", "skills", "workers"] as const)(
    "company %s (BrainPage via brainPageDoor) keeps loading, never a failed state",
    async (page) => {
      quiet();
      await brainPageDoor.load();
      fakeTimers();
      const { adapter: a, commands } = hungAdapter();
      mountInBody(LazyDoor, {
        door: brainPageDoor,
        props: {
          page,
          slug: `real-${page}`,
          files: a.files ?? null,
          library: a.library ?? null,
          shell: a.shell ?? null,
          settings: a.settings ?? null,
          appShell: a.appShell ?? null,
          onopenpage: () => {},
        },
      });
      await until("[data-testid='brain-loading']");
      expect(commands).toContain("set_desktop_active_company");
      await expectPendingRead(document, "brain-loader");
    },
  );

  it("company Goals (GoalsRailHost -> GoalsView) keeps loading, never a failed state", async () => {
    quiet();
    await import("../goals/GoalsView.svelte");
    fakeTimers();
    const { adapter: a, commands } = hungAdapter();
    mountInBody(GoalsRailHost, { adapter: a, slug: "real-goals" });
    await until(() => commands.includes("get_local_company_goals"));
    await expectPendingRead(document, "goals-loader");
  });

  it("company Projects (ProjectsHome -> CompanyProjectsPage) keeps loading, never a failed state", async () => {
    quiet();
    fakeTimers();
    const { adapter: a, commands } = hungAdapter();
    mountInBody(ProjectsHome, {
      adapter: a,
      companies: [ACME],
      pickerCompanies: [ACME.slug],
      slug: ACME.slug,
      preferredSlug: ACME.slug,
      onslugchange: () => {},
    });
    await until("[data-testid='projects-loader']");
    expect(commands).toContain("get_local_projects");
    await expectPendingRead(document, "projects-loader");
  });

  it("company Vault (FilesConnectPage via filesConnectDoor) keeps loading, never a failed state", async () => {
    quiet();
    await filesConnectDoor.load();
    fakeTimers();
    const { adapter: a, commands } = hungAdapter();
    configureCompanyApi(a.company);
    mountInBody(LazyDoor, {
      door: filesConnectDoor,
      props: {
        page: "vault",
        slug: "real-vault",
        files: a.files ?? null,
        shell: a.shell ?? null,
        settings: a.settings ?? null,
        openExternal: () => {},
        listDeployApps: a.company?.listDeployApps,
        adapter: a,
        companyUid: "cmp_real_vault",
        deployActions: true,
      },
    });
    await until("[data-testid='file-tree-loading']");
    expect(commands).toContain("set_desktop_active_company");
    await expectPendingRead(document, "file-tree-loader");
    expect(document.querySelector("[data-testid='vault-summary-loader']")).toBeTruthy();
    expect(document.querySelector("[data-testid='vault-summary-loader-retry']")).toBeTruthy();
  });

  it.each([
    ["secrets", "Could not load secrets.", "get_company_secrets"],
    ["deployments", "Could not load deployments.", "list_deploy_apps"],
    ["integrations", "Could not load connected apps.", "hq_pro_fetch /v1/integrations/admin?companyUid=cmp_real_integrations"],
  ] as const)(
    "company %s (FilesConnectPage via filesConnectDoor) keeps loading, never a failed state",
    async (page, _copy, command) => {
      quiet();
      await filesConnectDoor.load();
      fakeTimers();
      const { adapter: a, commands } = hungAdapter();
      // CompanySidepane binds the shared company store to adapter.company.
      configureCompanyApi(a.company);
      mountInBody(LazyDoor, {
        door: filesConnectDoor,
        props: {
          page,
          slug: `real-${page}`,
          files: a.files ?? null,
          shell: a.shell ?? null,
          settings: a.settings ?? null,
          openExternal: () => {},
          listDeployApps: a.company?.listDeployApps,
          adapter: a,
          companyUid: `cmp_real_${page}`,
          deployActions: true,
        },
      });
      await until(`[data-testid='${page}-loader']`);
      expect(commands).toContain(command);
      await expectPendingRead(document, `${page}-loader`);
    },
  );

  it("company Team (TeamPage) keeps loading, never a failed state", async () => {
    quiet();
    fakeTimers();
    const { adapter: a, commands } = hungAdapter();
    mountInBody(TeamPage, {
      slug: "real-team",
      companyUid: "cmp_real_team",
      company: a.company ?? null,
      messaging: a.messaging ?? null,
      senderName: "you",
      agents: a.agents ?? null,
      inviteSeq: 0,
      onaddagent: () => {},
      onmessage: () => {},
    });
    await until("[data-testid='team-loader']");
    expect(commands).toContain("get_company_team_telemetry");
    await expectPendingRead(document, "team-loader");
  });

  it("company Bots (BotsPage) keeps loading, never a failed state", async () => {
    quiet();
    fakeTimers();
    const { adapter: a, commands } = hungAdapter();
    mountInBody(BotsPage, {
      companyUid: "cmp_real_bots",
      adapter: a,
      companies: [ACME],
      localBots: [],
      companyLabel: "Acme",
      ownerName: null,
      onmessage: () => {},
      onaddbot: () => {},
    });
    await until("[data-testid='bots-loader']");
    expect(commands.some((c) => c.startsWith("hq_pro_fetch") && c.includes("cmp_real_bots"))).toBe(true);
    await expectPendingRead(document, "bots-loader");
  });

  it("personal Library (VaultExplorer + VaultTree) keeps loading, never a failed state", async () => {
    quiet();
    fakeTimers();
    const { adapter: a, commands } = hungAdapter();
    mountInBody(VaultExplorer, {
      adapter: a,
      companies: [ACME],
      vaultId: null,
      path: null,
      onlocationchange: () => {},
    });
    await until(() => commands.includes("vault_summary") && commands.includes("list_hq_dir"));
    await expectPendingRead(document, "vault-tree-loader");
    expect(document.querySelector("[data-testid='vault-home-loader']")).toBeTruthy();
    expect(document.querySelector("[data-testid='vault-home-loader-retry']")).toBeTruthy();
  });

  it("personal Deployments (DeploymentsRailHost -> PersonalDeploymentsPage) keeps loading, never a failed state", async () => {
    quiet();
    await import("../library/PersonalDeploymentsPage.svelte");
    fakeTimers();
    const { adapter: a, commands } = hungAdapter();
    mountInBody(DeploymentsRailHost, {
      accountId: "real-deploy",
      listDeployApps: a.company?.listDeployApps,
      companies: [ACME],
      openExternal: () => {},
      actions: true,
    });
    await until("[data-testid='deploy-loader']");
    expect(commands).toContain("list_deploy_apps");
    await expectPendingRead(document, "deploy-loader");
  });

  it("personal Secrets (PersonalRailHost -> PersonalRailPage) keeps loading, never a failed state", async () => {
    quiet();
    await loadPersonalRail();
    fakeTimers();
    const { adapter: a, commands } = hungAdapter();
    configureCompanyApi(a.company);
    mountInBody(PersonalRailHost, {
      page: "secrets",
      companies: [{ uid: ACME.cloudUid!, label: "Acme" }],
      activeCompany: null,
      onopenintegrations: () => {},
      integrationsApi: a.agents ?? null,
      openExternal: () => {},
    });
    await until("[data-testid='personal-secrets-loader']");
    expect(commands).toContain("get_company_secrets");
    await expectPendingRead(document, "personal-secrets-loader");
  });

  it("personal Connections (PersonalRailHost -> PersonalRailPage) keeps loading, never a failed state", async () => {
    quiet();
    await loadPersonalRail();
    fakeTimers();
    const { adapter: a, commands } = hungAdapter();
    configureCompanyApi(a.company);
    mountInBody(PersonalRailHost, {
      page: "connections",
      companies: [{ uid: ACME.cloudUid!, label: "Acme" }],
      activeCompany: null,
      onopenintegrations: () => {},
      integrationsApi: a.agents ?? null,
      openExternal: () => {},
    });
    await until("[data-testid='personal-integrations-loader']");
    await until(() => commands.includes("hq_pro_fetch /v1/google/accounts"));
    expect(commands).toContain("hq_pro_fetch /v1/slack/personal/accounts");
    await expectPendingRead(document, "personal-integrations-loader");
  });
});
