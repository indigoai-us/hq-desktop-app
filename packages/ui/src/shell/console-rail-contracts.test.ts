/**
 * US-002 — source contracts for the console rail, written before the shell
 * lands. Existing tests stay as they are. The inventory below is the list
 * that belongs in the PR: every current test under packages/ui/src and
 * apps/work/e2e that asserts titlebar navigation icons (folder, console,
 * meetings), the ChatSidebar companies / company-channel surface, or the
 * company Overview page, and the later story that has to change it.
 *
 * Every pending contract is now on (US-039). Each name starts with the
 * story that turned the assertion on. Do not skip or loosen a
 * passing test to make one of these pass.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

export type ShellContractOwner = {
  file: string;
  asserts: "titlebar-navigation" | "chat-sidebar-company-channels" | "company-overview";
  /** Story that rewrites this test when its surface moves. */
  changedBy: string;
  note: string;
};

/**
 * Grep scope: packages/ui/src and apps/work/e2e, 2026-10-01 on feat/console-rail.
 * A file can appear twice when it asserts two surfaces.
 */
export const EXISTING_SHELL_CONTRACTS: readonly ShellContractOwner[] = [
  {
    file: "packages/ui/src/home/V4TitleBar.launch.test.ts",
    asserts: "titlebar-navigation",
    changedBy: "US-003",
    note: "Launch sits left of titlebar-meetings; Console and the folder action render in that cluster.",
  },
  {
    file: "packages/ui/src/tour/guided-tour.test.ts",
    asserts: "titlebar-navigation",
    changedBy: "US-003",
    note: "Tour steps target titlebar-files and titlebar-meetings.",
  },
  {
    file: "packages/ui/src/tour/guided-tour.test.ts",
    asserts: "chat-sidebar-company-channels",
    changedBy: "US-008",
    note: "Tour step targets chat-companies-section.",
  },
  {
    file: "packages/ui/src/shell/DesktopApp.guided-tour.test.ts",
    asserts: "titlebar-navigation",
    changedBy: "US-003",
    note: "Resolves titlebar-files, titlebar-meetings, and titlebar-console.",
  },
  {
    file: "packages/ui/src/shell/DesktopApp.guided-tour.test.ts",
    asserts: "chat-sidebar-company-channels",
    changedBy: "US-008",
    note: "Step 4 resolves chat-companies-section.",
  },
  {
    file: "packages/ui/src/shell/DesktopApp.files-fullscreen.test.ts",
    asserts: "titlebar-navigation",
    changedBy: "US-003",
    note: "Opens the vault by clicking titlebar-files.",
  },
  {
    file: "apps/work/e2e/v2-display-guard.test.ts",
    asserts: "titlebar-navigation",
    changedBy: "US-003",
    note: "Clicks titlebar-meetings in the signed-in shell.",
  },
  {
    file: "packages/ui/src/chat/ChatSidebar.companies-section.test.ts",
    asserts: "chat-sidebar-company-channels",
    changedBy: "US-008",
    note: "Companies section click opens the company home channel.",
  },
  {
    file: "packages/ui/src/chat/ChatSidebar.company-icon.test.ts",
    asserts: "chat-sidebar-company-channels",
    changedBy: "US-008",
    note: "Company channel rows in the sidebar render a company mark.",
  },
  {
    file: "packages/ui/src/chat/company-home-channel.test.ts",
    asserts: "chat-sidebar-company-channels",
    changedBy: "US-008",
    note: "resolveCompanySectionRows builds the sidebar Companies section.",
  },
  {
    file: "packages/ui/src/chat/sidebar-model.test.ts",
    asserts: "chat-sidebar-company-channels",
    changedBy: "US-008",
    note: "Maps and filters company channels in the sidebar directory model.",
  },
  {
    file: "packages/ui/src/shell/DesktopApp.open-channel-unloaded.test.ts",
    asserts: "chat-sidebar-company-channels",
    changedBy: "US-008",
    note: "Companies section openHomeChannelId falls back when the channel is unloaded.",
  },
  {
    file: "packages/ui/src/shell/DesktopApp.company-home-title-unloaded.test.ts",
    asserts: "chat-sidebar-company-channels",
    changedBy: "US-008",
    note: "Clicking a company in the Companies section opens its home channel.",
  },
  {
    file: "packages/ui/src/shell/DesktopApp.company-switch.test.ts",
    asserts: "chat-sidebar-company-channels",
    changedBy: "US-008",
    note: "Tenant-boundary check treats chat-companies-section as the cross-company list.",
  },
  {
    file: "packages/ui/src/home/v4.test.ts",
    asserts: "company-overview",
    changedBy: "US-009",
    note: "Active company children lead with the overview tab; V4_COMPANY_PRIMARY_ITEMS starts at overview.",
  },
];

describe("US-002 existing shell contracts stay on disk", () => {
  it("names a later story for every titlebar, company-channel, and Overview assertion", () => {
    const surfaces = new Set(EXISTING_SHELL_CONTRACTS.map((row) => row.asserts));
    expect(surfaces).toEqual(
      new Set([
        "titlebar-navigation",
        "chat-sidebar-company-channels",
        "company-overview",
      ]),
    );
    for (const row of EXISTING_SHELL_CONTRACTS) {
      expect(row.changedBy, row.file).toMatch(/^US-\d{3}$/);
      expect(existsSync(join(REPO_ROOT, row.file)), row.file).toBe(true);
    }
  });
});

describe("US-002 pending console-rail contracts", () => {
  it("US-003: AppRail order is Home, Meetings, pinned company tiles, More companies, Library, Deployments, Telemetry, Secrets, Connections, Outpost, spacer, You", async () => {
    const { readFileSync } = await import("node:fs");
    const { railItems } = await import("./app-rail.js");
    const items = railItems(
      [
        { uid: "co_a", label: "Indigo" },
        { uid: "co_b", label: "Amass" },
      ],
      "Corey",
    );
    expect(items.map((item) => item.id)).toEqual([
      "home",
      "meetings",
      "company:co_a",
      "company:co_b",
      "more-companies",
      "library",
      "deployments",
      "telemetry",
      "secrets",
      "connections",
      "marketplace",
      "outpost",
      "you",
    ]);
    const rail = readFileSync(join(REPO_ROOT, "packages/ui/src/shell/AppRail.svelte"), "utf8");
    // The spacer renders between the navigation items and the You avatar.
    expect(rail).toMatch(/data-testid="rail-spacer"/);
  });

  it("US-004: the rail shows at most six pinned company tiles", async () => {
    const { MAX_PINNED_COMPANY_TILES, railItems } = await import("./app-rail.js");
    expect(MAX_PINNED_COMPANY_TILES).toBe(6);
    const companies = Array.from({ length: 9 }, (_, i) => ({ uid: `co_${i}`, label: `Co ${i}` }));
    const tiles = railItems(companies, "You").filter((item) => item.kind === "company");
    expect(tiles).toHaveLength(6);
  });

  it("US-009: opening a company lands on Atlas and does not mount the Overview page", async () => {
    const { readFileSync } = await import("node:fs");
    const { railDestination, railItems } = await import("./app-rail.js");
    const { canonicalizeDestination } = await import("./navigation-history.js");
    const tile = railItems([{ uid: "co_a", label: "Indigo" }], "You").find(
      (item) => item.kind === "company",
    )!;
    expect(railDestination(tile)).toEqual({
      kind: "extra",
      page: "company-page-atlas",
      companyUid: "co_a",
    });
    expect(
      canonicalizeDestination({ kind: "extra", page: "company-page-overview", companyUid: "co_a" }),
    ).toMatchObject({ page: "company-page-atlas" });
    const shell = readFileSync(
      join(REPO_ROOT, "packages/ui/src/shell/DesktopApp.svelte"),
      "utf8",
    );
    expect(shell).not.toMatch(/<CompanyPage\b/);
    expect(shell).not.toMatch(/CompanyBoardPanel/);
    expect(shell).toMatch(/<AtlasLandingHost\b/);
  });

  it("Atlas Open board opens the project on the company Projects pane, not the cross-company view", async () => {
    const { readFileSync } = await import("node:fs");
    const shell = readFileSync(
      join(REPO_ROOT, "packages/ui/src/shell/DesktopApp.svelte"),
      "utf8",
    );
    const start = shell.indexOf('railPlaceholder?.id === "projects" && companyPaneCompany}');
    expect(start).toBeGreaterThan(0);
    // The pane's <ProjectsHome ... /> element.
    const branch = shell.slice(start, shell.indexOf("/>", shell.indexOf("<ProjectsHome", start)));
    expect(branch).toMatch(/focusProject=\{companyProjectsFocus\(extraPageParam\)\?\.project/);
    expect(branch).toMatch(/focusTab=\{companyProjectsFocus\(extraPageParam\)\?\.tab/);
  });

  it("US-011: the notifications bell stays in the titlebar", async () => {
    const { readFileSync } = await import("node:fs");
    const titlebar = readFileSync(join(REPO_ROOT, "packages/ui/src/home/V4TitleBar.svelte"), "utf8");
    const rail = readFileSync(join(REPO_ROOT, "packages/ui/src/shell/AppRail.svelte"), "utf8");
    expect(titlebar).toMatch(/data-testid="titlebar-notifications"/);
    expect(titlebar).toMatch(/data-testid="titlebar-sidebar-toggle"/);
    expect(titlebar).not.toMatch(/titlebar-projects|onopenProjects/);
    expect(rail).not.toMatch(/notifications/i);
  });

  it("OWNER-R36: pages with no side pane hide the titlebar sidebar toggle instead of toggling an empty column", async () => {
    const { readFileSync } = await import("node:fs");
    const shell = readFileSync(join(REPO_ROOT, "packages/ui/src/shell/DesktopApp.svelte"), "utf8");
    const block = shell.match(/const pageHasNoSidepane = \$derived\(([\s\S]*?)\);/)?.[1] ?? "";
    for (const page of ['"rail-deployments"', 'railPlaceholder?.id === "telemetry"', 'railPlaceholder?.id === "secrets"', 'railPlaceholder?.id === "connections"']) {
      expect(block).toContain(page);
    }
    expect(shell).toMatch(/sidebarToggleHidden=\{pageHasNoSidepane\}/);
  });

  // OWNER-R21: Profile and Billing moved into the one Settings list.
  it("US-010: the avatar menu sits at the bottom of the rail with the identity block, Settings, and Sign out", async () => {
    const { readFileSync } = await import("node:fs");
    const { railItems } = await import("./app-rail.js");
    const items = railItems([], "You");
    expect(items.at(-1)?.kind).toBe("you");
    const menu = readFileSync(join(REPO_ROOT, "packages/ui/src/shell/AccountMenu.svelte"), "utf8");
    expect(menu).not.toContain('data-testid="account-profile"');
    expect(menu).not.toContain('data-testid="account-billing"');
    const order = ["account-identity", "account-settings", "account-sign-out"].map(
      (id) => menu.indexOf(`data-testid="${id}"`),
    );
    for (const index of order) expect(index).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const shell = readFileSync(join(REPO_ROOT, "packages/ui/src/shell/DesktopApp.svelte"), "utf8");
    expect(shell).toMatch(/onyou=\{toggleAccountMenu\}/);
  });
});
