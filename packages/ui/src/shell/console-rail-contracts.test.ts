/**
 * US-002 — source contracts for the console rail, written before the shell
 * lands. Existing tests stay as they are. The inventory below is the list
 * that belongs in the PR: every current test under packages/ui/src and
 * apps/work/e2e that asserts titlebar navigation icons (folder, console,
 * meetings), the ChatSidebar companies / company-channel surface, or the
 * company Overview page, and the later story that has to change it.
 *
 * Pending contracts use it.todo. Each name starts with the story that
 * removes the todo and turns the assertion on. Do not skip or loosen a
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
  it.todo(
    "US-003: AppRail order is Home, Meetings, pinned company tiles, More companies, Library, Deployments, Telemetry, Secrets, Connections, Outpost, spacer, You",
  );

  it.todo(
    "US-004: the rail shows at most six pinned company tiles",
  );

  it.todo(
    "US-009: opening a company lands on Atlas and does not mount the Overview page",
  );

  it.todo(
    "US-011: the notifications bell stays in the titlebar",
  );

  it.todo(
    "US-010: the avatar menu sits at the bottom of the rail with Profile, Billing, Settings, and Sign out",
  );
});
