// @vitest-environment happy-dom

/**
 * Owner (2026-10-05), on the repeated "Where does it run?" step after Local
 * was picked on the New bot choice screen: "Skip it".
 *
 * Opened with Local already chosen, the flow goes Kind → Details. The coding
 * tool picker, its sign-in and its install help move onto the Details step,
 * so nothing the skipped step offered is lost, and Create stays off until
 * the coding tool is ready.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import CreateBotFlow from "./CreateBotFlow.svelte";
import type { RuntimeStatus } from "./runtime-status.js";

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

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return host.querySelector<T>(selector);
}

function click(selector: string): void {
  const el = q<HTMLButtonElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  el.click();
}

const SIGNED_OUT: RuntimeStatus = { state: "signedOut" };
const SIGNED_IN: RuntimeStatus = { state: "signedIn" };
const MISSING: RuntimeStatus = { state: "notInstalled", searched: ["/usr/local/bin"] };

function open(props: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CreateBotFlow, {
    target: host,
    props: {
      botRuntimeReady: { claude: true, codex: false, grok: false },
      botRuntimeStatus: { claude: SIGNED_IN, codex: SIGNED_OUT, grok: SIGNED_OUT },
      botWorkers: [],
      existingNames: [],
      botCompanies: [{ slug: "indigo", label: "Indigo" }],
      previewPlacement: "top",
      oncreate: async () => undefined,
      initialHome: "local",
      ...props,
    },
  });
}

describe("New bot flow with Local already picked", () => {
  it("skips the Where does it run? step: Kind goes straight to Details", async () => {
    open();
    await settle();
    expect(q('[data-testid="create-bot-kind-step"]')).toBeTruthy();
    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="create-bot-home-step"]')).toBeNull();
    expect(q('[data-testid="chat-bot-where"]')).toBeNull();
    expect(q('[data-testid="create-bot-details-step"]')).toBeTruthy();
    expect(host.textContent).not.toContain("Where does it run?");
  });

  it("Back from Details returns to Kind", async () => {
    open();
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="create-bot-back"]');
    await settle();
    expect(q('[data-testid="create-bot-kind-step"]')).toBeTruthy();
  });

  it("shows the coding tool picker on Details, and switching tools still works", async () => {
    open();
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="create-bot-runtime-section"]')).toBeTruthy();
    expect(q('[data-testid="chat-bot-runtime-claude"]')?.getAttribute("aria-checked")).toBe("true");
    click('[data-testid="chat-bot-runtime-codex"]');
    await settle();
    expect(q('[data-testid="chat-bot-runtime-codex"]')?.getAttribute("aria-checked")).toBe("true");
  });

  it("offers sign-in on Details when the coding tool is signed out, and blocks Create until then", async () => {
    const onsignin = vi.fn();
    open({
      botRuntimeReady: { claude: false, codex: false, grok: false },
      botRuntimeStatus: { claude: SIGNED_OUT, codex: SIGNED_OUT, grok: SIGNED_OUT },
      onsignin,
    });
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="create-bot-details-step"]')).toBeTruthy();
    expect(q('[data-testid="create-bot-issue"]')?.textContent).toMatch(/sign/i);
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')?.disabled).toBe(true);
    click('[data-testid="chat-bot-runtime-signin"]');
    await settle();
    expect(onsignin).toHaveBeenCalledWith("claude");
  });

  it("offers install help on Details when the coding tool is not installed", async () => {
    const onassistedinstall = vi.fn(async () => ({ ok: true }));
    open({
      botRuntimeReady: { claude: false, codex: false, grok: false },
      botRuntimeStatus: { claude: MISSING, codex: MISSING, grok: MISSING },
      onopenassistant: vi.fn(async () => ({ ok: true })),
      onassistedinstall,
      onrecheckruntimes: vi.fn(async () => undefined),
    });
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="create-bot-runtime-section"] [data-testid^="install-choice"]')).toBeTruthy();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')?.disabled).toBe(true);
  });

  it("without a preset home, the Where does it run? step is still shown", async () => {
    open({ initialHome: null });
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="create-bot-home-step"]')).toBeTruthy();
    expect(q('[data-testid="create-bot-runtime-section"]')).toBeNull();
  });
});
