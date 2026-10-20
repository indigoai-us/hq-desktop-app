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

/** Every button whose markup contains `marker`. */
function buttonsAround(src: string, marker: string): string[] {
  const buttons: string[] = [];
  for (let at = src.indexOf(marker); at !== -1; at = src.indexOf(marker, at + marker.length)) {
    const start = src.lastIndexOf("<button", at);
    buttons.push(src.slice(start, src.indexOf("</button", at)));
  }
  expect(buttons.length, marker).toBeGreaterThan(0);
  return buttons;
}

function buttonAround(src: string, label: string): string {
  const at = src.indexOf(label);
  expect(at, label).toBeGreaterThan(-1);
  const start = src.lastIndexOf("<button", at);
  return src.slice(start, src.indexOf("</button", at));
}

describe("labelled buttons in the separate windows carry a leading icon", () => {
  it.each([
    ["components/SignInPrompt.svelte", 'data-testid="retry-signin"', "refresh"],
    ["components/QuickWindowSidePane.svelte", "Open full desktop view", "external"],
    ["call/CallShell.svelte", "Start a transcription session", "plus"],
    ["call/CallShell.svelte", 'data-testid="call-permission-open-settings"', "settings"],
  ])("%s %s has the %s icon", (rel, marker, icon) => {
    const button = buttonAround(read(rel), marker);
    expect(button).toContain(`<RailIcon name="${icon}" />`);
    expect(read(rel)).toMatch(/import RailIcon from ['"]@hq\/ui\/rail-icon['"]/u);
  });

  it("drops the typed glyphs the icons replace", () => {
    expect(read("call/CallShell.svelte")).not.toContain("＋</span> Start a transcription session");
  });
});

describe("onboarding forward and skip buttons carry no icon", () => {
  // Design review (2026-10-12): forward and skip buttons in onboarding carry
  // no arrow, and no icon at all.
  it.each([
    ["components/onboarding/OnboardingWizard.svelte", 'data-testid="welcome-skip"', 1],
    ["components/onboarding/OnboardingWizard.svelte", "onclick={forward}>Next</button>", 2],
    ["components/onboarding/OnboardingWizard.svelte", 'data-testid="onboarding-first-folder-sync-skip"', 1],
    ["components/onboarding/OnboardingWizard.svelte", 'data-testid="onboarding-invite-skip"', 1],
    ["components/onboarding/OnboardingWizard.svelte", 'data-testid="microsoft-email-continue"', 1],
    ["components/onboarding/ConnectorImportStep.svelte", 'data-testid="connector-import-skip"', 2],
    ["components/onboarding/ConnectorImportStep.svelte", 'data-testid="connector-import-continue"', 1],
    ["components/onboarding/CompanyStep.svelte", 'data-testid="onboarding-company-skip"', 1],
    ["components/onboarding/CompanyStep.svelte", 'data-testid="onboarding-company-invite-skip"', 1],
    ["components/onboarding/CompanyStep.svelte", 'data-testid="onboarding-company-invite-continue"', 1],
    ["components/onboarding/CompanyStep.svelte", 'data-testid="onboarding-company-ready-continue"', 1],
    ["components/onboarding/CinematicIntro.svelte", ">Skip intro</button>", 1],
  ])("%s %s has no icon (%i buttons)", (rel, marker, count) => {
    const buttons = buttonsAround(read(rel), marker);
    expect(buttons).toHaveLength(count);
    for (const button of buttons) {
      expect(button).not.toContain("<RailIcon");
      expect(button).not.toContain("arrow-right");
    }
  });

  it("puts no arrow-right icon on any onboarding button", () => {
    for (const rel of [
      "components/onboarding/OnboardingWizard.svelte",
      "components/onboarding/ConnectorImportStep.svelte",
      "components/onboarding/CompanyStep.svelte",
      "components/onboarding/CinematicIntro.svelte",
    ]) {
      expect(read(rel), rel).not.toContain('<RailIcon name="arrow-right"');
    }
  });
});
