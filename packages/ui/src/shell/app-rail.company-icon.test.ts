/**
 * Company favicons on the console rail.
 *
 * The favicon is resolved server-side (hq-pro caches the company website's
 * icon and hands out a presigned url on the membership roster). The rail,
 * More companies, and the palette must all read the same resolved icon, and
 * the tile falls back to initials when there is none.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { railItems } from "./app-rail.js";
import { buildCompanyIconMap, companyIconUrl } from "../company/company-display-map.js";

const ICON =
  "https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/branding/cmp_a/favicon.png?X-Amz-Signature=x";

const here = dirname(fileURLToPath(import.meta.url));

function companyTiles(companies: Parameters<typeof railItems>[0]) {
  return railItems(companies, "Corey").filter((item) => item.kind === "company");
}

describe("rail company icon", () => {
  it("paints the company icon when the roster has one", () => {
    const [tile] = companyTiles([{ uid: "cmp_a", label: "Indigo", iconUrl: ICON }]);
    expect(tile).toMatchObject({ iconUrl: ICON });
  });

  it("falls back to initials (null icon) when the company has no website icon", () => {
    const tiles = companyTiles([
      { uid: "cmp_a", label: "Indigo" },
      { uid: "cmp_b", label: "Amass", iconUrl: null },
      { uid: "cmp_c", label: "Tonal", iconUrl: "   " },
    ]);
    expect(tiles.map((tile) => (tile as { iconUrl: string | null }).iconUrl)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("prefers the roster icon over a stale cached workspace icon", () => {
    const icons = buildCompanyIconMap([{ companyUid: "cmp_a", iconUrl: ICON }]);
    expect(companyIconUrl("cmp_a", icons, "https://stale.example/x.png")).toBe(ICON);
    expect(companyIconUrl("cmp_b", icons, null)).toBeNull();
  });

  it("feeds the rail, More companies and the palette from the same icon map", () => {
    const shell = readFileSync(join(here, "DesktopApp.svelte"), "utf8");
    expect(shell).toContain(
      "iconUrl: companyIcons.get(c.cloudUid!.trim()) ?? c.iconUrl ?? null",
    );
    expect(shell).toMatch(/iconUrl: company\.iconUrl,/);
    expect(shell).toMatch(
      /paletteCompanies = \$derived\([\s\S]*?companyIconUrl\(\s*\(w\.cloudUid as string\)\.trim\(\),\s*companyIcons,/,
    );
  });

  it("renders the icon in the 18px CompanyIcon frame with initials as the else branch", () => {
    const rail = readFileSync(join(here, "AppRail.svelte"), "utf8");
    expect(rail).toMatch(
      /\{#if item\.iconUrl\}\s*<CompanyIcon iconUrl=\{item\.iconUrl\} size=\{18\}/,
    );
  });
});

/**
 * OWNER-010: the packaged app builds its roster from the native
 * `list_syncable_workspaces` command, whose rows are serialized Rust
 * `Workspace` structs. That struct had no `iconUrl`, so every tile showed
 * initials even though `/membership/me` carried the icon. These cases use the
 * native row shape and a cold roster.
 */
describe("rail icon from the native workspace row (OWNER-010)", () => {
  const nativeRow = (iconUrl?: string) => ({
    slug: "amass",
    displayName: "Amass",
    kind: "company",
    state: "cloud-only",
    cloudUid: "cmp_amass",
    bucketName: null,
    hasLocalFolder: false,
    localPath: null,
    membershipStatus: "active",
    role: "owner",
    syncEnabled: true,
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    brandingEnabled: false,
    ...(iconUrl ? { iconUrl } : {}),
  });

  it("carries iconUrl from a native row through to the rail tile", async () => {
    const { workspacesFromMembershipRows } = await import("../company/company-display-map.js");
    const roster = workspacesFromMembershipRows({ workspaces: [nativeRow(ICON)] });
    const icons = buildCompanyIconMap(roster);
    expect(companyIconUrl("cmp_amass", icons)).toBe(ICON);
    const [tile] = companyTiles([
      { uid: "cmp_amass", label: "Amass", iconUrl: companyIconUrl("cmp_amass", icons) },
    ]);
    expect(tile).toMatchObject({ iconUrl: ICON });
  });

  it("a refreshed roster replaces a stale icon-less one", async () => {
    const { workspacesFromMembershipRows } = await import("../company/company-display-map.js");
    const stale = buildCompanyIconMap(workspacesFromMembershipRows([nativeRow()]));
    expect(companyIconUrl("cmp_amass", stale)).toBeNull();
    const fresh = buildCompanyIconMap(workspacesFromMembershipRows([nativeRow(ICON)]));
    expect(companyIconUrl("cmp_amass", fresh)).toBe(ICON);
  });

  it("re-reads the roster on every company switch", () => {
    const src = readFileSync(join(here, "DesktopApp.svelte"), "utf8");
    const body = src.slice(src.indexOf("function setTenantScope("));
    const end = body.indexOf("\n  }\n");
    expect(body.slice(0, end)).toContain("onrefreshroster?.()");
  });
});
