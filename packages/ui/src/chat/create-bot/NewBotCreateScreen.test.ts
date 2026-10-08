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
      // The name is the takeover's first step; this screen opens on the brain.
      name: "Polar",
      ...overrides,
    },
  });
  return { oncreate, oncomplete };
}
/** The name was given on the takeover's first step: the screen opens on the brain. */
async function advanceName(): Promise<void> {
  await settle();
}
afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("NewBotCreateScreen", () => {
  it("never asks for the name again: it opens on the brain, names the bot in the identity line, and never renders the handle", async () => {
    render();
    await settle();
    expect(document.querySelector("[data-testid='new-bot-name']")).toBeNull();
    expect(document.querySelector("[data-testid='new-bot-step-2']")).toBeTruthy();
    expect(document.querySelector("[data-testid='bot-identity-name']")?.textContent).toBe("Polar");
    expect(document.querySelector("[data-testid='bot-identity-meta']")?.textContent).toBe("Cloud");
    expect(
      document.querySelector("[data-testid='new-bot-derived-handle']"),
    ).toBeNull();
    expect(document.querySelector(".new-bot-name-row")).toBeNull();
    expect(document.querySelector("#new-bot-handle")).toBeNull();
    // The dots count the takeover's name and where steps too, and the
    // optional company and size steps.
    expect(document.querySelector("[data-testid='new-bot-progress']")?.getAttribute("aria-label")).toBe("Step 3 of 5");
  });
  it("preselects the signed-in brain; Next: Company, then Next: Size, and the last step has only Create <Name>", async () => {
    render();
    await settle();
    const codex = document.querySelector<HTMLInputElement>("input[value='codex']")!;
    expect(codex.checked).toBe(true);
    // Several companies: "Next: Company" and "Finish with defaults", side by side.
    expect(document.querySelector("[data-testid='new-bot-continue-brain']")?.textContent?.trim()).toBe("Next: Company");
    expect(document.querySelector("[data-testid='new-bot-create-submit']")?.textContent?.trim()).toBe("Finish with defaults");
    expect(document.querySelector(".new-bot-foot-actions")?.children).toHaveLength(2);
    document.querySelector<HTMLButtonElement>("[data-testid='new-bot-continue-brain']")!.click();
    await settle();
    expect(document.querySelector("[data-testid='new-bot-step-3']")).toBeTruthy();
    expect(document.querySelector("[data-testid='new-bot-progress']")?.getAttribute("aria-label")).toBe("Step 4 of 5");
    expect(document.querySelector("[data-testid='bot-identity-meta']")?.textContent).toBe("Cloud · Current company");
    expect(document.querySelector("[data-testid='new-bot-continue-brain']")).toBeNull();
    // The company step: no "More options" link; the size is its own step.
    expect(document.querySelector(".new-bot-more")).toBeNull();
    expect(document.querySelector("[data-testid='new-bot-continue-company']")?.textContent?.trim()).toBe("Next: Size");
    expect(document.querySelector("[data-testid='new-bot-create-submit']")?.textContent?.trim()).toBe("Finish with defaults");
    document.querySelector<HTMLButtonElement>("[data-testid='new-bot-continue-company']")!.click();
    await settle();
    expect(document.querySelector("[data-testid='new-bot-step-4']")).toBeTruthy();
    expect(document.querySelector("[data-testid='new-bot-progress']")?.getAttribute("aria-label")).toBe("Step 5 of 5");
    expect(document.querySelector("input[name='new-bot-size']")).toBeTruthy();
    expect(document.querySelector("[data-testid='new-bot-continue-company']")).toBeNull();
    expect(document.querySelector(".new-bot-foot-actions")?.children).toHaveLength(1);
    expect(document.querySelector("[data-testid='new-bot-create-submit']")?.textContent?.trim()).toBe("Create Polar");
    // Back walks the steps in order.
    document.querySelector<HTMLButtonElement>(".new-bot-back")!.click();
    await settle();
    expect(document.querySelector("[data-testid='new-bot-step-3']")).toBeTruthy();
    document.querySelector<HTMLButtonElement>(".new-bot-back")!.click();
    await settle();
    expect(document.querySelector("[data-testid='new-bot-step-2']")).toBeTruthy();
  });

  it("Enter on the brain step finishes with defaults: the brain shown, in the company it opened on", async () => {
    const { oncreate } = render();
    await settle();
    const codex = document.querySelector<HTMLInputElement>("input[value='codex']")!;
    codex.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(oncreate).toHaveBeenCalledWith("cmp_current", expect.objectContaining({ name: "Polar", runtime: "codex" }));
  });
  it("counts one step before it when the where question was not asked", async () => {
    render({ leadSteps: 1, companies: [{ companyUid: "cmp_only", label: "Only company" }], currentCompanyUid: "cmp_only" });
    await settle();
    // One company: the brain, then the optional size.
    expect(document.querySelector("[data-testid='new-bot-progress']")?.getAttribute("aria-label")).toBe("Step 2 of 3");
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

    it("says there is no price when the options load and none of them is priced, and offers Try again (review item 7)", async () => {
      // The read succeeded, so nothing said why Create bot was off.
      const unpriced = {
        ...options,
        options: options.options.map((option) => ({ ...option, netMonthlyCents: null, unavailableReason: "per-agent-rung-reprice-unshipped" })),
      };
      const loadProvisionOptions = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, value: unpriced })
        .mockResolvedValueOnce({ ok: true, value: options });
      const { oncreate } = render({ ...ONE_COMPANY, loadProvisionOptions });
      await settle();
      await advanceName();

      expect(createButton().disabled).toBe(true);
      expect(problem()?.getAttribute("role")).toBe("alert");
      expect(problem()?.dataset.kind).toBe("unpriced");
      expect(problem()?.textContent).toBe("We don't have a price for a bot in Only company right now. Try again in a moment.");
      // The server's own word for why is not shown to the person.
      expect(problem()?.textContent).not.toContain("reprice");
      expect(retry()?.textContent).toBe("Try again");

      retry()!.click();
      await settle();
      expect(loadProvisionOptions).toHaveBeenCalledTimes(2);
      expect(problem()).toBeNull();
      expect(createButton().disabled).toBe(false);
      createButton().click();
      await settle();
      expect(oncreate).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["has no options at all", []],
      ["has a priced size the person may not pick", [{ ...options.options[0]!, selectable: false }]],
    ])("says there is no price when the list %s", async (_label, list) => {
      render({ ...ONE_COMPANY, loadProvisionOptions: async () => ({ ok: true as const, value: { ...options, options: list } }) });
      await settle();
      await advanceName();
      expect(createButton().disabled).toBe(true);
      expect(problem()?.dataset.kind).toBe("unpriced");
      expect(retry()).toBeTruthy();
    });

    it("shows no such line while the options are loading or once one size is priced", async () => {
      let answer!: (value: unknown) => void;
      render({ ...ONE_COMPANY, loadProvisionOptions: () => new Promise((resolve) => { answer = resolve; }) });
      await settle();
      await advanceName();
      expect(problem()).toBeNull();
      answer({
        ok: true,
        value: { ...options, options: [{ ...options.options[0]!, key: "power", netMonthlyCents: null }, options.options[0]!] },
      });
      await settle();
      expect(problem()).toBeNull();
      expect(createButton().disabled).toBe(false);
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
  describe("review findings on the create screen", () => {
    const ONE_COMPANY = { companies: [{ companyUid: "cmp_only", label: "Only company" }], currentCompanyUid: "cmp_only" };
    const POWER = { ...options.options[0]!, key: "power" as const, productName: "Power", default: false, netMonthlyCents: 9000, listCents: 9000 };
    const createButton = () => document.querySelector<HTMLButtonElement>("[data-testid='new-bot-create-submit']")!;
    const price = () => document.querySelector("[data-testid='new-bot-price']")?.textContent;

    it("A-I2: Enter in the company filter picks a single match and never creates the bot", async () => {
      // Enter used to submit the create into the company selected before the
      // filter was typed, which may not even be among the ones shown.
      const { oncreate } = render({ companies: manyCompanies(14), currentCompanyUid: "cmp_3" });
      await openCompanyStep();
      const filter = document.querySelector<HTMLInputElement>("[data-testid='new-bot-company-filter']")!;
      const pressEnter = () => filter.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      const checked = () => document.querySelector<HTMLElement>("[data-testid='new-bot-company-grid'] [aria-checked='true']")?.dataset.companyUid;

      // Several matches: Enter does nothing.
      filter.value = "Company 1";
      filter.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await settle();
      pressEnter();
      await settle();
      expect(oncreate).not.toHaveBeenCalled();
      expect(checked()).toBeUndefined();

      // One match: Enter selects it, and still does not create.
      filter.value = "13";
      filter.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await settle();
      pressEnter();
      await settle();
      expect(oncreate).not.toHaveBeenCalled();
      expect(checked()).toBe("cmp_13");

      // No match: nothing happens.
      filter.value = "zzz";
      filter.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await settle();
      pressEnter();
      await settle();
      expect(oncreate).not.toHaveBeenCalled();

      createButton().click();
      await settle();
      expect(oncreate).toHaveBeenCalledWith("cmp_13", expect.anything());
    });

    it("A-I3: the price under Create bot is the selected size's, not the default's", async () => {
      const { oncreate } = render({
        loadProvisionOptions: async () => ({ ok: true as const, value: { ...options, options: [options.options[0]!, POWER] } }),
      });
      await openCompanyStep();
      expect(price()).toBe("$50.00/month for Basic.");
      document.querySelector<HTMLButtonElement>("[data-testid='new-bot-continue-company']")!.click();
      await settle();
      document.querySelector<HTMLInputElement>("input[name='new-bot-size'][value='power']")!.click();
      await settle();
      expect(price()).toBe("$90.00/month for Power.");
      createButton().click();
      await settle();
      expect(oncreate).toHaveBeenCalledWith("cmp_current", expect.objectContaining({ size: "power" }));
    });

    it("A-I3: shows the selected size's price when the server flags no default", async () => {
      render({ ...ONE_COMPANY, loadProvisionOptions: async () => ({ ok: true as const, value: { ...options, options: [POWER] } }) });
      await settle();
      await advanceName();
      expect(price()).toBe("$90.00/month for Power.");
    });

    it("A-I6: holds Create bot for a name that makes no handle, before anything is sent", async () => {
      // A name with no ASCII letter or digit makes an empty handle. The
      // server refused it only after the create had begun. The takeover's
      // name step refuses it; this screen holds Create if one arrives anyway.
      const { oncreate } = render({ ...ONE_COMPANY, name: "日本語" });
      await settle();
      createButton().click();
      await settle();
      expect(document.querySelector("[data-testid='new-bot-name-unusable']")?.textContent).toBe(
        "That name can't be used for a bot. Try letters and numbers.",
      );
      expect(oncreate).not.toHaveBeenCalled();
    });

    it("A-I10: shows the whole reason for a refusal, not only its first sentence", async () => {
      const reason = "A bot with that name already exists in this company. Try a different name.";
      render({ ...ONE_COMPANY, oncreate: vi.fn(async () => ({ ok: false as const, blocked: false, reason })) });
      await settle();
      await advanceName();
      createButton().click();
      await settle();
      expect(document.querySelector("#new-bot-create-issue")?.textContent).toBe(reason);
    });

    it("A-I13: names the machine the app runs on, not always a Mac", async () => {
      const globals = globalThis as { __HQ_HOST_OS__?: string };
      const before = globals.__HQ_HOST_OS__;
      globals.__HQ_HOST_OS__ = "windows";
      try {
        render(ONE_COMPANY);
        await settle();
        await advanceName();
        const signedIn = document.querySelector("[data-testid='new-bot-step-2'] small")?.textContent;
        expect(signedIn).toBe("Signed in on this PC");
      } finally {
        if (before === undefined) delete globals.__HQ_HOST_OS__;
        else globals.__HQ_HOST_OS__ = before;
      }
    });

    it("A-I16: never calls a card that is not the upgrade card an upgrade", async () => {
      // The server can send the person to any card. Every one of them was
      // shown as "is on the Starter plan".
      const onupgrade = vi.fn();
      const oncreate = vi.fn(async () => ({
        ok: true as const,
        target: { channelId: "chn_company", cardId: "activate_cloud", cardKind: null },
      }));
      const { oncomplete } = render({ ...ONE_COMPANY, oncreate, onupgrade });
      await settle();
      await advanceName();
      createButton().click();
      await settle();
      const step = document.querySelector<HTMLElement>("[data-testid='new-bot-upgrade']")!;
      expect(step.dataset.kind).toBe("other");
      expect(step.textContent).not.toMatch(/Starter plan|Upgrade|Workforce/);
      expect(step.querySelector("[data-testid='new-bot-upgrade-copy']")?.textContent).toBe(
        "Only company has a step to finish before it can add a cloud bot. Open the company's channel to see it, then come back to create Polar.",
      );
      const open = step.querySelector<HTMLButtonElement>("[data-testid='new-bot-upgrade-open']")!;
      expect(open.textContent).toBe("Open the channel");
      open.click();
      expect(onupgrade).toHaveBeenCalledWith({ companyUid: "cmp_only", channelId: "chn_company", cardId: "activate_cloud" });
      expect(oncomplete).not.toHaveBeenCalled();
    });

    it("A-I16: keeps the upgrade wording for the upgrade card itself", async () => {
      const oncreate = vi.fn(async () => ({
        ok: true as const,
        target: { channelId: "chn_company", cardId: "upgrade_plan", cardKind: null },
      }));
      render({ ...ONE_COMPANY, oncreate, onupgrade: vi.fn() });
      await settle();
      await advanceName();
      createButton().click();
      await settle();
      const step = document.querySelector<HTMLElement>("[data-testid='new-bot-upgrade']")!;
      expect(step.dataset.kind).toBe("plan");
      expect(step.textContent).toContain("Only company is on the Starter plan");
      expect(step.querySelector("[data-testid='new-bot-upgrade-open']")?.textContent).toBe("See upgrade options");
    });

    it("A-I16: says a neutral line inline when the host offers no way to open the card", async () => {
      const oncreate = vi.fn(async () => ({
        ok: true as const,
        target: { channelId: "chn_company", cardId: "activate_cloud", cardKind: null },
      }));
      render({ ...ONE_COMPANY, oncreate });
      await settle();
      await advanceName();
      createButton().click();
      await settle();
      expect(document.querySelector("#new-bot-create-issue")?.textContent).toBe(
        "This company has a step to finish before it can add a cloud bot.",
      );
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
    await settle();
    document
      .querySelector<HTMLButtonElement>(
        "[data-testid='new-bot-continue-brain']",
      )!
      .click();
    await settle();
    expect(
      document.querySelector<HTMLButtonElement>("[data-company-uid='cmp_other']")?.getAttribute("aria-checked"),
    ).toBe("true");
    document.querySelector<HTMLButtonElement>(".new-bot-back")!.click();
    await settle();
    expect(document.querySelector<HTMLInputElement>("input[value='claude']")?.checked).toBe(true);
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
  it("never grows the grid past four rows: the filter finds the rest, and the picked company stays in view", async () => {
    render({ companies: manyCompanies(20), currentCompanyUid: "cmp_17" });
    await openCompanyStep();
    const shown = () =>
      [...document.querySelectorAll<HTMLElement>("[data-testid='new-bot-company-grid'] [role='radio']")].map(
        (tile) => tile.dataset.companyUid,
      );
    expect(shown()).toHaveLength(12);
    expect(shown()).toContain("cmp_17");
    expect(shown().slice(0, 11)).toEqual(Array.from({ length: 11 }, (_, index) => `cmp_${index}`));
    expect(document.querySelector("[data-testid='new-bot-company-more']")?.textContent).toBe("8 more. Type to find them.");
    const filter = document.querySelector<HTMLInputElement>("[data-testid='new-bot-company-filter']")!;
    filter.value = "Company 1";
    filter.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();
    // Company 10 to 19: ten matches, all shown, no "more" line.
    expect(shown()).toEqual(Array.from({ length: 10 }, (_, index) => `cmp_${index + 10}`));
    expect(document.querySelector("[data-testid='new-bot-company-more']")).toBeNull();
  });
});

describe("NewBotCreateScreen: which company the bot is created in (review G-1)", () => {
  const line = (): string =>
    document.querySelector("[data-testid='new-bot-price']")?.textContent?.replace(/\s+/g, " ").trim() ?? "";

  it("names the only company it offers on the last step, for a person with more than one company", async () => {
    const { oncreate } = render({
      companies: [{ companyUid: "cmp_current", label: "Current company" }],
      nameCompany: true,
    });
    await settle();
    await advanceName();
    // One company on the list: no picker, and the brain step is the last one.
    expect(document.querySelector("[data-testid='new-bot-company-grid']")).toBeNull();
    expect(line()).toBe("$50.00/month for Basic, billed to Current company.");
    document.querySelector<HTMLButtonElement>("[data-testid='new-bot-create-submit']")!.click();
    await settle();
    expect(oncreate).toHaveBeenCalledWith("cmp_current", expect.objectContaining({ name: "Polar" }));
  });

  it("names the picked company on the last step, and follows the pick", async () => {
    render({ nameCompany: true });
    await settle();
    await advanceName();
    // On the brain step Finish with defaults would create in the company the
    // screen opened on, so it says which.
    expect(line()).toBe("$50.00/month for Basic, billed to Current company.");
    document.querySelector<HTMLButtonElement>("[data-testid='new-bot-continue-brain']")!.click();
    await settle();
    expect(line()).toBe("$50.00/month for Basic, billed to Current company.");
    document.querySelector<HTMLButtonElement>("[data-company-uid='cmp_other']")!.click();
    await settle();
    expect(line()).toBe("$50.00/month for Basic, billed to Other company.");
  });

  it("says nothing about the company to a person who has only one", async () => {
    render({ companies: [{ companyUid: "cmp_current", label: "Current company" }] });
    await settle();
    await advanceName();
    expect(line()).toBe("$50.00/month for Basic.");
  });

  it("says Checking plan... in the plan line's place until the plan answers, then one short line and no other status", async () => {
    let answer!: (value: { ok: true; value: typeof options }) => void;
    render({
      nameCompany: true,
      loadProvisionOptions: () => new Promise((resolve) => { answer = resolve; }),
    });
    await settle();
    const plan = document.querySelector("[data-testid='new-bot-price']");
    expect(plan?.textContent).toBe("Checking plan...");
    expect(plan?.getAttribute("data-state")).toBe("checking");
    answer({ ok: true, value: { ...options, options: [{ ...options.options[0]!, notBilled: true, netMonthlyCents: 0 }] } });
    await settle();
    await settle();
    // The same element, now with the plan: nothing is added or moved.
    expect(document.querySelector("[data-testid='new-bot-price']")).toBe(plan);
    expect(plan?.textContent).toBe("Included with Current company's plan.");
    expect(plan?.getAttribute("data-state")).toBe("ready");
    expect(document.querySelectorAll(".new-bot-create-foot .new-bot-price, footer .new-bot-price")).toHaveLength(1);
    expect(document.querySelector("[data-testid='new-bot-target-company']")).toBeNull();
    // The line sits above the buttons.
    const foot = plan!.parentElement!;
    const children = [...foot.children];
    expect(children.indexOf(plan!)).toBeLessThan(children.indexOf(foot.querySelector(".new-bot-foot-actions")!));
  });

  it("labels the second way out as the host says, and keeps the local label without one", async () => {
    render({ onopenlocal: () => {}, otherWayLabel: "Another company or a local bot" });
    await settle();
    expect(document.querySelector("[data-testid='new-bot-takeover-local']")?.textContent?.trim()).toBe(
      "Another company or a local bot",
    );
    if (component) await unmount(component);
    component = null;
    host.remove();
    render({ onopenlocal: () => {} });
    await settle();
    expect(document.querySelector("[data-testid='new-bot-takeover-local']")?.textContent?.trim()).toBe(
      "Create a local bot instead",
    );
  });
});

describe("NewBotCreateScreen: a create that is being looked for (review G-2)", () => {
  it("says it is checking, and offers no Create bot, while the host looks for the bot", async () => {
    type Refusal = { ok: false; blocked: false; reason: string };
    let finish!: (result: Refusal) => void;
    const oncreate = vi.fn(() => new Promise<Refusal>((resolve) => { finish = resolve; }));
    const status = (): HTMLElement | null => document.querySelector("[data-testid='new-bot-creating-status']");
    const one = { companies: [{ companyUid: "cmp_current", label: "Current company" }], oncreate };

    // The create is out: the usual line.
    render(one);
    await settle();
    await advanceName();
    document.querySelector<HTMLButtonElement>("[data-testid='new-bot-create-submit']")!.click();
    await settle();
    expect(status()?.textContent?.trim()).toBe("Getting things ready.");
    expect(status()?.getAttribute("data-state")).toBe("creating");

    // The same, with the host looking for the bot.
    if (component) await unmount(component);
    component = null;
    host.remove();
    render({ ...one, checking: true });
    await settle();
    await advanceName();
    document.querySelector<HTMLButtonElement>("[data-testid='new-bot-create-submit']")!.click();
    await settle();
    expect(status()?.textContent?.trim()).toBe("Checking whether Polar was created...");
    expect(status()?.getAttribute("data-state")).toBe("checking");
    // Nothing can be sent again while the look is out.
    expect(document.querySelector("[data-testid='new-bot-create-submit']")).toBeNull();
    expect(oncreate).toHaveBeenCalledTimes(2);

    finish({ ok: false, blocked: false, reason: "We didn't hear back." });
    await settle();
    expect(document.querySelector("[data-testid='new-bot-create-submit']")).toBeTruthy();
  });
});
