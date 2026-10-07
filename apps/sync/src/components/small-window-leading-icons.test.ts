/**
 * Owner decision (2026-10-05): the separate windows (onboarding, quick window,
 * call window, sign-in) get the same leading icons as the main app, drawn by
 * the shared RailIcon through `@hq/ui/rail-icon`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

function buttonAround(src: string, label: string): string {
  const at = src.indexOf(label);
  expect(at, label).toBeGreaterThan(-1);
  const start = src.lastIndexOf("<button", at);
  return src.slice(start, src.indexOf("</button", at));
}

describe("labelled buttons in the separate windows carry a leading icon", () => {
  it.each([
    ["components/SignInPrompt.svelte", 'data-testid="retry-signin"', "refresh"],
    ["components/onboarding/CompanyStep.svelte", 'data-testid="onboarding-checkout-done"', "check-circle"],
    ["components/onboarding/OnboardingWizard.svelte", 'data-testid="welcome-skip"', "arrow-right"],
    ["components/onboarding/ConnectorImportStep.svelte", 'data-testid="connector-import-skip"', "arrow-right"],
    ["components/QuickWindowSidePane.svelte", "Open full desktop view", "external"],
    ["call/CallShell.svelte", "Start a transcription session", "plus"],
    ["call/CallShell.svelte", 'data-testid="call-permission-open-settings"', "settings"],
    ["components/messaging/ChannelRoster.svelte", 'class="invite-open"', "user-plus"],
  ])("%s %s has the %s icon", (rel, marker, icon) => {
    const button = buttonAround(read(rel), marker);
    expect(button).toContain(`<RailIcon name="${icon}" />`);
    expect(read(rel)).toMatch(/import RailIcon from ['"]@hq\/ui\/rail-icon['"]/u);
  });

  it("drops the typed glyphs the icons replace", () => {
    expect(read("call/CallShell.svelte")).not.toContain("＋</span> Start a transcription session");
    expect(read("components/messaging/ChannelRoster.svelte")).not.toContain("+ Invite people");
  });
});
