// @vitest-environment happy-dom

/**
 * Owner (2026-10-06): "we need to fix the local bot flow to use the same
 * design as cloud bot creation."
 *
 * In the New bot takeover the local flow is the cloud flow's step screens:
 * name, then blank or a template, then the coding tool. Every capability of
 * the old wizard is still reachable on them (policy
 * indigo-never-degrade-bot-experience-to-simplify-setup).
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

function key(init: KeyboardEventInit, target?: Element | null): void {
  (target ?? q('[data-testid="chat-create-bot-step"]'))!.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, ...init }),
  );
}

function step(): string | null {
  return q('[data-testid="chat-create-bot-step"]')?.getAttribute("data-step") ?? null;
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
      layout: "steps",
      ...props,
    },
  });
}

describe("Local bot on the cloud flow's step screens", () => {
  it("walks name → blank or template → coding tool, with the cloud flow's head and three dots", async () => {
    open({ onback: () => undefined });
    await settle();
    const root = q('[data-testid="chat-create-bot-step"]')!;
    expect(root.getAttribute("data-layout")).toBe("steps");
    expect(root.classList.contains("new-bot-create")).toBe(true);
    // The old wizard's crumbs, footer and preview card are gone.
    expect(q(".flow-crumbs")).toBeNull();
    expect(q('[data-testid="bot-preview-card"]')).toBeNull();

    expect(step()).toBe("details");
    expect(q(".new-bot-takeover-kicker")?.textContent).toBe("A new teammate");
    expect(q("#new-bot-takeover-title")?.textContent).toBe("Enter a name.");
    expect(q("#new-bot-takeover-title em")?.textContent).toBe("name.");
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 1 of 3");
    expect(q('[data-testid="new-bot-progress"]')?.querySelectorAll("span").length).toBe(3);
    expect(q('[data-testid="create-bot-back"]')?.textContent).toContain("Back");
    expect(q('[data-testid="create-bot-next"]')?.textContent).toContain("Continue");
    expect(q('[data-testid="create-bot-next"]')?.classList.contains("new-bot-create-submit")).toBe(true);

    click('[data-testid="create-bot-next"]');
    await settle();
    expect(step()).toBe("kind");
    expect(q("#new-bot-takeover-title")?.textContent).toBe("Start blank or from a template.");
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 2 of 3");

    click('[data-testid="create-bot-next"]');
    await settle();
    expect(step()).toBe("home");
    expect(q("#new-bot-takeover-title")?.textContent).toBe("Pick the coding tool.");
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 3 of 3");
    // "Where does it run?" is never asked again.
    expect(q('[data-testid="chat-bot-where"]')).toBeNull();
    expect(q('[data-testid="chat-bot-create"]')?.textContent).toContain("Create bot");
    expect(q('[data-testid="create-bot-hint"]')?.textContent).toContain("to create");
  });

  it("shows the name step's handle and avatar quietly, and the identity line on the later steps", async () => {
    open();
    await settle();
    const name = q<HTMLInputElement>('[data-testid="chat-bot-name"]')!;
    expect(name.classList.contains("new-bot-create-input")).toBe(true);
    name.value = "Dr Love";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(q('[data-testid="chat-bot-derived-handle"]')?.textContent).toBe("@dr-love");
    expect(q('[data-testid="chat-bot-name-help"] .name-mark')).toBeTruthy();
    expect(q('[data-testid="chat-bot-handle-edit"]')).toBeTruthy();
    // No identity line on the name step: the field is the identity.
    expect(q('[data-testid="bot-identity-line"]')).toBeNull();

    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="bot-identity-name"]')?.textContent).toBe("Dr Love");
    expect(q('[data-testid="bot-identity-meta"]')?.textContent).toBe("Local · Claude Code · acts as you");
    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="bot-identity-line"]')).toBeTruthy();
  });

  it("keeps title, avatar pick, who it is for and permissions under More options on the name step", async () => {
    open({ avatarPacks: [] });
    await settle();
    expect(q('[data-testid="chat-bot-title"]')).toBeNull();
    const more = q<HTMLButtonElement>('[data-testid="chat-bot-more-options"]')!;
    expect(more.getAttribute("aria-expanded")).toBe("false");
    more.click();
    await settle();
    expect(q('[data-testid="chat-bot-title"]')).toBeTruthy();
    expect(q('[data-testid="chat-bot-avatar-toggle"]')).toBeTruthy();
    expect(q('[data-testid="chat-bot-scope-personal"]')?.getAttribute("aria-checked")).toBe("true");
    expect(q('[data-testid="chat-bot-auto-approve"]')).toBeTruthy();
    click('[data-testid="chat-bot-avatar-toggle"]');
    await settle();
    expect(q('[data-testid="chat-bot-avatar-picker"]')).toBeTruthy();
  });

  it("offers Blank and From a template as rows, and reveals the template list inline", async () => {
    const oncreate = vi.fn(async () => undefined);
    open({
      oncreate,
      botWorkers: [{ id: "indigo/iris-cx", path: "companies/indigo/workers/iris-cx", description: "Answers customers." }],
    });
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="create-bot-kind-blank"]')?.getAttribute("aria-checked")).toBe("true");
    // Rows, not tiles: no icon, and the flow says the lede.
    expect(q(".cb-card-ic")).toBeNull();
    expect(q(".cb-lede")).toBeNull();
    // Picking Blank does not move on by itself; Continue does.
    click('[data-testid="create-bot-kind-blank"]');
    await settle();
    expect(step()).toBe("kind");
    click('[data-testid="create-bot-kind-template"]');
    await settle();
    expect(q('[data-testid="create-bot-templates"]')).toBeTruthy();
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')!.disabled).toBe(true);
    expect(q('[data-testid="create-bot-issue"]')?.textContent).toBe("Pick a template.");
    click('[data-testid="create-bot-template-card"]');
    await settle();
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')!.disabled).toBe(false);
    expect(q('[data-testid="bot-identity-meta"]')?.textContent).toContain("from ");
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="chat-bot-create"]');
    await settle(10);
    expect(oncreate).toHaveBeenCalledOnce();
    expect((oncreate.mock.calls[0] as unknown[])[0]).toMatchObject({ worker: "indigo/iris-cx" });
  });

  it("picks the coding tool with its sign-in on the last step, and holds Create until it is signed in", async () => {
    const onsignin = vi.fn(async () => undefined);
    open({ onsignin });
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled).toBe(false);
    click('[data-testid="chat-bot-runtime-codex"]');
    await settle();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled).toBe(true);
    expect(q('[data-testid="create-bot-issue"]')?.textContent).toContain("Codex");
    click('[data-testid="chat-bot-runtime-signin"]');
    await settle();
    expect(onsignin).toHaveBeenCalledWith("codex");
    expect(q('[data-testid="bot-identity-meta"]')?.textContent).toContain("Local · Codex");
  });

  it("shows the install help on the coding tool step when the tool is not installed", async () => {
    open({
      botRuntimeReady: { claude: false, codex: false, grok: false },
      botRuntimeStatus: { claude: MISSING, codex: SIGNED_OUT, grok: SIGNED_OUT },
      onrecheckruntimes: async () => undefined,
    });
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="chat-bot-runtime-claude"]');
    await settle();
    expect(q('[data-testid="chat-bot-runtime-help"]')?.getAttribute("data-runtime-state")).toBe("notInstalled");
    expect(q('[data-testid="chat-bot-runtime-recheck"]')).toBeTruthy();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled).toBe(true);
  });

  it("acknowledges Create at once: Creating…, busy, and no second create", async () => {
    let finish!: () => void;
    const oncreate = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    open({ oncreate });
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="chat-bot-create"]');
    await settle();
    // The host marks the create in flight; the button says so and holds.
    component && (await unmount(component));
    component = null;
    host.remove();
    open({ oncreate, entryBusy: "bot" });
    await settle();
    expect(q('[data-testid="create-bot-next"]')?.textContent).toContain("Creating…");
    expect(q('[data-testid="create-bot-next"]')?.getAttribute("aria-busy")).toBe("true");
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')!.disabled).toBe(true);
    key({ key: "Enter", metaKey: true });
    await settle();
    expect(oncreate).toHaveBeenCalledOnce();
    finish();
  });

  it("Enter moves on from each step, and ⌘↵ creates on the last one", async () => {
    const oncreate = vi.fn(async () => undefined);
    open({ oncreate });
    await settle();
    key({ key: "Enter" }, q('[data-testid="chat-bot-name"]'));
    await settle();
    expect(step()).toBe("kind");
    key({ key: "Enter" });
    await settle();
    expect(step()).toBe("home");
    expect(oncreate).not.toHaveBeenCalled();
    key({ key: "Enter", metaKey: true, ctrlKey: true });
    await settle(10);
    expect(oncreate).toHaveBeenCalledOnce();
  });

  it("offers Create a cloud bot instead only on the name step", async () => {
    const onswitchcloud = vi.fn();
    open({ onswitchcloud });
    await settle();
    const link = q<HTMLButtonElement>('[data-testid="create-bot-switch-cloud"]')!;
    expect(link.textContent).toBe("Create a cloud bot instead");
    expect(link.classList.contains("new-bot-takeover-local")).toBe(true);
    link.click();
    expect(onswitchcloud).toHaveBeenCalledOnce();
    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="create-bot-switch-cloud"]')).toBeNull();
  });

  it("Back walks the steps, then hands back to the host from the name step", async () => {
    const onback = vi.fn();
    open({ onback });
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="create-bot-back"]');
    await settle();
    expect(step()).toBe("details");
    click('[data-testid="create-bot-back"]');
    expect(onback).toHaveBeenCalledOnce();
  });

  it("keeps the old wizard for the + window and Settings", async () => {
    open({ layout: "wizard" });
    await settle();
    expect(q('[data-testid="chat-create-bot-step"]')?.getAttribute("data-layout")).toBeNull();
    expect(q('[data-testid="create-bot-kind-step"]')).toBeTruthy();
  });
});
