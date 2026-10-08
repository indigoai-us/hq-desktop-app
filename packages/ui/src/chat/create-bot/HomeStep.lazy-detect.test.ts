// @vitest-environment happy-dom

/**
 * The AI-tool probe (`detect_ai_tools` on the host) is expensive — shell
 * probes for claude/codex/grok plus stats of thousands of files under
 * ~/.claude / ~/.codex / ~/.grok — and running it on every app open froze
 * the desktop shell at boot (#1152). The fix moves the probe off the mount
 * of the desktop shell and onto the surfaces that actually need the answer:
 * the New bot wizard's HomeStep and the setup assistant.
 *
 * This test locks that in: HomeStep asks the host for the probe LAZILY on
 * mount when aiTools is null, does NOT re-fire when the parent already has
 * a value, and re-fires on "Check again" — while the panel stays
 * interactive with the neutral "Checking…" line the whole time (so a slow
 * or failing probe never blocks the UI).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import CreateBotFlow from "./CreateBotFlow.svelte";
import type { RuntimeStatus } from "./runtime-status.js";
import { NO_AI_TOOLS, type AiTools } from "../../settings/setup-launch.js";

/** name → coding tool: the coding-tool screen is the only local step after the name. */
async function walkToHome(root: HTMLElement, settleFn: () => Promise<void>): Promise<void> {
  const name = root.querySelector<HTMLInputElement>('[data-testid="new-bot-name"]');
  if (!name) throw new Error("missing new-bot-name");
  name.value = "Dr Love";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  await settleFn();
  const next = root.querySelector<HTMLButtonElement>('[data-testid="new-bot-continue-name"]');
  if (!next) throw new Error("missing new-bot-continue-name");
  next.click();
  await settleFn();
  if (!root.querySelector('[data-testid="create-bot-sunrise-home"]')) throw new Error("not on home");
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

const MISSING: RuntimeStatus = {
  state: "notInstalled",
  searched: ["/opt/homebrew/bin", "/usr/local/bin"],
};

async function openWizardHome(
  props: Record<string, unknown> = {},
): Promise<{ onrequestaitools: ReturnType<typeof vi.fn> }> {
  const onrequestaitools = vi.fn();
  const onopenassistant = vi.fn(async () => ({ ok: true as const }));
  const onassistedinstall = vi.fn(async () => ({ ok: true as const }));
  const onrecheckruntimes = vi.fn(async () => undefined);
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CreateBotFlow, {
    target: host,
    props: {
      botRuntimeReady: { claude: false, codex: false, grok: false },
      botRuntimeStatus: { claude: MISSING, codex: MISSING, grok: MISSING },
      botWorkers: [],
      existingNames: [],
      botCompanies: [{ slug: "indigo", label: "Indigo" }],
      oncreate: async () => undefined,
      onsignin: () => undefined,
      onrecheckruntimes,
      onopenassistant,
      onassistedinstall,
      onrequestaitools,
      aiTools: null,
      ...props,
    },
  });
  await settle();
  // Walk details → kind → home — HomeStep only mounts (and only fires the
  // lazy probe) once the user is on the coding-tool step.
  await walkToHome(host, () => settle());
  return { onrequestaitools };
}

describe("HomeStep · lazy AI-tool detection", () => {
  it("asks the host to probe on mount when aiTools is null", async () => {
    const { onrequestaitools } = await openWizardHome();
    expect(onrequestaitools).toHaveBeenCalledTimes(1);
  });

  it("stays interactive with a 'Checking…' line while the probe is pending", async () => {
    await openWizardHome();
    // Panel is mounted; neutral probing line is rendered; retry button is
    // still clickable (not disabled) so a slow probe never blocks the user.
    const probing = host.querySelector('[data-testid="install-choice-probing"]');
    expect(probing?.textContent ?? "").toContain("Checking");
    const recheck = host.querySelector<HTMLButtonElement>(
      '[data-testid="install-choice-recheck"]',
    );
    expect(recheck).not.toBeNull();
    expect(recheck?.disabled).toBe(false);
  });

  it("re-asks on the panel's Check-again retry (failure path)", async () => {
    const { onrequestaitools } = await openWizardHome();
    onrequestaitools.mockClear();
    const recheck = host.querySelector<HTMLButtonElement>(
      '[data-testid="install-choice-recheck"]',
    );
    recheck?.click();
    await settle();
    expect(onrequestaitools).toHaveBeenCalledTimes(1);
  });

  it("does not re-ask on mount when the parent already has a value", async () => {
    const tools: AiTools = { ...NO_AI_TOOLS, codex_desktop: true, any: true };
    const { onrequestaitools } = await openWizardHome({ aiTools: tools });
    expect(onrequestaitools).not.toHaveBeenCalled();
  });
});
