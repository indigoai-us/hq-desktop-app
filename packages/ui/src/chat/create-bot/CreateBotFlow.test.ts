// @vitest-environment happy-dom

/**
 * The New bot flow end to end, without a host: kind → home → details for a
 * Local bot, kind → home for a Cloud one. The flow owns the draft and the
 * keyboard; the host only runs the create.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import type { LocalBotWorkerOption } from "@hq/platform";

import CreateBotFlow from "./CreateBotFlow.svelte";

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
      // A rail preview needs matchMedia; pin the placement so the test is stable.
      previewPlacement: "top",
      ...props,
    },
  });
}

describe("CreateBotFlow", () => {
  it("walks kind → home → details and back again", async () => {
    const oncreate = vi.fn(async () => undefined);
    const onback = vi.fn();
    render({ oncreate, onback });
    await settle();

    expect(q('[data-testid="create-bot-kind-step"]')).toBeTruthy();
    expect(q('[data-testid="chat-create-bot-step"]')?.dataset.step).toBe("kind");
    // Back on the first step leaves the flow.
    click('[data-testid="create-bot-back"]');
    expect(onback).toHaveBeenCalledTimes(1);

    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="create-bot-home-step"]')).toBeTruthy();
    // Local is the default when the host can run bots, with a signed-in runtime.
    expect(q('[data-testid="chat-bot-where-local"]')?.getAttribute("aria-checked")).toBe("true");

    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="create-bot-details-step"]')).toBeTruthy();
    // The last step creates rather than advances.
    expect(q('[data-testid="create-bot-next"]')).toBeNull();
    expect(q('[data-testid="chat-bot-create"]')?.textContent).toContain("Create bot");

    click('[data-testid="create-bot-back"]');
    await settle();
    expect(q('[data-testid="create-bot-home-step"]')).toBeTruthy();
  });

  it("picking Blank moves straight on to where it runs", async () => {
    render({ oncreate: vi.fn() });
    await settle();
    click('[data-testid="create-bot-kind-template"]');
    await settle();
    expect(q('[data-testid="create-bot-kind-step"]')).toBeTruthy();
    click('[data-testid="create-bot-kind-blank"]');
    await settle();
    expect(q('[data-testid="create-bot-home-step"]')).toBeTruthy();
    expect(q('[data-testid="bot-preview-kind"]')?.textContent).toContain("Blank bot");
  });

  it("offers only Blank and From a template, and no template without company workers", async () => {
    render({ oncreate: vi.fn(), botWorkers: WORKERS.filter((w) => w.id === "setup") });
    await settle();
    const kinds = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-testid="create-bot-kinds"] [data-kind]'));
    expect(kinds.map((k) => k.dataset.kind)).toEqual(["blank", "template"]);
    expect(q('[data-testid="create-bot-kind-clone"]')).toBeNull();
    expect(q<HTMLButtonElement>('[data-testid="create-bot-kind-template"]')?.disabled).toBe(true);
  });

  it("a template card fills the draft and rides along to the CLI input", async () => {
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate });
    await settle();

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

    // Until a card is picked, the kind step is blocked.
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')?.disabled).toBe(true);
    expect(q('[data-testid="create-bot-issue"]')?.textContent).toContain("Pick a template.");

    cards[1]!.click();
    await settle();
    expect(cards[1]!.getAttribute("aria-selected")).toBe("true");
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')?.disabled).toBe(false);

    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    // The details step says what the template brings.
    expect(q('[data-testid="chat-bot-template-brings"]')?.textContent).toContain("3 skills");
    click('[data-testid="chat-bot-create"]');
    await settle();
    // A company template defaults to a company bot for that company.
    expect(oncreate).toHaveBeenCalledWith(
      { name: "assistant", runtime: "claude", autoApprove: true, worker: "iris-cx", kind: "company", companies: ["indigo"] },
      {},
    );
  });

  it("asks who the bot is for: personal by default, company needs at least one company (bot-kinds)", async () => {
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate });
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="chat-bot-scope-personal"]')?.getAttribute("aria-checked")).toBe("true");
    expect(q('[data-testid="chat-bot-scope-personal"]')?.textContent).toContain("acts as you");
    expect(q('[data-testid="chat-bot-scope-companies"]')).toBeNull();

    click('[data-testid="chat-bot-scope-company"]');
    await settle();
    expect(q('[data-testid="chat-bot-scope-company"]')?.getAttribute("aria-checked")).toBe("true");
    // Company kind without a company cannot advance nor create.
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')?.disabled).toBe(true);
    expect(q('[data-testid="create-bot-issue"]')?.textContent).toContain("Pick at least one company.");
    cmdEnter();
    await settle();
    expect(oncreate).not.toHaveBeenCalled();

    click('[data-testid="chat-bot-scope-company-indigo"]');
    click('[data-testid="chat-bot-scope-company-acme"]');
    await settle();
    expect(q('[data-testid="chat-bot-scope-company-acme"]')?.getAttribute("aria-checked")).toBe("true");
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')?.disabled).toBe(false);
    // Unpicking one keeps the other.
    click('[data-testid="chat-bot-scope-company-indigo"]');
    await settle();
    expect(q('[data-testid="chat-bot-scope-company-indigo"]')?.getAttribute("aria-checked")).toBe("false");

    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(oncreate).toHaveBeenCalledWith(
      { name: "assistant", runtime: "claude", autoApprove: true, kind: "company", companies: ["acme"] },
      {},
    );
  });

  it("answering Personal sticks, even after going back and picking a company template", async () => {
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate });
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    // Answer the question explicitly (Personal is already selected; click it anyway).
    click('[data-testid="chat-bot-scope-personal"]');
    await settle();
    click('[data-testid="create-bot-back"]');
    await settle();
    click('[data-testid="create-bot-kind-template"]');
    await settle();
    host.querySelector<HTMLButtonElement>('[data-testid="create-bot-template-card"][data-template="iris-cx"]')!.click();
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="chat-bot-scope-personal"]')?.getAttribute("aria-checked")).toBe("true");
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(oncreate).toHaveBeenCalledWith({ name: "assistant", runtime: "claude", autoApprove: true, worker: "iris-cx" }, {});
  });

  it("with no company to join, the company choice explains and personal still creates", async () => {
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate, botCompanies: [] });
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="chat-bot-scope-company"]');
    await settle();
    expect(q('[data-testid="chat-bot-scope-help"]')?.textContent).toContain("not in a company yet");
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')?.disabled).toBe(true);
    click('[data-testid="chat-bot-scope-personal"]');
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(oncreate).toHaveBeenCalledWith({ name: "assistant", runtime: "claude", autoApprove: true }, {});
  });

  it("searching the library filters the cards", async () => {
    render({ oncreate: vi.fn() });
    await settle();
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

  it("⌘↵ creates from any step, but only once every step it walks is valid", async () => {
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate });
    await settle();

    // Template chosen, no card picked yet → the draft is incomplete.
    click('[data-testid="create-bot-kind-template"]');
    await settle();
    cmdEnter();
    await settle();
    expect(oncreate).not.toHaveBeenCalled();

    click('[data-testid="create-bot-template-card"]');
    await settle();
    cmdEnter();
    await settle();
    // A company template (Acme's note-taker) defaults to a company bot for Acme.
    expect(oncreate).toHaveBeenCalledWith(
      { name: "assistant", runtime: "claude", autoApprove: true, worker: "note-taker", kind: "company", companies: ["acme"] },
      {},
    );
  });

  it("⌘↵ is blocked while the chosen runtime is not signed in", async () => {
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate, botRuntimeReady: { claude: false, codex: false, grok: false } });
    await settle();
    cmdEnter();
    await settle();
    expect(oncreate).not.toHaveBeenCalled();
    // The flow parks the user on the step that still needs them.
    expect(q('[data-testid="create-bot-home-step"]')).toBeTruthy();
    expect(q('[data-testid="create-bot-issue"]')?.textContent).toContain("not signed in");
  });

  it("Cloud names the bot before it is created and hands both to the host", async () => {
    const onCloudCreate = vi.fn(async () => undefined);
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate, onCloudCreate, agentTargets: COMPANIES });
    await settle();

    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="chat-bot-where-cloud"]');
    await settle();
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
    expect(onCloudCreate).toHaveBeenCalledWith("cmp_acme", { name: "Polar Bear", handle: "ice" });
    expect(oncreate).not.toHaveBeenCalled();
  });

  it("\u2318\u21b5 on a Cloud draft moves to the details step instead of creating", async () => {
    const onCloudCreate = vi.fn(async () => undefined);
    render({ oncreate: vi.fn(), onCloudCreate, agentTargets: COMPANIES });
    await settle();

    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="chat-bot-where-cloud"]');
    await settle();

    // A company bot is named on the details step, so the shortcut takes the
    // person there rather than creating one called "assistant" they never saw.
    cmdEnter();
    await settle();
    expect(onCloudCreate).not.toHaveBeenCalled();
    expect(q('[data-testid="create-bot-cloud-details-step"]')).toBeTruthy();

    // Same from the kind step: forward one step at a time, never past details.
    click('[data-testid="create-bot-back"]');
    await settle();
    click('[data-testid="create-bot-back"]');
    await settle();
    expect(q('[data-testid="create-bot-kind-step"]')).toBeTruthy();
    cmdEnter();
    await settle();
    expect(onCloudCreate).not.toHaveBeenCalled();
    expect(q('[data-testid="create-bot-home-step"]')).toBeTruthy();

    // From the details step it creates — with the name now on screen.
    cmdEnter();
    await settle();
    const name = q<HTMLInputElement>('[data-testid="chat-bot-name"]')!;
    type(name, "Polar Bear");
    await settle();
    cmdEnter();
    await settle();
    expect(onCloudCreate).toHaveBeenCalledWith("cmp_indigo", {
      name: "Polar Bear",
      handle: "polar-bear",
    });
  });

  it("Cloud will not create a bot with no name", async () => {
    const onCloudCreate = vi.fn(async () => undefined);
    render({ oncreate: vi.fn(), onCloudCreate, agentTargets: COMPANIES });
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="chat-bot-where-cloud"]');
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    type(q<HTMLInputElement>('[data-testid="chat-bot-name"]')!, "");
    await settle();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')?.disabled).toBe(true);
    cmdEnter();
    await settle();
    expect(onCloudCreate).not.toHaveBeenCalled();
    expect(q('[data-testid="create-bot-issue"]')?.textContent).toContain("Give your bot a name.");
  });

  it("hides Cloud when no company can host a bot", async () => {
    render({ oncreate: vi.fn(), agentTargets: [] });
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="chat-bot-where-cloud"]')).toBeNull();
  });

  it("the details step validates the name against the bots already here", async () => {
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate, existingNames: ["assistant"] });
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    // "assistant" is taken, so the flow suggested the next free name.
    const name = q<HTMLInputElement>('[data-testid="chat-bot-name"]')!;
    expect(name.value).toBe("scout");
    name.value = "assistant";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(q('[data-testid="chat-bot-name-help"]')?.textContent).toContain("already have a bot named");
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')?.disabled).toBe(true);

    name.value = "Scout!";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(q('[data-testid="chat-bot-name-help"]')?.textContent).toContain("Lowercase letters");
    expect(oncreate).not.toHaveBeenCalled();
  });

  it("carries the intro and the advanced settings into the CLI input", async () => {
    const oncreate = vi.fn(async () => undefined);
    render({ oncreate });
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    const intro = q<HTMLTextAreaElement>('[data-testid="chat-bot-intro"]')!;
    intro.value = "Hi, I'm scout. I watch the ad accounts.";
    intro.dispatchEvent(new Event("input", { bubbles: true }));
    click('[data-testid="chat-bot-auto-approve"]');
    click('[data-testid="chat-bot-memory-local"]');
    await settle();
    click('[data-testid="chat-bot-create"]');
    await settle();
    expect(oncreate).toHaveBeenCalledWith(
      {
        name: "assistant",
        runtime: "claude",
        autoApprove: false,
        intro: "Hi, I'm scout. I watch the ad accounts.",
        memory: "local"
      },
      {},
    );
  });

  it("shows the host's error and locks the flow while a create is in flight", async () => {
    render({ oncreate: vi.fn(), entryBusy: "bot", entryError: "You already have 3 local bots." });
    await settle();
    expect(q('[data-testid="chat-create-entry-error"]')?.textContent).toContain("already have 3");
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')?.disabled).toBe(true);
    expect(q<HTMLButtonElement>('[data-testid="create-bot-back"]')?.disabled).toBe(true);
  });

  it("previews the bot as it is drafted", async () => {
    render({ oncreate: vi.fn() });
    await settle();
    expect(q('[data-testid="bot-preview-name"]')?.textContent).toBe("assistant");
    expect(q('[data-testid="bot-preview-thinks"]')?.textContent).toContain("Claude Code");
    expect(q('[data-testid="bot-preview-kind"]')?.textContent).toContain("Blank bot");
    click('[data-testid="create-bot-kind-template"]');
    await settle();
    click('[data-testid="create-bot-template-card"]');
    await settle();
    expect(q('[data-testid="bot-preview-kind"]')?.textContent).toContain("From Note Taker");
  });

});
