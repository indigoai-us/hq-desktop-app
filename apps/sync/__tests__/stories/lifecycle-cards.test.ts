/**
 * Channel-native company lifecycle — desktop story harness (US-013).
 * Zero-network: UI package story tests own behaviour; this pins the sync
 * app to the tab chrome and card-action commands.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const uiRoot = join(__dirname, "../../../../packages/ui/src");

function readUi(rel: string): string {
  return readFileSync(join(uiRoot, rel), "utf8");
}

describe("lifecycle cards desktop harness", () => {
  it("company header gear opens the HQ console (no desktop Team/Settings/Atlas tabs)", () => {
    const src = readUi("chat/CompanyTabs.svelte");
    expect(src).toContain("companyConsoleUrl");
    expect(src).toContain('data-testid="company-console-gear"');
    expect(src).not.toContain("Atlas");
  });

  it("DesktopApp mounts the console gear and the hero (no Team/Settings/Atlas tabs)", () => {
    const src = readUi("shell/DesktopApp.svelte");
    expect(src).toContain("CompanyTabs");
    expect(src).not.toContain("TeamTab");
    expect(src).not.toContain("IntegrationsTab");
    expect(src).not.toContain("SettingsTab");
    expect(src).not.toContain("AtlasTab");
    expect(src).toContain("CompanyHero");
    expect(src).toContain("runCardAction");
  });

  it("registers get_company_tab and run_company_tab_action", () => {
    const main = readFileSync(
      join(__dirname, "../../src-tauri/src/main.rs"),
      "utf8",
    );
    expect(main).toContain("get_company_tab");
    expect(main).toContain("run_company_tab_action");
  });
});
