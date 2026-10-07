// @vitest-environment happy-dom

/**
 * The New bot flow end to end, without a host: the name first, then Cloud
 * or Local when the host offers both, then the coding tool for a Local bot
 * (a template and the advanced settings folded away on it), or company
 * (when there is a choice) → name, brain and size for a Cloud one. The flow
 * owns the draft and the keyboard; the host only runs the create. A Local
 * bot's title, avatar and model are asked by the bot itself (a kickoff).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { failure, ok, type AgentProvisionOptionsView, type LocalBotWorkerOption } from "@hq/platform";

import type { CloudBotDraft } from "../lifecycle-entry-points.js";
import CreateBotFlow from "./CreateBotFlow.svelte";
import { newBotKickoff } from "./create-bot-model.js";

// These flows press ⌘↵: run them as the Mac host the app ships on, so the
// platform's own create chord (OWNER-D 8) is Command, not Control.
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15";
const priorUserAgent = navigator.userAgent;
beforeAll(() => Object.defineProperty(navigator, "userAgent", { configurable: true, value: MAC_UA }));
afterAll(() => Object.defineProperty(navigator, "userAgent", { configurable: true, value: priorUserAgent }));


const WORKERS: LocalBotWorkerOption[] = [
  {
    id: "iris-cx",
    path: "companies/indigo/workers/iris-cx",
    company: "indigo",
    description: "Answers customer questions. Escalates the hard ones to a human.",
    skillCount: 3,
  },
  {
    id: "note-taker",
    path: "companies/acme/workers/note-taker",
    company: "acme",
    name: "Note Taker",
    summary: "Turns meetings into decisions.",
    skillCount: 1,
  },
  {
    id: "setup",
    path: "core/workers/setup",
    name: "Setup",
    summary: "Walks you through HQ on day one.",
    skillCount: 1,
    source: "core",
  },
];

const COMPANIES = [
  { companyUid: "cmp_indigo", label: "Indigo" },
  { companyUid: "cmp_acme", label: "Acme" },
];

const OWNER_COMPANIES = [
  { slug: "indigo", label: "Indigo" },
  { slug: "acme", label: "Acme" },
];

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
    {
      key: "dev",
      productName: "Dev",
      instanceType: "c7i.large",
      listCents: 18000,
      default: false,
      selectable: false,
      netMonthlyCents: 15000,
      deltaCents: 15000,
      unavailableReason: "owner-required",
      notBilled: false,
      lanes: 8,
      workers: 8,
    },
  ],
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function settle(times = 4): Promise<void> {
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

/** Type into a text input the way a person does. */
function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** ⌘↵ on the flow container, the way the modal delivers it. */
function cmdEnter(): void {
  q('[data-testid="chat-create-bot-step"]')!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
  );
}

function render(props: Record<string, unknown> = {}): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CreateBotFlow, {
    target: host,
    props: {
      botRuntimeReady: { claude: true, codex: false, grok: false },
      botWorkers: WORKERS,
      existingNames: [],
      botCompanies: OWNER_COMPANIES,
      loadClaudeProviderFlag: async () => ok(true),
      loadCloudProvisionOptions: async () => ok(CLOUD_QUOTE),
      ...props,
    },
  });
}

/** The CLI input a Local create sends: the draft's fields plus the kickoff. */
function localInput(input: Record<string, unknown>): Record<string, unknown> {
  return { ...input, kickoff: newBotKickoff({ template: typeof input.worker === "string" }) };
}

/** Continue from the name step (the suggested name, unless one was typed). */
async function continueName(): Promise<void> {
  click('[data-testid="new-bot-continue-name"]');
  await settle();
}

/** Name → coding tool: the only local step after the name, where Create lives. */
async function toCodingTool(): Promise<void> {
  await continueName();
}

/** Open Advanced on the coding tool step (handle, who it is for, permissions, memory). */
async function openAdvanced(): Promise<void> {
  const toggle = q<HTMLButtonElement>('[data-testid="chat-bot-advanced-toggle"]')!;
  if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
  await settle();
}

/** Open "Start from a template" on the coding tool step. */
async function openTemplates(): Promise<void> {
  const toggle = q<HTMLButtonElement>('[data-testid="create-bot-templates-toggle"]')!;
  if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
  await settle();
}

/**
 * The name, then the flow's own Cloud or Local question (the host passed
 * both creates and no home), then Cloud: with two companies that is the
 * company step.
 */
async function toCloud(): Promise<void> {
  expect(q('[data-testid="chat-create-bot-step"]')?.dataset.step).toBe("name");
  await continueName();
  expect(q('[data-testid="chat-create-bot-step"]')?.dataset.step).toBe("where");
  click('[data-testid="new-bot-choice-cloud"]');
  await settle();
}

/** Cloud → company → name, brain and size. */
async function toCloudDetails(): Promise<void> {
  await toCloud();
  click('[data-testid="create-bot-next"]');
  await settle();
}

function stepName(): string | undefined {
  return q('[data-testid="chat-create-bot-step"]')?.dataset.step;
}

describe("CreateBotFlow", () => {
  it("walks name → coding tool and back again", async () => {
    const oncreate = vi.fn(async () => undefined);
    const onback = vi.fn();
    render({ oncreate, onback });
    await settle();

    expect(q('[data-testid="new-bot-name"]')).toBeTruthy();
    expect(stepName()).toBe("name");
    expect(q('[data-testid="chat-create-bot-step"]')?.dataset.home).toBe("local");
    // Back on the first step leaves the flow, with the name as it stands.
    click('[data-testid="create-bot-back"]');
    expect(onback).toHaveBeenCalledWith("assistant");

    await continueName();
    expect(q('[data-testid="create-bot-runtime-section"]')).toBeTruthy();
    // Local is the default when the host can run bots, with a signed-in runtime.
    expect(q('[data-testid="chat-bot-runtime-claude"]')?.getAttribute("aria-checked")).toBe("true");
    // The last step creates rather than advances.
    expect(q('[data-testid="create-bot-next"]')).toBeNull();
    expect(q('[data-testid="chat-bot-create"]')?.textContent).toContain("Create bot");
    // Templates are a link on this step, not a step of their own.
    expect(q('[data-testid="create-bot-kind-step"]')).toBeNull();

    click('[data-testid="create-bot-back"]');
    await settle();
    expect(q('[data-testid="new-bot-name"]')).toBeTruthy();
  });

  it("picking Blank after a template drops the template", async () => {
    render({ oncreate: vi.fn() });
    await settle();
    await toCodingTool();
    await openTemplates();
    click('[data-testid="create-bot-kind-template"]');
    await settle();
    expect(q('[data-testid="create-bot-templates"]')).toBeTruthy();
    click('[data-testid="create-bot-kind-blank"]');
    await settle();
    expect(q('[data-testid="create-bot-kind-step"]')).toBeTruthy();
    expect(q('[data-testid="create-bot-templates"]')).toBeNull();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')?.disabled).toBe(false);
    expect(q('[data-testid="bot-identity-meta"]')?.textContent).not.toContain("from ");
  });

  it("offers Blank and From a template, and no template link without company workers", async () => {
    render({ oncreate: vi.fn() });
    await settle();
    await toCodingTool();
    await openTemplates();
    const kinds = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-testid="create-bot-kinds"] [data-kind]'));
    expect(kinds.map((k) => k.dataset.kind)).toEqual(["blank", "template"]);
    expect(q('[data-testid="create-bot-kind-clone"]')).toBeNull();
    await unmount(component!);
    component = null;
    host.remove();

    render({ oncreate: vi.fn(), botWorkers: WORKERS.filter((w) => w.id === "setup") });
    await settle();
    await toCodingTool();
    expect(q('[data-testid="create-bot-templates-toggle"]')).toBeNull();
  });

  it("a template card fills the draft and rides along to the CLI input", async () => {
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate });
    await settle();
    await toCodingTool();
    await openTemplates();

    click('[data-testid="create-bot-kind-template"]');
    await settle();
    const cards = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-testid="create-bot-template-card"]'));
    expect(cards.map((c) => c.dataset.template)).toEqual(["note-taker", "iris-cx"]);
    // Curated summary, skill count, and the company group are all on the card.
    expect(cards[0]!.textContent).toContain("Turns meetings into decisions.");
    expect(cards[0]!.textContent).toContain("1 skill");
    // No `summary:` → the first sentence of the description.
    expect(cards[1]!.textContent).toContain("Answers customer questions.");
    expect(cards[1]!.textContent).not.toContain("Escalates");
    expect(cards[1]!.textContent).toContain("3 skills");
    const groups = Array.from(host.querySelectorAll('[data-testid="create-bot-templates"] .cb-group-title'));
    // Company workers only: the core setup worker is never offered.
    expect(groups.map((g) => g.textContent)).toEqual(["Acme", "Indigo"]);

    // Until a card is picked, Create is held.
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')?.disabled).toBe(true);
    expect(q('[data-testid="create-bot-issue"]')?.textContent).toContain("Pick a template.");

    cards[1]!.click();
    await settle();
    expect(cards[1]!.getAttribute("aria-selected")).toBe("true");
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')?.disabled).toBe(false);
    // The identity line names the template, and the link says which one.
    expect(q('[data-testid="bot-identity-meta"]')?.textContent).toContain("from ");
    expect(q('[data-testid="create-bot-templates-toggle"]')?.textContent).toContain("From Iris Cx");
    // What the template brings shows where it is picked.
    expect(q('[data-testid="chat-bot-template-brings"]')?.textContent).toContain("3 skills");

    click('[data-testid="chat-bot-create"]');
    await settle();
    // A company template defaults to a company bot for that company.
    expect(oncreate).toHaveBeenCalledWith(
      localInput({ name: "assistant", runtime: "claude", autoApprove: true, worker: "iris-cx", kind: "company", companies: ["indigo"] }),
      {},
    );
  });

  it("asks who the bot is for under Advanced: personal by default, company needs at least one company (bot-kinds)", async () => {
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate });
    await settle();
    await toCodingTool();
    await openAdvanced();
    expect(q('[data-testid="chat-bot-scope-personal"]')?.getAttribute("aria-checked")).toBe("true");
    expect(q('[data-testid="chat-bot-scope-personal"]')?.textContent).toContain("acts as you");
    expect(q('[data-testid="chat-bot-scope-companies"]')).toBeNull();

    click('[data-testid="chat-bot-scope-company"]');
    await settle();
    expect(q('[data-testid="chat-bot-scope-company"]')?.getAttribute("aria-checked")).toBe("true");
    // Company kind without a company cannot create.
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')?.disabled).toBe(true);
    expect(q('[data-testid="create-bot-issue"]')?.textContent).toContain("Pick at least one company.");
    cmdEnter();
    await settle();
    expect(oncreate).not.toHaveBeenCalled();
    expect(stepName()).toBe("home");

    click('[data-testid="chat-bot-scope-company-indigo"]');
    click('[data-testid="chat-bot-scope-company-acme"]');
    await settle();
    expect(q('[data-testid="chat-bot-scope-company-acme"]')?.getAttribute("aria-checked")).toBe("true");
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')?.disabled).toBe(false);
    // Unpicking one keeps the other.
    click('[data-testid="chat-bot-scope-company-indigo"]');
    await settle();
    expect(q('[data-testid="chat-bot-scope-company-indigo"]')?.getAttribute("aria-checked")).toBe("false");

    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(oncreate).toHaveBeenCalledWith(
      localInput({ name: "assistant", runtime: "claude", autoApprove: true, kind: "company", companies: ["acme"] }),
      {},
    );
  });

  it("answering Personal sticks, even after picking a company template", async () => {
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate });
    await settle();
    await toCodingTool();
    await openAdvanced();
    // Answer the question explicitly (Personal is already selected; click it anyway).
    click('[data-testid="chat-bot-scope-personal"]');
    await settle();
    await openTemplates();
    click('[data-testid="create-bot-kind-template"]');
    await settle();
    host.querySelector<HTMLButtonElement>('[data-testid="create-bot-template-card"][data-template="iris-cx"]')!.click();
    await settle();
    expect(q('[data-testid="chat-bot-scope-personal"]')?.getAttribute("aria-checked")).toBe("true");
    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(oncreate).toHaveBeenCalledWith(localInput({ name: "assistant", runtime: "claude", autoApprove: true, worker: "iris-cx" }), {});
  });

  it("with no company to join, the company choice explains and personal still creates", async () => {
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate, botCompanies: [] });
    await settle();
    await toCodingTool();
    await openAdvanced();
    click('[data-testid="chat-bot-scope-company"]');
    await settle();
    expect(q('[data-testid="chat-bot-scope-help"]')?.textContent).toContain("not in a company yet");
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')?.disabled).toBe(true);
    cmdEnter();
    await settle();
    expect(oncreate).not.toHaveBeenCalled();
    click('[data-testid="chat-bot-scope-personal"]');
    await settle();
    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(oncreate).toHaveBeenCalledWith(localInput({ name: "assistant", runtime: "claude", autoApprove: true }), {});
  });

  it("searching the library filters the cards", async () => {
    render({ oncreate: vi.fn() });
    await settle();
    await toCodingTool();
    await openTemplates();
    click('[data-testid="create-bot-kind-template"]');
    await settle();
    const search = q<HTMLInputElement>('[data-testid="create-bot-template-search"]')!;
    search.value = "meetings";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(
      Array.from(host.querySelectorAll<HTMLButtonElement>('[data-testid="create-bot-template-card"]')).map(
        (c) => c.dataset.template,
      ),
    ).toEqual(["note-taker"]);

    search.value = "nothing here";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(q('[data-testid="create-bot-templates-empty"]')).toBeTruthy();
  });

  it("⌘↵ creates on the coding tool step, but only once everything on it is valid", async () => {
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate });
    await settle();
    await toCodingTool();
    await openTemplates();

    // Template chosen, no card picked yet → the draft is incomplete.
    click('[data-testid="create-bot-kind-template"]');
    await settle();
    cmdEnter();
    await settle();
    expect(oncreate).not.toHaveBeenCalled();
    expect(stepName()).toBe("home");

    click('[data-testid="create-bot-template-card"]');
    await settle();
    cmdEnter();
    await settle();
    // A company template (Acme's note-taker) defaults to a company bot for Acme.
    expect(oncreate).toHaveBeenCalledWith(
      localInput({ name: "assistant", runtime: "claude", autoApprove: true, worker: "note-taker", kind: "company", companies: ["acme"] }),
      {},
    );
  });

  it("⌘↵ on the name moves on to the coding tool instead of creating", async () => {
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate });
    await settle();
    expect(stepName()).toBe("name");
    q('[data-testid="new-bot-name"]')!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
    );
    await settle();
    expect(oncreate).not.toHaveBeenCalled();
    expect(stepName()).toBe("home");
    cmdEnter();
    await settle();
    expect(oncreate).toHaveBeenCalledWith(localInput({ name: "assistant", runtime: "claude", autoApprove: true }), {});
  });

  it("⌘↵ is blocked while the chosen runtime is not signed in", async () => {
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate, botRuntimeReady: { claude: false, codex: false, grok: false } });
    await settle();
    await toCodingTool();
    cmdEnter();
    await settle();
    expect(oncreate).not.toHaveBeenCalled();
    // The flow parks the user on the step that still needs them.
    expect(q('[data-testid="create-bot-runtime-section"]')).toBeTruthy();
    expect(q('[data-testid="create-bot-issue"]')?.textContent).toContain("not signed in");
  });

  it("Cloud names the bot before it is created and hands both to the host", async () => {
    const onCloudCreate = vi.fn(async () => undefined);
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate, onCloudCreate, agentTargets: COMPANIES });
    await settle();

    await toCloud();
    // Two companies: the first cloud step picks one.
    expect(stepName()).toBe("home");
    const options = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[data-testid="chat-create-agent-company"]'),
    );
    expect(options.map((o) => o.dataset.company)).toEqual(["cmp_indigo", "cmp_acme"]);
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["true", "false"]);

    options[1]!.click();
    await settle();
    // A Cloud bot has a details step too: the card in the company channel
    // that used to ask for its name and handle is no longer shown to anyone,
    // so this is the only place they are chosen.
    click('[data-testid="create-bot-next"]');
    await settle();
    const name = q<HTMLInputElement>('[data-testid="chat-bot-name"]')!;
    const handle = q<HTMLInputElement>('[data-testid="chat-bot-handle"]')!;
    expect(name.value).toMatch(/\S/);
    // The suggestion is a prefill the person can see and replace.
    type(name, "Polar Bear");
    await settle();
    expect(handle.value).toBe("polar-bear");
    type(handle, "ice");
    await settle();

    expect(q('[data-testid="chat-bot-create"]')?.textContent).toContain("Create in Acme");
    click('[data-testid="chat-bot-create"]');
    await settle();
    // Exactly what the person typed — never an auto-suggestion they never saw.
    expect(onCloudCreate).toHaveBeenCalledWith("cmp_acme", {
      name: "Polar Bear",
      handle: "ice",
      runtime: "claude",
      size: "basic",
    });
    expect(oncreate).not.toHaveBeenCalled();
  });

  it("⌘↵ on a Cloud draft moves to the details step instead of creating", async () => {
    const onCloudCreate = vi.fn(async () => undefined);
    render({ oncreate: vi.fn(), onCloudCreate, agentTargets: COMPANIES });
    await settle();
    await toCloud();
    expect(stepName()).toBe("home");

    // A company bot is named on the details step, so the shortcut takes the
    // person there rather than creating one they never named.
    cmdEnter();
    await settle();
    expect(onCloudCreate).not.toHaveBeenCalled();
    expect(q('[data-testid="create-bot-cloud-details-step"]')).toBeTruthy();

    // Same again after walking back: forward one step at a time, never past details.
    click('[data-testid="create-bot-back"]');
    await settle();
    expect(stepName()).toBe("home");
    cmdEnter();
    await settle();
    expect(onCloudCreate).not.toHaveBeenCalled();
    expect(q('[data-testid="create-bot-cloud-details-step"]')).toBeTruthy();

    // From the details step it creates — with the name now on screen.
    const name = q<HTMLInputElement>('[data-testid="chat-bot-name"]')!;
    type(name, "Polar Bear");
    await settle();
    cmdEnter();
    await settle();
    expect(onCloudCreate).toHaveBeenCalledWith("cmp_indigo", {
      name: "Polar Bear",
      handle: "polar-bear",
      runtime: "claude",
      size: "basic",
    });
  });

  it("Cloud asks for a title too and hands it to the host", async () => {
    const onCloudCreate = vi.fn(async () => undefined);
    render({ oncreate: vi.fn(), onCloudCreate, agentTargets: COMPANIES });
    await settle();
    await toCloudDetails();

    // A Cloud bot's title is still asked here; a Local bot asks for its own.
    expect(q('[data-testid="chat-bot-title"]')).toBeTruthy();
    type(q<HTMLInputElement>('[data-testid="chat-bot-name"]')!, "Polar");
    await settle();
    type(q<HTMLInputElement>('[data-testid="chat-bot-title"]')!, "Ad account analyst");
    await settle();
    expect(q<HTMLInputElement>('[data-testid="chat-bot-title"]')?.value).toBe("Ad account analyst");

    click('[data-testid="chat-bot-create"]');
    await settle();
    // No turn of the server's create_agent sequence asks for a title, so it
    // travels beside the name and handle for the host to save afterwards.
    expect(onCloudCreate).toHaveBeenCalledWith("cmp_indigo", {
      name: "Polar",
      handle: "polar",
      runtime: "claude",
      size: "basic",
      title: "Ad account analyst",
    });
  });

  it("shows Claude only when the signed-in user flag is enabled and shows the tenant quote", async () => {
    render({
      oncreate: vi.fn(),
      onCloudCreate: vi.fn(),
      agentTargets: COMPANIES,
      loadClaudeProviderFlag: async () => ok(true),
    });
    await settle();
    await toCloudDetails();
    expect(q('[data-testid="cloud-bot-runtime-claude"]')).toBeTruthy();
    expect(q('[data-testid="cloud-bot-size-basic-price"]')?.textContent).toBe("$50.00/month");
    expect(q('[data-testid="cloud-bot-size-basic-company-price"]')?.textContent).toBe("Your company pays $42.00/month");
    expect(q('[data-testid="cloud-bot-size-dev"]')?.hasAttribute("disabled")).toBe(true);
  });

  it("shows each size's own list price, and the company price only when it differs", async () => {
    const quote: AgentProvisionOptionsView = {
      ...CLOUD_QUOTE,
      options: [
        { ...CLOUD_QUOTE.options[0], listCents: 10000, netMonthlyCents: 10000, deltaCents: 10000 },
        { ...CLOUD_QUOTE.options[1], listCents: 25000, netMonthlyCents: 10000, deltaCents: 10000 },
        { ...CLOUD_QUOTE.options[2], listCents: 50000, netMonthlyCents: 0, deltaCents: 0, notBilled: true },
      ],
    };
    render({
      oncreate: vi.fn(),
      onCloudCreate: vi.fn(),
      agentTargets: COMPANIES,
      loadCloudProvisionOptions: async () => ok(quote),
    });
    await settle();
    await toCloudDetails();

    expect(q('[data-testid="cloud-bot-size-basic-price"]')?.textContent).toBe("$100.00/month");
    expect(q('[data-testid="cloud-bot-size-power-price"]')?.textContent).toBe("$250.00/month");
    expect(q('[data-testid="cloud-bot-size-dev-price"]')?.textContent).toBe("$500.00/month");
    expect(q('[data-testid="cloud-bot-size-basic-company-price"]')).toBeNull();
    expect(q('[data-testid="cloud-bot-size-power-company-price"]')?.textContent).toBe("Your company pays $100.00/month");
    expect(q('[data-testid="cloud-bot-size-dev-company-price"]')?.textContent).toBe("Included for your company");
  });

  it("loads the tenant quote once per company, not for each Cloud draft edit", async () => {
    const loadCloudProvisionOptions = vi.fn(async (_companyUid: string) => ok(CLOUD_QUOTE));
    render({
      oncreate: vi.fn(),
      onCloudCreate: vi.fn(),
      agentTargets: COMPANIES,
      loadCloudProvisionOptions,
    });
    await settle();
    await toCloudDetails();

    expect(loadCloudProvisionOptions).toHaveBeenCalledTimes(1);
    expect(loadCloudProvisionOptions).toHaveBeenLastCalledWith("cmp_indigo");

    type(q<HTMLInputElement>('[data-testid="chat-bot-name"]')!, "Polar Bear");
    await settle();
    type(q<HTMLInputElement>('[data-testid="chat-bot-title"]')!, "Designer");
    await settle();
    q<HTMLInputElement>('[data-testid="cloud-bot-runtime-grok"]')!.click();
    await settle();
    q<HTMLInputElement>('[data-testid="cloud-bot-size-power"]')!.click();
    await settle();

    expect(loadCloudProvisionOptions).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="cloud-bot-size-power-price"]')?.textContent).toBe("$120.00/month");

    click('[data-testid="create-bot-back"]');
    await settle();
    const acme = host.querySelector<HTMLButtonElement>(
      '[data-testid="chat-create-agent-company"][data-company="cmp_acme"]',
    );
    if (!acme) throw new Error("missing Acme company option");
    acme.click();
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();

    expect(loadCloudProvisionOptions).toHaveBeenCalledTimes(2);
    expect(loadCloudProvisionOptions.mock.calls.map(([companyUid]) => companyUid)).toEqual([
      "cmp_indigo",
      "cmp_acme",
    ]);
  });

  it("keeps Claude hidden and refuses creation when the flag is false", async () => {
    const onCloudCreate = vi.fn(async () => undefined);
    render({
      oncreate: vi.fn(),
      onCloudCreate,
      agentTargets: COMPANIES,
      loadClaudeProviderFlag: async () => ok(false),
    });
    await settle();
    await toCloudDetails();
    expect(q('[data-testid="cloud-bot-runtime-claude"]')).toBeNull();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')?.disabled).toBe(false);
    // Codex remains available; the hidden Claude selection is never submitted.
    expect(q<HTMLInputElement>('[data-testid="cloud-bot-runtime-codex"]')?.checked).toBe(true);
  });

  it("passes the chosen runtime and quote size to create, with no auth mode or API key", async () => {
    const onCloudCreate = vi.fn(async () => undefined);
    render({ oncreate: vi.fn(), onCloudCreate, agentTargets: COMPANIES });
    await settle();
    await toCloudDetails();
    q<HTMLInputElement>('[data-testid="cloud-bot-runtime-grok"]')!.click();
    await settle();
    type(q<HTMLInputElement>('[data-testid="chat-bot-name"]')!, "Polar");
    await settle();
    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(onCloudCreate).toHaveBeenCalledWith("cmp_indigo", {
      name: "Polar",
      handle: "polar",
      runtime: "grok",
      size: "basic",
    });
  });

  it("does not offer an API key option for Cloud bots", async () => {
    const onCloudCreate = vi.fn(async (_companyUid: string, _draft: CloudBotDraft) => undefined);
    render({ oncreate: vi.fn(), onCloudCreate, agentTargets: COMPANIES });
    await settle();
    await toCloudDetails();

    expect(q('[data-testid="cloud-bot-auth-choice"]')).toBeNull();
    expect(q('[data-testid="cloud-bot-auth-api-key"]')).toBeNull();
    expect(q('[data-testid="cloud-bot-api-key"]')).toBeNull();

    type(q<HTMLInputElement>('[data-testid="chat-bot-name"]')!, "Polar");
    await settle();
    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(onCloudCreate).toHaveBeenCalledTimes(1);
    expect(onCloudCreate.mock.calls[0]?.[1]).not.toHaveProperty("apiKey");
    expect(onCloudCreate.mock.calls[0]?.[1]).not.toHaveProperty("authMode");
  });

  it("blocks creation and retries tenant pricing when the person asks", async () => {
    let attempts = 0;
    const loadCloudProvisionOptions = vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? failure("http-503", "unavailable")
        : ok(CLOUD_QUOTE);
    });
    render({
      oncreate: vi.fn(),
      onCloudCreate: vi.fn(),
      agentTargets: COMPANIES,
      loadCloudProvisionOptions,
    });
    await settle();
    await toCloudDetails();
    expect(q('[data-testid="cloud-bot-quote-error"]')).toBeTruthy();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')?.disabled).toBe(true);
    expect(loadCloudProvisionOptions).toHaveBeenCalledTimes(1);

    click('[data-testid="cloud-bot-quote-retry"]');
    await settle();
    expect(loadCloudProvisionOptions).toHaveBeenCalledTimes(2);
    expect(q('[data-testid="cloud-bot-quote-error"]')).toBeNull();
    expect(q('[data-testid="cloud-bot-size-basic-company-price"]')?.textContent).toBe("Your company pays $42.00/month");
  });

  it("a Cloud title over 60 characters blocks the create", async () => {
    const onCloudCreate = vi.fn(async () => undefined);
    render({ oncreate: vi.fn(), onCloudCreate, agentTargets: COMPANIES });
    await settle();
    await toCloudDetails();
    type(q<HTMLInputElement>('[data-testid="chat-bot-title"]')!, "x".repeat(61));
    await settle();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')?.disabled).toBe(true);
    expect(q('[data-testid="create-bot-issue"]')?.textContent).toContain("under 60");
    cmdEnter();
    await settle();
    expect(onCloudCreate).not.toHaveBeenCalled();
  });

  it("Cloud will not create a bot with no name", async () => {
    const onCloudCreate = vi.fn(async () => undefined);
    render({ oncreate: vi.fn(), onCloudCreate, agentTargets: COMPANIES });
    await settle();
    await toCloudDetails();
    type(q<HTMLInputElement>('[data-testid="chat-bot-name"]')!, "");
    await settle();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')?.disabled).toBe(true);
    cmdEnter();
    await settle();
    expect(onCloudCreate).not.toHaveBeenCalled();
    expect(q('[data-testid="create-bot-issue"]')?.textContent).toContain("Give your bot a name.");
  });

  it("hides Cloud when no company can host a bot", async () => {
    render({ oncreate: vi.fn(), onCloudCreate: vi.fn(), agentTargets: [] });
    await settle();
    // No Cloud or Local question: the name leads straight to the coding tool.
    expect(stepName()).toBe("name");
    expect(q('[data-testid="chat-create-bot-step"]')?.dataset.home).toBe("local");
    await toCodingTool();
    expect(stepName()).toBe("home");
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeNull();
    expect(q('[data-testid="new-bot-choice-cloud"]')).toBeNull();
    // …and no switch to a Cloud that cannot be used.
    expect(q('[data-testid="create-bot-switch-cloud"]')).toBeNull();
    expect(q('[data-testid="chat-bot-where-cloud"]')).toBeNull();
  });

  it("the coding tool step checks the derived handle against the bots already here", async () => {
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate, existingNames: ["assistant"] });
    await settle();
    // "assistant" is taken, so the flow suggested the next free name.
    const name = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
    expect(name.value).toBe("scout");
    type(name, "Assistant!");
    await settle();
    await toCodingTool();
    // Two display names that slugify the same collide on the handle.
    expect(q('[data-testid="create-bot-issue"]')?.textContent).toBe("You already have a bot with the handle @assistant.");
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')?.disabled).toBe(true);
    cmdEnter();
    await settle();
    expect(oncreate).not.toHaveBeenCalled();
    // Advanced opens itself so the collision is fixed without renaming the bot.
    expect(q('[data-testid="chat-bot-advanced"]')).toBeTruthy();
    expect(q('[data-testid="chat-bot-handle-help"]')?.textContent).toContain("handle @assistant");
    const handle = q<HTMLInputElement>('[data-testid="chat-bot-handle"]')!;
    type(handle, "assistant-2");
    await settle();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')?.disabled).toBe(false);
    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(oncreate).toHaveBeenCalledWith(
      localInput({ name: "assistant-2", runtime: "claude", autoApprove: true }),
      { displayName: "Assistant!" },
    );
  });

  it("creates a Local bot under a derived handle and keeps the display name beside it", async () => {
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate });
    await settle();
    const name = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
    type(name, "Dr Love");
    await settle();
    // The handle is what to type to mention it.
    expect(q('[data-testid="new-bot-name-handle"]')?.textContent).toBe("Teammates mention it as @dr-love.");
    await toCodingTool();
    // The identity line shows the display name.
    expect(q('[data-testid="bot-identity-name"]')?.textContent).toBe("Dr Love");
    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(oncreate).toHaveBeenCalledWith(
      localInput({ name: "dr-love", runtime: "claude", autoApprove: true }),
      { displayName: "Dr Love" },
    );
  });

  it("stores no display name when the name is already its own handle", async () => {
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate });
    await settle();
    type(q<HTMLInputElement>('[data-testid="new-bot-name"]')!, "scout");
    await settle();
    await toCodingTool();
    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(oncreate).toHaveBeenCalledWith(localInput({ name: "scout", runtime: "claude", autoApprove: true }), {});
  });

  it("carries the advanced settings into the CLI input", async () => {
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate });
    await settle();
    await toCodingTool();
    await openAdvanced();
    click('[data-testid="chat-bot-auto-approve"]');
    click('[data-testid="chat-bot-memory-local"]');
    await settle();
    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(oncreate).toHaveBeenCalledWith(
      localInput({ name: "assistant", runtime: "claude", autoApprove: false, memory: "local" }),
      {},
    );
  });

  it("asks a Local bot no title, avatar, model or intro: the bot asks in its first message", async () => {
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate });
    await settle();
    expect(q('[data-testid="new-bot-name"]')).toBeTruthy();
    await toCodingTool();
    await openAdvanced();
    for (const id of ["chat-bot-title", "chat-bot-avatar-toggle", "chat-bot-avatar-picker", "chat-bot-model", "chat-bot-intro"]) {
      expect(q(`[data-testid="${id}"]`), id).toBeNull();
    }
    // The name-idea chips and the preview card are gone too.
    expect(q('[data-testid="chat-bot-name-suggestions"]')).toBeNull();
    expect(q('[data-testid="bot-preview-card"]')).toBeNull();
    expect(host.textContent).not.toContain("Says hello");
    click('[data-testid="chat-bot-create"]');
    await settle();
    const [input, extras] = oncreate.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(input.kickoff).toBe(newBotKickoff());
    expect(extras).not.toHaveProperty("title");
    expect(extras).not.toHaveProperty("avatar");
  });

  it("shows the host's error and locks the flow while a create is in flight", async () => {
    render({ oncreate: vi.fn(), entryBusy: "bot", entryError: "You already have 3 local bots.", initialName: "assistant" });
    await settle();
    expect(q('[data-testid="chat-create-entry-error"]')?.textContent).toContain("already have 3");
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')?.disabled).toBe(true);
    expect(q<HTMLButtonElement>('[data-testid="create-bot-back"]')?.disabled).toBe(true);
  });

  it("locks the name step while a create is in flight", async () => {
    render({ oncreate: vi.fn(), entryBusy: "bot", onback: vi.fn() });
    await settle();
    expect(q<HTMLButtonElement>('[data-testid="new-bot-continue-name"]')?.disabled).toBe(true);
    expect(q<HTMLButtonElement>('[data-testid="create-bot-back"]')?.disabled).toBe(true);
  });

  it("shows the bot as it is drafted: handle on the name step, identity line after", async () => {
    render({ oncreate: vi.fn() });
    await settle();
    expect(q('[data-testid="new-bot-name-handle"]')?.textContent).toContain("@assistant");
    expect(q('[data-testid="bot-identity-line"]')).toBeNull();
    await toCodingTool();
    expect(q('[data-testid="bot-identity-name"]')?.textContent).toBe("assistant");
    expect(q('[data-testid="bot-identity-meta"]')?.textContent).toContain("Claude Code");
    expect(q('[data-testid="bot-identity-meta"]')?.textContent).not.toContain("from ");
    await openTemplates();
    click('[data-testid="create-bot-kind-template"]');
    await settle();
    click('[data-testid="create-bot-template-card"]');
    await settle();
    expect(q('[data-testid="bot-identity-meta"]')?.textContent).toContain("from Note Taker");
  });
});
