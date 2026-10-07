// @vitest-environment happy-dom

/**
 * Owner (2026-10-07): the bot's name is step 1 on every New bot path, then
 * "Where should <Name> live?", then the home's steps. A local bot has one
 * step after that: the coding tool, defaulting to the signed-in one. A
 * template and the advanced settings (handle, who it is for, permissions,
 * memory) are folded away on that step, and the bot asks for its title,
 * avatar and model in its first message (a kickoff). Every capability the
 * create screens keep is still reachable on them (policy
 * indigo-never-degrade-bot-experience-to-simplify-setup).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type AgentProvisionOptionsView } from "@hq/platform";

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

/** Type a name on the name step and continue. */
async function nameIt(name = "Dr Love"): Promise<void> {
  const input = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
  input.value = name;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  click('[data-testid="new-bot-continue-name"]');
  await settle();
}

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

describe("Local bot: name, then the coding tool", () => {
  it("walks name → coding tool, with the takeover's head and dots that count the whole flow", async () => {
    open({ onback: () => undefined });
    await settle();
    const root = q('[data-testid="chat-create-bot-step"]')!;
    expect(root.classList.contains("new-bot-create")).toBe(true);
    // The old wizard's crumbs, footer and preview card are gone.
    expect(q(".flow-crumbs")).toBeNull();
    expect(q('[data-testid^="create-bot-crumb-"]')).toBeNull();
    expect(q('[data-testid="bot-preview-card"]')).toBeNull();

    expect(step()).toBe("name");
    expect(q(".new-bot-takeover-kicker")?.textContent).toBe("A new teammate");
    expect(q("#new-bot-takeover-title")?.textContent).toBe("Enter a name.");
    expect(q("#new-bot-takeover-title em")?.textContent).toBe("name.");
    // The host asked "Where should it live?": name, where, coding tool.
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 1 of 3");
    expect(q('[data-testid="new-bot-progress"]')?.querySelectorAll("span").length).toBe(3);
    expect(q('[data-testid="create-bot-back"]')?.textContent).toContain("Back");
    expect(q('[data-testid="new-bot-continue-name"]')?.textContent).toContain("Continue");
    expect(q('[data-testid="new-bot-continue-name"]')?.classList.contains("new-bot-create-submit")).toBe(true);
    // No identity line on the name step: the field is the identity.
    expect(q('[data-testid="bot-identity-line"]')).toBeNull();

    await nameIt();
    expect(step()).toBe("home");
    expect(q("#new-bot-takeover-title")?.textContent).toBe("Pick the coding tool.");
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 3 of 3");
    // "Where does it run?" is never asked again.
    expect(q('[data-testid="chat-bot-where"]')).toBeNull();
    expect(q('[data-testid="chat-bot-create"]')?.textContent).toContain("Create bot");
    expect(q('[data-testid="create-bot-hint"]')?.textContent).toContain("to create");
    expect(q('[data-testid="bot-identity-name"]')?.textContent).toBe("Dr Love");
    expect(q('[data-testid="bot-identity-meta"]')?.textContent).toBe("Local · Claude Code · acts as you");
  });

  it("opens on the coding tool with a name the host already asked for", async () => {
    open({ initialName: "Nova" });
    await settle();
    expect(step()).toBe("home");
    expect(q('[data-testid="bot-identity-name"]')?.textContent).toBe("Nova");
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 3 of 3");
  });

  it("holds the name step on a name no handle can be made from", async () => {
    open();
    await settle();
    await nameIt("!!!");
    expect(step()).toBe("name");
    expect(q('[data-testid="new-bot-name-issue"]')?.textContent).toBe(
      "That name can't be used for a bot. Try letters and numbers.",
    );
  });

  it("asks no title, avatar or model, and sends a kickoff so the bot asks for them", async () => {
    const oncreate = vi.fn(async () => undefined);
    open({ oncreate });
    await settle();
    await nameIt("Dr Love");
    expect(q('[data-testid="chat-bot-title"]')).toBeNull();
    expect(q('[data-testid="chat-bot-avatar-toggle"]')).toBeNull();
    expect(q('[data-testid="chat-bot-model"]')).toBeNull();
    click('[data-testid="chat-bot-create"]');
    await settle(10);
    expect(oncreate).toHaveBeenCalledOnce();
    const [input, extras] = oncreate.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(input).toMatchObject({ name: "dr-love", runtime: "claude", autoApprove: true });
    expect(String(input.kickoff)).toContain("job title");
    expect(String(input.kickoff)).toContain("avatar");
    expect(String(input.kickoff)).toContain("model preference");
    expect(input).not.toHaveProperty("model");
    expect(extras).toEqual({ displayName: "Dr Love" });
  });

  it("keeps the handle, who it is for, permissions and memory under Advanced, with their defaults", async () => {
    const oncreate = vi.fn(async () => undefined);
    open({ oncreate });
    await settle();
    await nameIt("Dr Love");
    const advanced = q<HTMLButtonElement>('[data-testid="chat-bot-advanced-toggle"]')!;
    expect(advanced.getAttribute("aria-expanded")).toBe("false");
    expect(q('[data-testid="chat-bot-handle"]')).toBeNull();
    advanced.click();
    await settle();
    expect(q<HTMLInputElement>('[data-testid="chat-bot-handle"]')?.value).toBe("dr-love");
    expect(q('[data-testid="chat-bot-scope-personal"]')?.getAttribute("aria-checked")).toBe("true");
    expect(q('[data-testid="chat-bot-auto-approve"]')?.getAttribute("aria-checked")).toBe("true");
    expect(q('[data-testid="chat-bot-memory-synced"]')?.getAttribute("aria-checked")).toBe("true");
    click('[data-testid="chat-bot-memory-local"]');
    click('[data-testid="chat-bot-auto-approve"]');
    await settle();
    click('[data-testid="chat-bot-create"]');
    await settle(10);
    expect((oncreate.mock.calls[0] as unknown[])[0]).toMatchObject({ autoApprove: false, memory: "local" });
  });

  it("opens Advanced by itself when the handle is taken, and creates once it is changed", async () => {
    const oncreate = vi.fn(async () => undefined);
    open({ oncreate, existingNames: ["scout"] });
    await settle();
    await nameIt("Scout");
    expect(q('[data-testid="chat-bot-advanced"]')).toBeTruthy();
    expect(q('[data-testid="create-bot-issue"]')?.textContent).toBe("You already have a bot with the handle @scout.");
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled).toBe(true);
    const handle = q<HTMLInputElement>('[data-testid="chat-bot-handle"]')!;
    handle.value = "scout-2";
    handle.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled).toBe(false);
    click('[data-testid="chat-bot-create"]');
    await settle(10);
    expect((oncreate.mock.calls[0] as unknown[])[0]).toMatchObject({ name: "scout-2" });
  });

  it("offers a template as a small link on the coding tool step, never a step", async () => {
    const oncreate = vi.fn(async () => undefined);
    open({
      oncreate,
      botWorkers: [{ id: "indigo/iris-cx", path: "companies/indigo/workers/iris-cx", description: "Answers customers." }],
    });
    await settle();
    await nameIt();
    expect(step()).toBe("home");
    expect(q('[data-testid="create-bot-kind-step"]')).toBeNull();
    const toggle = q<HTMLButtonElement>('[data-testid="create-bot-templates-toggle"]')!;
    expect(toggle.textContent).toContain("Start from a template");
    toggle.click();
    await settle();
    expect(q('[data-testid="create-bot-kind-blank"]')?.getAttribute("aria-checked")).toBe("true");
    click('[data-testid="create-bot-kind-template"]');
    await settle();
    expect(q('[data-testid="create-bot-templates"]')).toBeTruthy();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled).toBe(true);
    expect(q('[data-testid="create-bot-issue"]')?.textContent).toBe("Pick a template.");
    click('[data-testid="create-bot-template-card"]');
    await settle();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled).toBe(false);
    expect(q('[data-testid="bot-identity-meta"]')?.textContent).toContain("from ");
    click('[data-testid="chat-bot-create"]');
    await settle(10);
    expect(oncreate).toHaveBeenCalledOnce();
    expect((oncreate.mock.calls[0] as unknown[])[0]).toMatchObject({ worker: "indigo/iris-cx" });
  });

  it("has no template link when there are no company templates", async () => {
    open();
    await settle();
    await nameIt();
    expect(q('[data-testid="create-bot-templates-toggle"]')).toBeNull();
    expect(q('[data-testid="chat-bot-advanced-toggle"]')).toBeTruthy();
  });

  it("picks the coding tool with its sign-in, and holds Create until it is signed in", async () => {
    const onsignin = vi.fn(async () => undefined);
    open({ onsignin });
    await settle();
    await nameIt();
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
    await nameIt();
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
    await nameIt();
    click('[data-testid="chat-bot-create"]');
    await settle();
    // The host marks the create in flight; the button says so and holds.
    component && (await unmount(component));
    component = null;
    host.remove();
    open({ oncreate, entryBusy: "bot", initialName: "Dr Love" });
    await settle();
    expect(q('[data-testid="chat-bot-create"]')?.textContent).toContain("Creating…");
    expect(q('[data-testid="chat-bot-create"]')?.getAttribute("aria-busy")).toBe("true");
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled).toBe(true);
    key({ key: "Enter", metaKey: true });
    await settle();
    expect(oncreate).toHaveBeenCalledOnce();
    finish();
  });

  it("Enter moves on from the name, and ⌘↵ creates on the coding tool step", async () => {
    const oncreate = vi.fn(async () => undefined);
    open({ oncreate });
    await settle();
    key({ key: "Enter" }, q('[data-testid="new-bot-name"]'));
    await settle();
    expect(step()).toBe("home");
    expect(oncreate).not.toHaveBeenCalled();
    key({ key: "Enter", metaKey: true, ctrlKey: true });
    await settle(10);
    expect(oncreate).toHaveBeenCalledOnce();
  });

  it("offers Create a cloud bot instead on the coding tool step, with the name", async () => {
    const onswitchcloud = vi.fn();
    open({ onswitchcloud, initialName: "Nova" });
    await settle();
    const link = q<HTMLButtonElement>('[data-testid="create-bot-switch-cloud"]')!;
    expect(link.textContent).toBe("Create a cloud bot instead");
    expect(link.classList.contains("new-bot-takeover-local")).toBe(true);
    link.click();
    expect(onswitchcloud).toHaveBeenCalledWith("Nova");
  });

  it("Back from the coding tool hands a name the host asked for back to the host", async () => {
    const onback = vi.fn();
    open({ onback, initialName: "Nova" });
    await settle();
    click('[data-testid="create-bot-back"]');
    expect(onback).toHaveBeenCalledWith("Nova");
  });

  it("Back from the coding tool returns to the flow's own name step, then to the host, keeping the name", async () => {
    const onback = vi.fn();
    open({ onback });
    await settle();
    await nameIt("Dr Love");
    click('[data-testid="create-bot-back"]');
    await settle();
    expect(step()).toBe("name");
    expect(q<HTMLInputElement>('[data-testid="new-bot-name"]')?.value).toBe("Dr Love");
    click('[data-testid="create-bot-back"]');
    expect(onback).toHaveBeenCalledWith("Dr Love");
  });

  it("a Settings-like host (local create only) opens on the name, with no Cloud or Local choice", async () => {
    const onback = vi.fn();
    open({ initialHome: null, onCloudCreate: null, onback });
    await settle();
    expect(step()).toBe("name");
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeNull();
    expect(q('[data-testid="new-bot-choice-cloud"]')).toBeNull();
    // Name, then the coding tool: two dots.
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 1 of 2");
    // Back from the name is the host's (there is no choice to return to).
    click('[data-testid="create-bot-back"]');
    expect(onback).toHaveBeenCalledOnce();
    await nameIt();
    expect(step()).toBe("home");
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 2 of 2");
    // No cloud create to switch to.
    expect(q('[data-testid="create-bot-switch-cloud"]')).toBeNull();
  });
});

const CLOUD_QUOTE: AgentProvisionOptionsView = {
  defaultInstanceType: "t4g.medium",
  catalogVersion: "test-catalog",
  options: [
    {
      key: "basic",
      productName: "Basic",
      instanceType: "t4g.medium",
      listCents: 5000,
      default: true,
      selectable: true,
      netMonthlyCents: 4200,
      deltaCents: 4200,
      unavailableReason: null,
      notBilled: false,
      lanes: 1,
      workers: 1,
    },
    {
      key: "power",
      productName: "Power",
      instanceType: "m7i.large",
      listCents: 12000,
      default: false,
      selectable: true,
      netMonthlyCents: 10000,
      deltaCents: 10000,
      unavailableReason: null,
      notBilled: false,
      lanes: 4,
      workers: 4,
    },
  ],
};

describe("The flow's own Cloud or Local question", () => {
  function openBoth(props: Record<string, unknown> = {}) {
    open({
      initialHome: null,
      agentTargets: [{ companyUid: "cmp_indigo", label: "Indigo" }],
      onCloudCreate: vi.fn(async () => undefined),
      loadCloudProvisionOptions: async () => ok(CLOUD_QUOTE),
      ...props,
    });
  }

  it("asks the name first, then where it should live; Local leads to the coding tool and Back returns to the choice, then the name", async () => {
    openBoth();
    await settle();
    expect(step()).toBe("name");
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeNull();
    await nameIt("Nova");
    expect(step()).toBe("where");
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeTruthy();
    expect(q("#new-bot-takeover-title")?.textContent).toBe("Where should Nova live?");
    expect(q("#new-bot-takeover-title em")?.textContent).toBe("Nova");
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 2 of 3");
    expect(q<HTMLButtonElement>('[data-testid="new-bot-choice-cloud"]')!.disabled).toBe(false);
    // The tiles carry no tags: no tool is named on the Local tile.
    expect(q('[data-testid="new-bot-choice-local-tags"]')).toBeNull();
    expect(q('[data-testid="new-bot-choice-local"]')?.textContent).not.toContain("Claude Code");

    click('[data-testid="new-bot-choice-local"]');
    await settle();
    expect(step()).toBe("home");
    expect(q('[data-testid="chat-create-bot-step"]')?.getAttribute("data-home")).toBe("local");
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 3 of 3");
    expect(q('[data-testid="bot-identity-name"]')?.textContent).toBe("Nova");
    // The flow asked, and cloud is available: the coding tool step offers the switch.
    expect(q('[data-testid="create-bot-switch-cloud"]')).toBeTruthy();

    click('[data-testid="create-bot-back"]');
    await settle();
    expect(step()).toBe("where");
    expect(q('[data-testid="new-bot-choice-local"]')).toBeTruthy();
    expect(q('[data-testid="new-bot-choice-cloud"]')).toBeTruthy();
    click('[data-testid="create-bot-back"]');
    await settle();
    expect(step()).toBe("name");
    expect(q<HTMLInputElement>('[data-testid="new-bot-name"]')?.value).toBe("Nova");
  });

  it("Cloud reaches the name and size step and creates through onCloudCreate with the quoted size", async () => {
    const onCloudCreate = vi.fn(async () => undefined);
    const oncreate = vi.fn(async () => undefined);
    openBoth({ onCloudCreate, oncreate });
    await settle();
    await nameIt("Polar");
    click('[data-testid="new-bot-choice-cloud"]');
    await settle(10);
    expect(step()).toBe("details");
    expect(q('[data-testid="chat-create-bot-step"]')?.getAttribute("data-home")).toBe("cloud");
    // One company: no company step, and no kind/template step for cloud.
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 3 of 3");
    expect(q('[data-testid="create-bot-cloud-details-step"]')).toBeTruthy();
    expect(q('[data-testid="cloud-bot-size-choice"]')).toBeTruthy();
    // The name from step 1 is carried in, and the identity line names it.
    expect(q<HTMLInputElement>('[data-testid="chat-bot-name"]')?.value).toBe("Polar");
    expect(q('[data-testid="bot-identity-meta"]')?.textContent).toBe("Cloud · Indigo");
    const power = q<HTMLInputElement>('[data-testid="cloud-bot-size-power"]')!;
    power.click();
    await settle();

    const create = q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!;
    expect(create.textContent).toContain("Create in Indigo");
    expect(create.disabled).toBe(false);
    create.click();
    await settle(10);
    expect(oncreate).not.toHaveBeenCalled();
    expect(onCloudCreate).toHaveBeenCalledOnce();
    const [companyUid, draft] = onCloudCreate.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(companyUid).toBe("cmp_indigo");
    expect(draft).toMatchObject({ name: "Polar", handle: "polar", size: "power" });

    // Back from the only cloud step returns to the choice.
    click('[data-testid="create-bot-back"]');
    await settle();
    expect(step()).toBe("where");
  });
});
