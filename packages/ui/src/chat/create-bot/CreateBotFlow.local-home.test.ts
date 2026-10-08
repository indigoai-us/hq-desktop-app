// @vitest-environment happy-dom

/**
 * Owner (2026-10-05), on the repeated "Where does it run?" step after Local
 * was picked on the New bot choice screen: "Skip it".
 *
 * Opened with Local already chosen, the flow never asks Cloud or Local
 * again: it walks name → coding tool (a template is a link on that step).
 * The coding tool picker, its sign-in and its install help live on that
 * last step, so nothing the old "Where does it run?" step offered is lost,
 * and Create stays off until the coding tool is ready. (Renamed from
 * CreateBotFlow.skip-home.test.ts when the skipHome layout was removed.)
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

function step(): string | null {
  return q('[data-testid="chat-create-bot-step"]')?.getAttribute("data-step") ?? null;
}

/** Name → coding tool: the only local step after the name. */
async function toCodingTool(): Promise<void> {
  click('[data-testid="new-bot-continue-name"]');
  await settle();
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
      oncreate: async () => undefined,
      initialHome: "local",
      ...props,
    },
  });
}

describe("New bot flow with Local already picked", () => {
  it("never asks Where does it run?: name → coding tool", async () => {
    open();
    await settle();
    expect(step()).toBe("name");
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeNull();
    expect(q('[data-testid="new-bot-name"]')).toBeTruthy();
    click('[data-testid="new-bot-continue-name"]');
    await settle();
    expect(step()).toBe("home");
    expect(q('[data-testid="create-bot-kind-step"]')).toBeNull();
    expect(q('[data-testid="create-bot-runtime-section"]')).toBeTruthy();
    expect(q('[data-testid="create-bot-home-step"]')).toBeNull();
    expect(q('[data-testid="chat-bot-where"]')).toBeNull();
    expect(q('[data-testid="chat-bot-where-local"]')).toBeNull();
    expect(q('[data-testid="chat-bot-where-cloud"]')).toBeNull();
    expect(host.textContent).not.toContain("live?");
  });

  it("Back from the coding tool returns to the name", async () => {
    const onback = vi.fn();
    open({ onback });
    await settle();
    await toCodingTool();
    click('[data-testid="create-bot-back"]');
    await settle();
    expect(q('[data-testid="new-bot-name"]')).toBeTruthy();
    // The host already asked Cloud or Local, so Back from the name is the host's.
    click('[data-testid="create-bot-back"]');
    await settle();
    expect(onback).toHaveBeenCalledOnce();
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeNull();
  });

  it("shows the coding tool picker on the last step, and switching tools still works", async () => {
    open();
    await settle();
    await toCodingTool();
    expect(q('[data-testid="create-bot-runtime-section"]')).toBeTruthy();
    expect(q('[data-testid="chat-bot-runtime-claude"]')?.getAttribute("aria-checked")).toBe("true");
    click('[data-testid="chat-bot-runtime-codex"]');
    await settle();
    expect(q('[data-testid="chat-bot-runtime-codex"]')?.getAttribute("aria-checked")).toBe("true");
  });

  it("offers sign-in on the coding tool step when the tool is signed out, and blocks Create until then", async () => {
    const onsignin = vi.fn();
    open({
      botRuntimeReady: { claude: false, codex: false, grok: false },
      botRuntimeStatus: { claude: SIGNED_OUT, codex: SIGNED_OUT, grok: SIGNED_OUT },
      onsignin,
    });
    await settle();
    await toCodingTool();
    expect(step()).toBe("home");
    // The card says it, and one line under the cards offers the sign-in.
    expect(q('[data-testid="chat-bot-runtime-claude-status"]')?.textContent).toBe("Sign in first");
    expect(q('[data-testid="chat-bot-runtime-help"]')?.textContent).toMatch(/sign in/i);
    expect(q('[data-testid="create-bot-issue"]')).toBeNull();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')?.disabled).toBe(true);
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')?.disabled).toBe(true);
    click('[data-testid="chat-bot-runtime-signin"]');
    await settle();
    expect(onsignin).toHaveBeenCalledWith("claude");
  });

  it("offers install help on the coding tool step when the tool is not installed", async () => {
    const onassistedinstall = vi.fn(async () => ({ ok: true }));
    open({
      botRuntimeReady: { claude: false, codex: false, grok: false },
      botRuntimeStatus: { claude: MISSING, codex: MISSING, grok: MISSING },
      onopenassistant: vi.fn(async () => ({ ok: true })),
      onassistedinstall,
      onrecheckruntimes: vi.fn(async () => undefined),
    });
    await settle();
    await toCodingTool();
    expect(q('[data-testid="create-bot-runtime-section"] [data-testid^="install-choice"]')).toBeTruthy();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')?.disabled).toBe(true);
  });

  it("without a preset home and with Cloud offered, the flow asks Cloud or Local right after the name", async () => {
    open({
      initialHome: null,
      onCloudCreate: vi.fn(),
      agentTargets: [{ companyUid: "cmp_indigo", label: "Indigo" }],
    });
    await settle();
    expect(step()).toBe("name");
    await toCodingTool();
    expect(step()).toBe("where");
    expect(q('[data-testid="new-bot-choice-local"]')).toBeTruthy();
    expect(q('[data-testid="new-bot-choice-cloud"]')).toBeTruthy();
    expect(q('[data-testid="create-bot-runtime-section"]')).toBeNull();
  });
});
