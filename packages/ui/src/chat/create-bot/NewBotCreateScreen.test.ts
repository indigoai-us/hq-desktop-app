// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import NewBotCreateScreen from "./NewBotCreateScreen.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
const options = {
  defaultInstanceType: "t4g.medium",
  catalogVersion: "test",
  options: [
    {
      key: "basic" as const,
      productName: "Basic",
      instanceType: "t4g.medium",
      listCents: 5000,
      default: true,
      selectable: true,
      netMonthlyCents: 5000,
      deltaCents: 5000,
      unavailableReason: null,
      notBilled: false,
      lanes: 1,
      workers: 1,
    },
  ],
};
async function settle(): Promise<void> {
  await tick();
  await Promise.resolve();
  await tick();
}
function render(overrides: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const oncreate = vi.fn(async () => ({
    ok: true as const,
    target: { channelId: "chn_bot", cardId: null, cardKind: null },
  }));
  const oncomplete = vi.fn();
  component = mount(NewBotCreateScreen, {
    target: host,
    props: {
      companies: [
        { companyUid: "cmp_current", label: "Current company" },
        { companyUid: "cmp_other", label: "Other company" },
      ],
      currentCompanyUid: "cmp_current",
      runtimeReady: { codex: true, claude: false, grok: false },
      loadProvisionOptions: async () => ({ ok: true as const, value: options }),
      oncreate,
      oncomplete,
      ...overrides,
    },
  });
  return { oncreate, oncomplete };
}
function typeName(value: string): void {
  const input = document.querySelector<HTMLInputElement>(
    "[data-testid='new-bot-name']",
  )!;
  input.value = value;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
}
async function advanceName(): Promise<void> {
  typeName("Polar");
  await settle();
  document
    .querySelector<HTMLButtonElement>("[data-testid='new-bot-continue-name']")!
    .click();
  await settle();
}
afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("NewBotCreateScreen", () => {
  it("keeps the name input alone and never renders the derived handle", async () => {
    render();
    await settle();
    expect(
      document.querySelector("[data-testid='new-bot-derived-handle']"),
    ).toBeNull();
    expect(document.querySelector(".new-bot-name-row")).toBeNull();
    expect(document.querySelector("#new-bot-handle")).toBeNull();
  });
  it("advances with Enter and preselects the signed-in brain", async () => {
    render();
    await settle();
    typeName("Polar");
    document
      .querySelector<HTMLInputElement>("[data-testid='new-bot-name']")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    await settle();
    expect(
      document.querySelector("[data-testid='new-bot-step-2']"),
    ).toBeTruthy();
    expect(
      document.querySelector<HTMLInputElement>("input[value='codex']")?.checked,
    ).toBe(true);
  });
  describe("Claude is offered only when the company has it (review A-C1)", () => {
    function brains(): string[] {
      return [...document.querySelectorAll<HTMLInputElement>("input[name='new-bot-brain']")].map((input) => input.value);
    }
    function checkedBrain(): string | undefined {
      return document.querySelector<HTMLInputElement>("input[name='new-bot-brain']:checked")?.value;
    }
    const ONE_COMPANY = { companies: [{ companyUid: "cmp_only", label: "Only company" }], currentCompanyUid: "cmp_only" };

    it("never shows or preselects Claude without the provider, even when Claude is the one signed in here", async () => {
      // The server answers a Claude create with 403 CLAUDE_PROVIDER_NOT_ENABLED
      // for a company without the provider. Claude signed in on this computer
      // used to be preselected regardless, so Create bot led straight to it.
      const { oncreate } = render({ ...ONE_COMPANY, runtimeReady: { claude: true, codex: false, grok: false } });
      await settle();
      await advanceName();
      expect(brains()).toEqual(["codex", "grok"]);
      expect(checkedBrain()).toBe("codex");
      expect(document.querySelector("[data-testid='new-bot-step-2']")?.textContent).not.toContain("Claude");
      document.querySelector<HTMLButtonElement>("[data-testid='new-bot-create-submit']")!.click();
      await settle();
      expect(oncreate).toHaveBeenCalledWith("cmp_only", expect.objectContaining({ runtime: "codex" }));
    });

    it("prefers another signed-in brain over a Claude that is not offered", async () => {
      render({ ...ONE_COMPANY, runtimeReady: { claude: true, codex: false, grok: true } });
      await settle();
      await advanceName();
      expect(checkedBrain()).toBe("grok");
    });

    it("offers Claude, and preselects it when signed in, once the provider is on", async () => {
      const { oncreate } = render({ ...ONE_COMPANY, claudeEnabled: true, runtimeReady: { claude: true, codex: true, grok: false } });
      await settle();
      await advanceName();
      expect(brains()).toEqual(["codex", "claude", "grok"]);
      expect(checkedBrain()).toBe("claude");
      document.querySelector<HTMLButtonElement>("[data-testid='new-bot-create-submit']")!.click();
      await settle();
      expect(oncreate).toHaveBeenCalledWith("cmp_only", expect.objectContaining({ runtime: "claude" }));
    });
  });
  describe("when the company's options do not load (review A-C3)", () => {
    const ONE_COMPANY = { companies: [{ companyUid: "cmp_only", label: "Only company" }], currentCompanyUid: "cmp_only" };
    const createButton = () => document.querySelector<HTMLButtonElement>("[data-testid='new-bot-create-submit']")!;
    const problem = () => document.querySelector<HTMLElement>("[data-testid='new-bot-options-error']");
    const retry = () => document.querySelector<HTMLButtonElement>("[data-testid='new-bot-options-retry']");

    it("tells a member who may not add bots why Create is off, names who to ask, and lets them try again", async () => {
      // A regular member gets 403 from the provision-options read. Create bot
      // was disabled with no message and no way forward.
      const loadProvisionOptions = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          reason: "error",
          code: "CREATE_AGENTS_NOT_ALLOWED",
          status: 403,
          message: "Forbidden: createAgents capability required",
          admins: [
            { personUid: "prs_corey", displayName: "Corey" },
            { personUid: "prs_dana", displayName: "Dana" },
          ],
        })
        .mockResolvedValueOnce({ ok: true, value: options });
      const { oncreate } = render({ ...ONE_COMPANY, loadProvisionOptions });
      await settle();
      await advanceName();

      expect(createButton().disabled).toBe(true);
      expect(problem()?.getAttribute("role")).toBe("alert");
      expect(problem()?.dataset.kind).toBe("permission");
      expect(problem()?.textContent).toBe("You don't have permission to add bots in Only company. Ask Corey or Dana.");
      expect(retry()?.textContent).toBe("Try again");

      // An admin allowed it meanwhile: Try again reads the options once more.
      retry()!.click();
      await settle();
      expect(loadProvisionOptions).toHaveBeenCalledTimes(2);
      expect(problem()).toBeNull();
      expect(retry()).toBeNull();
      expect(createButton().disabled).toBe(false);
      createButton().click();
      await settle();
      expect(oncreate).toHaveBeenCalledTimes(1);
    });

    it("says an owner or admin when the server names nobody", async () => {
      render({ ...ONE_COMPANY, loadProvisionOptions: async () => ({ ok: false as const, reason: "error" as const, code: "http-403" }) });
      await settle();
      await advanceName();
      expect(problem()?.textContent).toBe("You don't have permission to add bots in Only company. Ask an owner or admin.");
    });

    it.each([
      ["answers with a server error", async () => ({ ok: false as const, reason: "error" as const, code: "http-500" })],
      ["throws", async () => { throw new Error("offline"); }],
      ["answers without a list of options", async () => ({ ok: true as const, value: { catalogVersion: "x" } })],
    ])("says the price could not be loaded when the read %s, and offers Try again", async (_label, loadProvisionOptions) => {
      render({ ...ONE_COMPANY, loadProvisionOptions });
      await settle();
      await advanceName();
      expect(createButton().disabled).toBe(true);
      expect(problem()?.dataset.kind).toBe("load");
      expect(problem()?.textContent).toBe("We couldn't load the price for Only company. Check your connection and try again.");
      expect(retry()).toBeTruthy();
    });

    it("shows the reason on the step that holds Create bot, for the company picked there", async () => {
      const loadProvisionOptions = vi.fn(async (companyUid: string) =>
        companyUid === "cmp_other"
          ? { ok: false as const, reason: "error" as const, code: "CREATE_AGENTS_NOT_ALLOWED", admins: [{ personUid: "prs_lee", displayName: "Lee" }] }
          : { ok: true as const, value: options },
      );
      render({ loadProvisionOptions });
      await settle();
      await advanceName();
      // The brain step of a two-company flow has no Create bot, so no reason.
      expect(problem()).toBeNull();
      document.querySelector<HTMLButtonElement>("[data-testid='new-bot-continue-brain']")!.click();
      await settle();
      expect(problem()).toBeNull();
      document.querySelector<HTMLButtonElement>("[data-company-uid='cmp_other']")!.click();
      await settle();
      expect(problem()?.textContent).toBe("You don't have permission to add bots in Other company. Ask Lee.");
      expect(createButton().disabled).toBe(true);
      // Back on a company where the person may add bots, the reason goes.
      document.querySelector<HTMLButtonElement>("[data-company-uid='cmp_current']")!.click();
      await settle();
      expect(problem()).toBeNull();
      expect(createButton().disabled).toBe(false);
    });
  });
  it("skips company selection for one company and creates from the brain step", async () => {
    const { oncreate } = render({
      companies: [{ companyUid: "cmp_only", label: "Only company" }],
      currentCompanyUid: "cmp_only",
    });
    await settle();
    await advanceName();
    expect(document.querySelector("[data-testid='new-bot-step-3']")).toBeNull();
    document
      .querySelector<HTMLButtonElement>(
        "[data-testid='new-bot-create-submit']",
      )!
      .click();
    await settle();
    expect(oncreate).toHaveBeenCalledWith(
      "cmp_only",
      expect.objectContaining({
        handle: "polar",
        runtime: "codex",
        authMode: "subscription",
      }),
    );
  });
  it("preserves answers when going back", async () => {
    // Claude is picked on the way, so this company has the Claude provider.
    render({ claudeEnabled: true });
    await settle();
    await advanceName();
    document
      .querySelector<HTMLButtonElement>(
        "[data-testid='new-bot-continue-brain']",
      )!
      .click();
    await settle();
    document
      .querySelector<HTMLButtonElement>("[data-company-uid='cmp_other']")!
      .click();
    await settle();
    document.querySelector<HTMLButtonElement>(".new-bot-back")!.click();
    await settle();
    document.querySelector<HTMLInputElement>("input[value='claude']")!.click();
    document.querySelector<HTMLButtonElement>(".new-bot-back")!.click();
    await settle();
    expect(
      document.querySelector<HTMLInputElement>("[data-testid='new-bot-name']")
        ?.value,
    ).toBe("Polar");
  });
  it("shows a final-step failure and permits a retry", async () => {
    const oncreate = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        blocked: false,
        reason: "The server didn't send the next step for the new bot.",
      })
      .mockResolvedValueOnce({
        ok: true,
        target: { channelId: "chn_bot", cardId: null, cardKind: null },
      });
    render({ oncreate });
    await settle();
    await advanceName();
    document
      .querySelector<HTMLButtonElement>(
        "[data-testid='new-bot-continue-brain']",
      )!
      .click();
    await settle();
    // The form gives way to the creating view while the request runs, so the
    // button is a fresh element after a failure brings the form back.
    const createButton = () =>
      document.querySelector<HTMLButtonElement>(
        "[data-testid='new-bot-create-submit']",
      )!;
    createButton().click();
    await settle();
    expect(document.querySelector("[role='alert']")?.textContent).toContain(
      "The server didn't send",
    );
    expect(document.querySelector("[data-testid='new-bot-creating']")).toBeNull();
    expect(
      document
        .querySelector("[data-company-uid='cmp_current']")
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(createButton().disabled).toBe(false);
    createButton().click();
    await settle();
    expect(oncreate).toHaveBeenCalledTimes(2);
  });
  it("turns a plan refusal from the create action into the upgrade step and lets the person pick another company", async () => {
    const oncreate = vi.fn(async () => ({
      ok: false as const,
      blocked: true,
      reason: "This company's plan doesn't include cloud bots yet.",
      upgrade: { channelId: "chn_company", cardId: "upgrade_plan" },
    }));
    const onupgrade = vi.fn();
    const { oncomplete } = render({ oncreate, onupgrade });
    await openCompanyStep();
    document
      .querySelector<HTMLButtonElement>("[data-testid='new-bot-create-submit']")!
      .click();
    await settle();
    const step = document.querySelector("[data-testid='new-bot-upgrade']")!;
    expect(step.textContent).toContain("Current company is on the Starter plan");
    expect(document.querySelector("[data-testid='new-bot-create-screen']")).toBeNull();
    expect(oncomplete).not.toHaveBeenCalled();
    step.querySelector<HTMLButtonElement>("[data-testid='new-bot-upgrade-open']")!.click();
    expect(onupgrade).toHaveBeenCalledWith({
      companyUid: "cmp_current",
      channelId: "chn_company",
      cardId: "upgrade_plan",
    });
    const back = step.querySelector<HTMLButtonElement>("[data-testid='new-bot-upgrade-back']")!;
    expect(back.textContent).toBe("Choose another company");
    back.click();
    await settle();
    expect(document.querySelector("[data-testid='new-bot-upgrade']")).toBeNull();
    expect(document.querySelector("[data-testid='new-bot-step-3']")).toBeTruthy();
    expect(document.querySelector("[role='alert']")).toBeNull();
  });
  it("keeps a plan refusal as an inline message when the host offers no upgrade route", async () => {
    const oncreate = vi.fn(async () => ({
      ok: true as const,
      target: { channelId: "chn_company", cardId: "upgrade_plan", cardKind: null },
    }));
    const { oncomplete } = render({ oncreate });
    await openCompanyStep();
    document
      .querySelector<HTMLButtonElement>("[data-testid='new-bot-create-submit']")!
      .click();
    await settle();
    expect(oncomplete).not.toHaveBeenCalled();
    expect(document.querySelector("[data-testid='new-bot-upgrade']")).toBeNull();
    expect(document.querySelector("[role='alert']")?.textContent).toContain(
      "plan doesn't include cloud bots",
    );
  });
  it("replaces the form with the creating view while the request is in flight", async () => {
    let finish: (value: unknown) => void = () => {};
    const oncreate = vi.fn(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    const { oncomplete } = render({ oncreate });
    await settle();
    await advanceName();
    document
      .querySelector<HTMLButtonElement>("[data-testid='new-bot-continue-brain']")!
      .click();
    await settle();
    document
      .querySelector<HTMLButtonElement>("[data-testid='new-bot-create-submit']")!
      .click();
    await settle();
    const creating = document.querySelector("[data-testid='new-bot-creating']");
    expect(creating?.textContent).toContain("Waking up Polar");
    expect(document.querySelector("[data-testid='new-bot-create-screen']")).toBeNull();
    const bar = creating?.querySelector("[role='progressbar']");
    expect(bar?.getAttribute("aria-label")).toBe("Creating Polar");
    expect(bar?.getAttribute("data-mode")).toBe("creating");
    // The sun is told its mark once and eases there in its own frame loop.
    expect(bar?.getAttribute("aria-valuenow")).toBe("8");
    finish({
      ok: true,
      target: { channelId: "chn_bot", cardId: null, cardKind: null },
    });
    await settle();
    expect(oncomplete).toHaveBeenCalledTimes(1);
  });
  it("creeps the creating sun with one state change, never a repeating timer", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    try {
      let finish: (value: unknown) => void = () => {};
      const oncreate = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
      render({ oncreate });
      await settle();
      await advanceName();
      document.querySelector<HTMLButtonElement>("[data-testid='new-bot-continue-brain']")!.click();
      await settle();
      document.querySelector<HTMLButtonElement>("[data-testid='new-bot-create-submit']")!.click();
      await settle();
      const bar = document.querySelector("[data-testid='new-bot-creating'] [role='progressbar']");
      expect(bar?.getAttribute("aria-valuenow")).toBe("8");
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(bar?.getAttribute("aria-valuenow")).toBe("8");
      expect(interval).not.toHaveBeenCalled();
      finish({ ok: true, target: { channelId: "chn_bot", cardId: null, cardKind: null } });
      await settle();
    } finally {
      interval.mockRestore();
    }
  });
  async function openCompanyStep(): Promise<void> {
    await settle();
    await advanceName();
    document
      .querySelector<HTMLButtonElement>(
        "[data-testid='new-bot-continue-brain']",
      )!
      .click();
    await settle();
  }
  function manyCompanies(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      companyUid: `cmp_${index}`,
      label: `Company ${String(index).padStart(2, "0")}`,
    }));
  }
  it("renders companies as one radio group of tiles and keeps Create bot outside the scroll region", async () => {
    render();
    await openCompanyStep();
    const grid = document.querySelector<HTMLElement>(
      "[data-testid='new-bot-company-grid']",
    )!;
    expect(grid.getAttribute("role")).toBe("radiogroup");
    const tiles = [...grid.querySelectorAll<HTMLButtonElement>("[role='radio']")];
    expect(tiles.map((tile) => tile.dataset.companyUid)).toEqual([
      "cmp_current",
      "cmp_other",
    ]);
    expect(tiles[0]!.getAttribute("aria-checked")).toBe("true");
    expect(tiles[0]!.title).toBe("Current company");
    tiles[1]!.click();
    await settle();
    expect(tiles[1]!.getAttribute("aria-checked")).toBe("true");
    expect(tiles[0]!.getAttribute("aria-checked")).toBe("false");
    const scroll = document.querySelector("[data-testid='new-bot-create-scroll']")!;
    const create = document.querySelector("[data-testid='new-bot-create-submit']")!;
    expect(scroll.contains(grid)).toBe(true);
    expect(scroll.contains(create)).toBe(false);
  });
  it("moves focus across the grid with arrow keys without changing the selection", async () => {
    render({ companies: manyCompanies(9), currentCompanyUid: "cmp_0" });
    await openCompanyStep();
    const grid = document.querySelector<HTMLElement>(
      "[data-testid='new-bot-company-grid']",
    )!;
    const press = (key: string) =>
      (document.activeElement ?? grid).dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true }),
      );
    grid.querySelector<HTMLButtonElement>("[data-company-uid='cmp_0']")!.focus();
    press("ArrowRight");
    await settle();
    expect((document.activeElement as HTMLElement).dataset.companyUid).toBe("cmp_1");
    press("ArrowDown");
    await settle();
    expect((document.activeElement as HTMLElement).dataset.companyUid).toBe("cmp_4");
    expect(
      grid
        .querySelector("[data-company-uid='cmp_0']")!
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
  it("offers a filter only above 12 companies and keeps the selection while filtering", async () => {
    render({ companies: manyCompanies(12), currentCompanyUid: "cmp_0" });
    await openCompanyStep();
    expect(
      document.querySelector("[data-testid='new-bot-company-filter']"),
    ).toBeNull();
    if (component) await unmount(component);
    component = null;
    host.remove();
    const { oncreate } = render({
      companies: manyCompanies(14),
      currentCompanyUid: "cmp_3",
    });
    await openCompanyStep();
    const filter = document.querySelector<HTMLInputElement>(
      "[data-testid='new-bot-company-filter']",
    )!;
    filter.value = "13";
    filter.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();
    const visible = [
      ...document.querySelectorAll<HTMLElement>(
        "[data-testid='new-bot-company-grid'] [role='radio']",
      ),
    ];
    expect(visible.map((tile) => tile.dataset.companyUid)).toEqual(["cmp_13"]);
    filter.value = "zzz";
    filter.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();
    expect(
      document.querySelector("[data-testid='new-bot-company-grid']")?.textContent,
    ).toContain("No company matches that.");
    document
      .querySelector<HTMLButtonElement>("[data-testid='new-bot-create-submit']")!
      .click();
    await settle();
    expect(oncreate).toHaveBeenCalledWith("cmp_3", expect.anything());
  });
});
