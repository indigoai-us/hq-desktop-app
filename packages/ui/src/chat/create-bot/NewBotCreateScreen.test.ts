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
    render();
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
    finish({
      ok: true,
      target: { channelId: "chn_bot", cardId: null, cardKind: null },
    });
    await settle();
    expect(oncomplete).toHaveBeenCalledTimes(1);
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
