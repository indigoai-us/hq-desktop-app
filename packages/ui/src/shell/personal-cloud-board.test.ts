/**
 * Personal cloud board gating, ported from the deleted company Overview page
 * (CompanyPage.svelte).
 *
 * The Overview read a personal workspace's board and summary only when the
 * workspace had a cloud UID AND `desktop.personal-workspace-board-v1` was on;
 * otherwise it stayed "local only". In the console rail the company reads
 * (Atlas landing summary, sidepane counts, Team, company settings) all hang
 * off a company tile, and the rail only builds tiles for cloud companies. A
 * personal workspace never reaches those reads, flagged or not, so it stays
 * local-only in every case the old test covered.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shell = readFileSync(new URL("./DesktopApp.svelte", import.meta.url), "utf8");

function block(start: string, length = 900): string {
  const at = shell.indexOf(start);
  expect(at, start).toBeGreaterThan(-1);
  return shell.slice(at, at + length);
}

describe("personal workspace stays local-only in the console rail", () => {
  it("builds company tiles only for cloud-backed companies, never the personal workspace", () => {
    const roster = block("const railCompanyRoster = $derived(", 400);
    expect(roster).toContain('c.kind === "company"');
    expect(roster).toContain('(c.cloudUid ?? "").trim()');
  });

  it("opens the company pane only for a tile in that roster", () => {
    const pane = block("const companyPaneCompany = $derived.by(", 400);
    expect(pane).toContain("railCompanyRoster.find(");
  });

  it("enables the Atlas summary read only inside the company pane", () => {
    // 9e0775c7 kept this branch behind companyPaneCompany and made the
    // props tolerate the pane going null once during teardown. The slug
    // still comes only from that pane.
    const atlas = block('{:else if railPlaceholder?.id === "atlas" && companyPaneCompany}', 520);
    expect(atlas).toContain("<AtlasLandingHost");
    expect(atlas).toContain('slug={companyPaneCompany?.slug ?? ""}');
    expect(atlas).toContain("summaryEnabled={Boolean(adapter.company)}");
  });

  it("never reads the personal board flag, so it cannot switch a personal board on", () => {
    expect(shell).not.toContain("PERSONAL_WORKSPACE_BOARD_FLAG");
    expect(shell).not.toContain("personal-workspace-board-v1");
  });
});
