// @vitest-environment happy-dom

/**
 * desktop-agent-creation US-004 / US-005 in the New bot flow, flag on and off.
 *
 * Flag off: the flow behaves exactly as before (Cloud hidden without a
 * company, the cloud draft carries no key or quote). Flag on: Cloud is always
 * on screen, disabled with the reason and the fix when it cannot be used, and
 * the draft carries one idempotency key per session plus the quote the
 * person saw.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type AgentProvisionOptionsView } from "@hq/platform";
import type { CreateAvailability } from "@hq/agents";
// Warm the module the flow loads through import() once the flag is on, so the
// lazy load resolves from the module cache inside settle().
import "@hq/agents";

import CreateBotFlow from "./CreateBotFlow.svelte";
import type { DirectCloudCreate } from "./cloud-create.js";

const COMPANIES = [
  { companyUid: "cmp_indigo", label: "Indigo" },
  { companyUid: "cmp_acme", label: "Acme" },
];

const QUOTE: AgentProvisionOptionsView = {
  defaultInstanceType: "t3.medium",
  catalogVersion: "catalog-7",
  options: [
    {
      key: "basic",
      productName: "Basic",
      instanceType: "t3.medium",
      listCents: 10000,
      default: true,
      selectable: true,
      netMonthlyCents: 10000,
      deltaCents: 10000,
      unavailableReason: null,
      notBilled: false,
      lanes: 3,
      workers: 3,
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

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
  // The flow loads `@hq/agents` through import() once the flag is on; that
  // resolves on a later task, not a microtask.
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
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

function seam(on: boolean, availability: Record<string, CreateAvailability> = {}): DirectCloudCreate {
  return {
    isEnabled: vi.fn(async () => on),
    anyEnabled: vi.fn(async () => on),
    availability: vi.fn(async (uid: string) => availability[uid] ?? { state: "available" }),
    client: {} as DirectCloudCreate["client"],
  };
}

function render(props: Record<string, unknown> = {}): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CreateBotFlow, {
    target: host,
    props: {
      botRuntimeReady: { claude: true, codex: true, grok: true },
      botWorkers: [],
      existingNames: [],
      botCompanies: [],
      loadClaudeProviderFlag: async () => ok(true),
      loadCloudProvisionOptions: async () => ok(QUOTE),
      oncreate: vi.fn(),
      // The name was given on the first step (the takeover's), so the flow
      // opens on "Where should it live?".
      initialName: "Dr Love",
      ...props,
    },
  });
}

function typeName(value: string): void {
  const name = q<HTMLInputElement>('[data-testid="chat-bot-name"]');
  if (!name) throw new Error("missing chat-bot-name");
  name.value = value;
  name.dispatchEvent(new Event("input", { bubbles: true }));
}

/** "Where should it run?" → Cloud → company (when more than one) → details. */
async function openCloudDetails(): Promise<void> {
  click('[data-testid="new-bot-choice-cloud"]');
  await settle();
  expect(q('[data-testid="create-bot-sunrise-home"]')).toBeTruthy();
  click('[data-testid="create-bot-next"]');
  await settle();
  expect(q('[data-testid="create-bot-sunrise-details"]')).toBeTruthy();
  typeName("Dr Love");
  await settle();
}

/** Where → Cloud → company → details → Create. */
async function createCloud(): Promise<void> {
  await openCloudDetails();
  click('[data-testid="chat-bot-create"]');
  await settle();
}

describe("New bot flow, agents.desktop-agent-creation off", () => {
  it("hands the host the same draft as before: no key, no quote", async () => {
    const onCloudCreate = vi.fn(async (_companyUid: string, _draft: Record<string, unknown>) => undefined);
    render({ onCloudCreate, agentTargets: COMPANIES, directCloud: seam(false) });
    await settle();
    await createCloud();
    expect(onCloudCreate).toHaveBeenCalledTimes(1);
    const draft = onCloudCreate.mock.calls[0]![1] as Record<string, unknown>;
    expect(draft).not.toHaveProperty("idempotencyKey");
    expect(draft).not.toHaveProperty("quote");
  });

  it("still hides Cloud when there is no company", async () => {
    render({ onCloudCreate: vi.fn(), agentTargets: [], directCloud: seam(false) });
    await settle();
    // Flag off and no company: no Cloud/Local question, Cloud nowhere, the
    // flow opens on the local coding tool step.
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeNull();
    expect(q('[data-testid="new-bot-choice-cloud"]')).toBeNull();
    expect(q('[data-testid="chat-bot-where-cloud"]')).toBeNull();
    expect(q('[data-testid="create-bot-switch-cloud"]')).toBeNull();
    expect(q('[data-testid="create-bot-sunrise-home"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="chat-create-bot-step"]')?.getAttribute("data-home")).toBe("local");
  });

  it("never probes availability", async () => {
    const off = seam(false);
    render({ onCloudCreate: vi.fn(), agentTargets: COMPANIES, directCloud: off });
    await settle();
    expect(off.availability).not.toHaveBeenCalled();
  });
});

describe("New bot flow, agents.desktop-agent-creation on", () => {
  it("sends one idempotency key per session and the quote the person saw", async () => {
    const onCloudCreate = vi.fn(async (_companyUid: string, _draft: Record<string, unknown>) => undefined);
    render({ onCloudCreate, agentTargets: COMPANIES, directCloud: seam(true) });
    await settle();
    await createCloud();
    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(onCloudCreate).toHaveBeenCalledTimes(2);
    const first = onCloudCreate.mock.calls[0]![1] as { idempotencyKey?: string; quote?: unknown };
    const second = onCloudCreate.mock.calls[1]![1] as { idempotencyKey?: string };
    expect(first.idempotencyKey).toMatch(/^desktop-new-bot-/);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(first.quote).toEqual({ instanceType: "t3.medium", netMonthlyCents: 10000, catalogVersion: "catalog-7" });
  });

  it("defaults the brain to Claude without the separate Claude flag, with Codex and Grok offered", async () => {
    const onCloudCreate = vi.fn(async (_companyUid: string, _draft: Record<string, unknown>) => undefined);
    render({
      onCloudCreate,
      agentTargets: COMPANIES,
      directCloud: seam(true),
      loadClaudeProviderFlag: async () => ok(false),
    });
    await settle();
    await openCloudDetails();
    expect(q<HTMLInputElement>('[data-testid="cloud-bot-runtime-claude"]')?.checked).toBe(true);
    expect(q('[data-testid="cloud-bot-runtime-codex"]')).not.toBeNull();
    expect(q('[data-testid="cloud-bot-runtime-grok"]')).not.toBeNull();
    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(onCloudCreate).toHaveBeenCalledTimes(1);
    expect((onCloudCreate.mock.calls[0]![1] as { runtime?: string }).runtime).toBe("claude");
  });

  it("a member without createAgents sees Cloud disabled with the admin to ask", async () => {
    render({
      onCloudCreate: vi.fn(),
      agentTargets: [COMPANIES[0]],
      directCloud: seam(true, { cmp_indigo: { state: "role", admins: ["Corey"] } }),
    });
    await settle();
    const card = q<HTMLButtonElement>('[data-testid="new-bot-choice-cloud"]');
    expect(card).toBeTruthy();
    expect(card!.disabled).toBe(true);
    expect(q('#new-bot-choice-cloud-body')?.textContent?.trim()).toBe(
      "Only admins of Indigo can add cloud bots. Ask Corey.",
    );
    // A role block has no checkout to offer.
    expect(q('[data-testid="chat-bot-where-cloud-fix"]')).toBeNull();
  });

  it("a plan-limited admin sees the plan and the checkout link", async () => {
    render({
      onCloudCreate: vi.fn(),
      agentTargets: [COMPANIES[0]],
      directCloud: seam(true, {
        cmp_indigo: { state: "plan", amountMinor: 50000, currency: "usd", checkoutUrl: "https://checkout.test/agents" },
      }),
    });
    await settle();
    expect(q<HTMLButtonElement>('[data-testid="new-bot-choice-cloud"]')!.disabled).toBe(true);
    expect(q('#new-bot-choice-cloud-body')?.textContent?.trim()).toBe(
      "Cloud bots need the Agents plan ($500 a month). Indigo isn't on it yet.",
    );
    const link = q<HTMLAnchorElement>('[data-testid="chat-bot-where-cloud-fix"]');
    expect(link?.getAttribute("href")).toBe("https://checkout.test/agents");
    expect(link?.textContent).toBe("Upgrade plan");
  });

  it("no company: Cloud is shown, disabled, with the reason", async () => {
    render({ onCloudCreate: vi.fn(), agentTargets: [], directCloud: seam(true) });
    await settle();
    expect(q<HTMLButtonElement>('[data-testid="new-bot-choice-cloud"]')!.disabled).toBe(true);
    expect(q('#new-bot-choice-cloud-body')?.textContent?.trim()).toBe(
      "Cloud bots belong to a company. Create or join a company first.",
    );
  });

  it("disables only the company that refuses and picks one that can host", async () => {
    const onCloudCreate = vi.fn(async (_companyUid: string, _draft: Record<string, unknown>) => undefined);
    render({
      onCloudCreate,
      agentTargets: COMPANIES,
      directCloud: seam(true, { cmp_indigo: { state: "role", admins: [] } }),
    });
    await settle();
    click('[data-testid="new-bot-choice-cloud"]');
    await settle();
    const rows = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-testid="chat-create-agent-company"]'));
    expect(rows.map((r) => [r.dataset.company, r.disabled, r.getAttribute("aria-selected")])).toEqual([
      ["cmp_indigo", true, "false"],
      ["cmp_acme", false, "true"],
    ]);
    expect(q('[data-testid="chat-create-agent-company-reason"]')?.textContent).toBe(
      "Only admins of Indigo can add cloud bots. Ask a company admin.",
    );
    click('[data-testid="create-bot-next"]');
    await settle();
    typeName("Dr Love");
    await settle();
    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(onCloudCreate.mock.calls[0]![0]).toBe("cmp_acme");
  });

  it("renders the fix for a refused create: checkout link, fresh quote, handle", async () => {
    const loadCloudProvisionOptions = vi.fn(async () => ok(QUOTE));
    render({
      onCloudCreate: vi.fn(),
      agentTargets: COMPANIES,
      directCloud: seam(true),
      loadCloudProvisionOptions,
      entryError: "The price for this size changed since you opened this.",
      entryFix: { kind: "reload_quote" },
    });
    await settle();
    click('[data-testid="new-bot-choice-cloud"]');
    await settle();
    expect(q('[data-testid="chat-create-entry-fix"]')?.textContent).toContain("Get the new price");
    const before = loadCloudProvisionOptions.mock.calls.length;
    click('[data-testid="chat-create-entry-fix"]');
    await settle();
    expect(loadCloudProvisionOptions.mock.calls.length).toBe(before + 1);
  });

  it("a plan refusal at create offers the checkout link", async () => {
    render({
      onCloudCreate: vi.fn(),
      agentTargets: COMPANIES,
      directCloud: seam(true),
      entryError: "Cloud bots need the Agents plan.",
      entryFix: { kind: "checkout", url: "https://checkout.test/x", label: "Upgrade plan" },
    });
    await settle();
    // A refusal comes back from Create, so the person is on the cloud steps.
    await openCloudDetails();
    expect(q('[data-testid="chat-create-entry-error"]')?.textContent).toContain("Cloud bots need the Agents plan.");
    const link = q<HTMLAnchorElement>('[data-testid="chat-create-entry-fix"]');
    expect(link?.tagName).toBe("A");
    expect(link?.getAttribute("href")).toBe("https://checkout.test/x");
  });

  it("a handle refusal at create sends the person back to the name step", async () => {
    render({
      onCloudCreate: vi.fn(),
      agentTargets: COMPANIES,
      directCloud: seam(true),
      entryError: "That handle is taken in Indigo.",
      entryFix: { kind: "edit_handle" },
    });
    await settle();
    click('[data-testid="new-bot-choice-cloud"]');
    await settle();
    expect(q('[data-testid="create-bot-sunrise-home"]')).toBeTruthy();
    const fix = q<HTMLButtonElement>('[data-testid="chat-create-entry-fix"]');
    expect(fix?.textContent).toContain("Change handle");
    fix!.click();
    await settle();
    expect(q('[data-testid="create-bot-sunrise-details"]')).toBeTruthy();
    expect(q('[data-testid="chat-bot-name"]')).toBeTruthy();
  });

  it("shows an entry error on the Cloud/Local choice screen", async () => {
    render({
      onCloudCreate: vi.fn(),
      agentTargets: COMPANIES,
      directCloud: seam(true),
      entryError: "Cloud bots need the Agents plan.",
      entryFix: { kind: "checkout", url: "https://checkout.test/x", label: "Upgrade plan" },
    });
    await settle();
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeTruthy();
    expect(q('[data-testid="chat-create-entry-error"]')?.textContent).toContain("Cloud bots need the Agents plan.");
  });
});
