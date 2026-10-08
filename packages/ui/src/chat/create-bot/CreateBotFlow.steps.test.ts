// @vitest-environment happy-dom

/**
 * Owner (2026-10-07): the bot's name is step 1 on every New bot path, then
 * "Where should <Name> live?", then the home's steps. A local bot's one
 * required step is the coding tool, defaulting to the signed-in one. Who it
 * is for, a template and the fine-tuning (handle, permissions, memory) are
 * optional steps after it, one per screen, each with "Next: <step>" and
 * "Finish with defaults". The bot asks for its title, avatar and model in its
 * first message (a kickoff). Every capability the create screens keep is
 * still reachable on them (policy
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

/** "Next: ..." until the given step is on screen. */
async function toStep(target: string): Promise<void> {
  for (let i = 0; i < 6 && step() !== target; i += 1) {
    click('[data-testid="create-bot-next"]');
    await settle();
  }
  expect(step()).toBe(target);
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
    // The host asked "Where should it live?": name, where, coding tool, then
    // who it's for and fine-tune (no templates here).
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 1 of 5");
    expect(q('[data-testid="new-bot-progress"]')?.querySelectorAll("span").length).toBe(5);
    expect(q('[data-testid="create-bot-back"]')?.textContent).toContain("Back");
    expect(q('[data-testid="new-bot-continue-name"]')?.textContent).toContain("Continue");
    expect(q('[data-testid="new-bot-continue-name"]')?.classList.contains("new-bot-create-submit")).toBe(true);
    // No identity line on the name step: the field is the identity.
    expect(q('[data-testid="bot-identity-line"]')).toBeNull();

    await nameIt();
    expect(step()).toBe("home");
    expect(q("#new-bot-takeover-title")?.textContent).toBe("Which tool should Dr Love think with?");
    expect(q("#new-bot-takeover-title em")?.textContent).toBe("Dr Love");
    expect(q(".new-bot-create-copy")?.textContent).toBe("It uses your own plan for the tool you pick.");
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 3 of 5");
    // "Where does it run?" is never asked again.
    expect(q('[data-testid="chat-bot-where"]')).toBeNull();
    // Three equal tool cards, each with a short status, and nothing else.
    const cards = Array.from(host.querySelectorAll('[data-testid="create-bot-runtime-cards"] [role="radio"]'));
    expect(cards.map((c) => c.querySelector(".new-bot-option-title")?.textContent)).toEqual(["Claude Code", "Codex", "Grok"]);
    expect(q('[data-testid="chat-bot-runtime-claude-status"]')?.textContent).toBe("Signed in");
    expect(q('[data-testid="chat-bot-runtime-codex-status"]')?.textContent).toBe("Sign in first");
    for (const gone of ["chat-bot-handle", "chat-bot-scope", "create-bot-templates-toggle", "chat-bot-advanced-toggle", "chat-bot-where-external", "create-bot-switch-cloud", "create-bot-hint", "new-bot-create-scroll"]) {
      expect(q(`[data-testid="${gone}"]`), gone).toBeNull();
    }
    expect(q('[data-testid="create-bot-next"]')?.textContent?.trim()).toBe("Next: Who it's for");
    expect(q('[data-testid="chat-bot-create"]')?.textContent?.trim()).toBe("Finish with defaults");
    expect(q('[data-testid="bot-identity-name"]')?.textContent).toBe("Dr Love");
    expect(q('[data-testid="bot-identity-meta"]')?.textContent).toBe("Local · Claude Code · acts as you");
  });

  it("opens on the coding tool with a name the host already asked for", async () => {
    open({ initialName: "Nova" });
    await settle();
    expect(step()).toBe("home");
    expect(q('[data-testid="bot-identity-name"]')?.textContent).toBe("Nova");
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 3 of 5");
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

  it("keeps the handle, permissions and memory on Fine-tune, with their defaults", async () => {
    const oncreate = vi.fn(async () => undefined);
    open({ oncreate });
    await settle();
    await nameIt("Dr Love");
    expect(q('[data-testid="chat-bot-handle"]')).toBeNull();
    await toStep("scope");
    expect(q('[data-testid="chat-bot-scope-personal"]')?.getAttribute("aria-checked")).toBe("true");
    await toStep("tune");
    expect(q("#new-bot-takeover-title")?.textContent).toBe("Fine-tune Dr Love.");
    expect(q<HTMLInputElement>('[data-testid="chat-bot-handle"]')?.value).toBe("dr-love");
    expect(q('[data-testid="chat-bot-auto-approve"]')?.getAttribute("aria-checked")).toBe("true");
    expect(q('[data-testid="chat-bot-memory-synced"]')?.getAttribute("aria-checked")).toBe("true");
    // The last step: only "Create <Name>".
    expect(q('[data-testid="create-bot-next"]')).toBeNull();
    expect(q('[data-testid="chat-bot-create"]')?.textContent?.trim()).toBe("Create Dr Love");
    click('[data-testid="chat-bot-memory-local"]');
    click('[data-testid="chat-bot-auto-approve"]');
    await settle();
    click('[data-testid="chat-bot-create"]');
    await settle(10);
    expect((oncreate.mock.calls[0] as unknown[])[0]).toMatchObject({ autoApprove: false, memory: "local" });
  });
  it("Finish with defaults gives a taken handle the next free number, without stopping", async () => {
    const oncreate = vi.fn(async () => undefined);
    open({ oncreate, existingNames: ["scout"] });
    await settle();
    await nameIt("Scout");
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled).toBe(false);
    click('[data-testid="chat-bot-create"]');
    await settle(10);
    expect((oncreate.mock.calls[0] as unknown[])[0]).toMatchObject({ name: "scout-2" });
  });
  it("offers templates on their own Start from step, Blank first", async () => {
    const oncreate = vi.fn(async () => undefined);
    open({
      oncreate,
      botWorkers: [{ id: "indigo/iris-cx", path: "companies/indigo/workers/iris-cx", description: "Answers customers." }],
    });
    await settle();
    await nameIt();
    expect(step()).toBe("home");
    expect(q('[data-testid="create-bot-templates"]')).toBeNull();
    await toStep("scope");
    expect(q('[data-testid="create-bot-next"]')?.textContent?.trim()).toBe("Next: Start from");
    await toStep("template");
    expect(q("#new-bot-takeover-title")?.textContent).toBe("Where should Dr Love start?");
    expect(q('[data-testid="create-bot-kind-blank"]')?.getAttribute("aria-checked")).toBe("true");
    click('[data-testid="create-bot-template-card"]');
    await settle();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled).toBe(false);
    expect(q('[data-testid="bot-identity-meta"]')?.textContent).toContain("from ");
    click('[data-testid="chat-bot-create"]');
    await settle(10);
    expect(oncreate).toHaveBeenCalledOnce();
    expect((oncreate.mock.calls[0] as unknown[])[0]).toMatchObject({ worker: "indigo/iris-cx" });
  });
  it("skips Start from when there are no company templates", async () => {
    open();
    await settle();
    await nameIt();
    await toStep("scope");
    expect(q('[data-testid="create-bot-next"]')?.textContent?.trim()).toBe("Next: Fine-tune");
    await toStep("tune");
    expect(q('[data-testid="create-bot-templates"]')).toBeNull();
  });
  it("picks the coding tool with its sign-in, and holds Next and Finish until it is signed in", async () => {
    const onsignin = vi.fn(async () => undefined);
    open({ onsignin });
    await settle();
    await nameIt();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled).toBe(false);
    click('[data-testid="chat-bot-runtime-codex"]');
    await settle();
    expect(q('[data-testid="chat-bot-runtime-codex"]')?.getAttribute("aria-checked")).toBe("true");
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled).toBe(true);
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')!.disabled).toBe(true);
    // One short line under the cards says why, with the sign-in right there.
    expect(q('[data-testid="chat-bot-runtime-help"]')?.textContent).toContain("Codex");
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

  it("Enter moves on from the name, and finishes on the coding tool step", async () => {
    const oncreate = vi.fn(async () => undefined);
    open({ oncreate });
    await settle();
    key({ key: "Enter" }, q('[data-testid="new-bot-name"]'));
    await settle();
    expect(step()).toBe("home");
    expect(oncreate).not.toHaveBeenCalled();
    key({ key: "Enter" });
    await settle(10);
    expect(oncreate).toHaveBeenCalledOnce();
  });
  it("has no Create a cloud bot instead link on the local steps: Back covers it", async () => {
    open({ initialName: "Nova" });
    await settle();
    expect(q('[data-testid="create-bot-switch-cloud"]')).toBeNull();
    expect(host.textContent).not.toContain("Create a cloud bot instead");
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
    // Name, then the coding tool, who it's for and fine-tune.
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 1 of 4");
    // Back from the name is the host's (there is no choice to return to).
    click('[data-testid="create-bot-back"]');
    expect(onback).toHaveBeenCalledOnce();
    await nameIt();
    expect(step()).toBe("home");
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 2 of 4");
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
    // The bars count the draft's home until one is picked: Local here.
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 2 of 5");
    expect(q<HTMLButtonElement>('[data-testid="new-bot-choice-cloud"]')!.disabled).toBe(false);
    // The tiles carry no tags: no tool is named on the Local tile.
    expect(q('[data-testid="new-bot-choice-local-tags"]')).toBeNull();
    expect(q('[data-testid="new-bot-choice-local"]')?.textContent).not.toContain("Claude Code");

    click('[data-testid="new-bot-choice-local"]');
    await settle();
    expect(step()).toBe("home");
    expect(q('[data-testid="chat-create-bot-step"]')?.getAttribute("data-home")).toBe("local");
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 3 of 5");
    expect(q('[data-testid="bot-identity-name"]')?.textContent).toBe("Nova");
    // Back is the way to Cloud: there is no switch link on the local steps.
    expect(q('[data-testid="create-bot-switch-cloud"]')).toBeNull();

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

  it("offers Connect it under the tiles for a bot that runs somewhere else, on its own screen", async () => {
    openBoth();
    await settle();
    await nameIt("Nova");
    const line = q('[data-testid="new-bot-connect-external-line"]');
    expect(line?.textContent?.replace(/\s+/g, " ").trim()).toBe("Already have a bot running somewhere else? Connect it");
    click('[data-testid="new-bot-connect-external"]');
    await settle();
    expect(step()).toBe("external");
    expect(q('[data-testid="new-bot-external-step"]')).toBeTruthy();
    expect(q('[data-testid="chat-bot-where-external"]')?.textContent).toContain("hq agent enroll");
    expect(q('[data-testid="chat-bot-external-enroll-mask"]')?.textContent).toBe("••••-••••");
    // The paid-plan note lives in this flow, not on the Where step.
    expect(q('[data-testid="chat-bot-external-paid"]')?.textContent).toContain("paid plans");
    click('[data-testid="create-bot-back"]');
    await settle();
    expect(step()).toBe("where");
    expect(q('[data-testid="chat-bot-external-paid"]')).toBeNull();
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
    // The only cloud step is the last: one button, "Create <Name>".
    expect(q('[data-testid="create-bot-next"]')).toBeNull();
    expect(create.textContent?.trim()).toBe("Create Polar");
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
