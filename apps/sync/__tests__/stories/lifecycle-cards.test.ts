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
  it("keeps Chat · Atlas · Team · Integrations · Settings in CompanyTabs", () => {
    const src = readUi("chat/CompanyTabs.svelte");
    expect(src).toContain("Chat");
    expect(src).toContain("Atlas");
    expect(src).toContain("Team");
    expect(src).toContain("Integrations");
    expect(src).toContain("Settings");
    expect(src).toContain('data-testid="company-channel-tabs"');
  });

  it("DesktopApp mounts company tabs, Team, Integrations, Settings, Atlas, and the hero", () => {
    const src = readUi("shell/DesktopApp.svelte");
    expect(src).toContain("CompanyTabs");
    expect(src).toContain("TeamTab");
    expect(src).toContain("IntegrationsTab");
    expect(src).toContain("SettingsTab");
    expect(src).toContain("AtlasTab");
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
