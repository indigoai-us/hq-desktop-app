// @vitest-environment happy-dom

/**
 * HQ no longer has a "setup bot". The #welcome card and the guided tour talk
 * about the person's assistant (owner, 2026-10-19). This fails if the old
 * words come back on either surface.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import SetupChannelIntro from "./SetupChannelIntro.svelte";
import { SETUP_BOT_GENERIC_FAILURE, type SetupBotLauncher } from "./setup-bot";
import { NO_AI_TOOLS } from "../settings/setup-launch";
import GuidedTour from "../tour/GuidedTour.svelte";
import { tourSteps } from "../tour/guided-tour.js";

const OLD_WORDS = /setup[\s-]*bot|setup[\s-]*agent/i;

const ok = <T,>(value: T) => ({ ok: true as const, value });

const shell = {
  detectAiTools: vi.fn(async () => ok({ ...NO_AI_TOOLS, claude: true })),
  openClaudeCodeLink: vi.fn(async () => ok(undefined)),
  launchClaudeCode: vi.fn(async () => ok(undefined)),
  launchCodexWorkspace: vi.fn(async () => ok(undefined)),
  launchCliInTerminal: vi.fn(async () => ok(undefined)),
};

const settings = { getSetupStatus: async () => ok({ hqFolderPath: "/tmp/HQ" }) };

function launcher(over: Partial<SetupBotLauncher>): SetupBotLauncher {
  return {
    existing: false,
    ready: true,
    starting: false,
    error: null,
    start: vi.fn(async () => ({ ok: true as const, existing: true })),
    ...over,
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.clearAllMocks();
});

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Visible text plus the labels a screen reader reads. */
function renderedWords(root: HTMLElement): string {
  const labels = [...root.querySelectorAll("[aria-label],[title],[placeholder]")].map((el) =>
    ["aria-label", "title", "placeholder"].map((name) => el.getAttribute(name) ?? "").join(" "),
  );
  return [root.textContent ?? "", ...labels].join(" ");
}

describe("assistant wording on #welcome and the tour", () => {
  it.each([
    ["existing", { existing: true }],
    ["not created yet", { existing: false }],
    ["starting", { starting: true }],
    ["failed to start", { error: SETUP_BOT_GENERIC_FAILURE }],
  ] as const)("the #welcome card never says setup bot or Setup Agent (%s)", async (_label, over) => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(SetupChannelIntro, {
      target: host,
      props: { settings, shell, setupBot: launcher(over) } as never,
    });
    await settle();
    const words = renderedWords(host);
    expect(words).toMatch(/assistant/i);
    expect(words).not.toMatch(OLD_WORDS);
  });

  it("no tour step says setup bot or Setup Agent", async () => {
    for (const ctx of [{}, { hasCompanyVault: true, hasCompany: true }]) {
      const steps = tourSteps(ctx);
      expect(steps).toHaveLength(8);
      host = document.createElement("div");
      document.body.appendChild(host);
      const props = $state({ step: steps[0], index: 0, count: steps.length, onnext: vi.fn(), onback: vi.fn(), onskip: vi.fn() });
      component = mount(GuidedTour, { target: host, props });
      for (let i = 0; i < steps.length; i += 1) {
        props.step = steps[i];
        props.index = i;
        flushSync();
        await tick();
        const card = document.querySelector<HTMLElement>('[data-testid="guided-tour-card"]');
        expect(card, `step ${i + 1}`).toBeTruthy();
        expect(renderedWords(card!), `step ${i + 1}`).not.toMatch(OLD_WORDS);
      }
      await unmount(component);
      component = null;
      host.remove();
    }
  });
});
