import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * US-013 source contract: company-channel lifecycle chrome survives
 * desktop-alt tree reverts. Behaviour lives in packages/ui story tests.
 */
const ui = (rel: string) =>
  readFileSync(join(process.cwd(), "../../packages/ui/src", rel), "utf8");

describe("lifecycle company channel", () => {
  it("DesktopApp keeps the five company tabs and Team/Settings/Atlas/Integrations mounts", () => {
    const app = ui("shell/DesktopApp.svelte");
    expect(app).toContain("CompanyTabs");
    expect(app).toContain("<TeamTab");
    expect(app).toContain("<IntegrationsTab");
    expect(app).toContain("<SettingsTab");
    expect(app).toContain("<AtlasTab");
    expect(app).toContain("<CompanyHero");
  });

  it("lifecycle card renderer and tab_row kind remain in the chat models", () => {
    const models = ui("chat/messaging/channelMessageModels.ts");
    expect(models).toContain("lifecycle_card");
    expect(models).toContain('"tab_row"');
  });
});
