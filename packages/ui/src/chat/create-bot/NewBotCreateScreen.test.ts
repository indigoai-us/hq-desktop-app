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
      .querySelector<HTMLInputElement>("input[value='cmp_other']")!
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
    const create = document.querySelector<HTMLButtonElement>(
      "[data-testid='new-bot-create-submit']",
    )!;
    create.click();
    await settle();
    expect(document.querySelector("[role='alert']")?.textContent).toContain(
      "The server didn't send",
    );
    expect(create.disabled).toBe(false);
    create.click();
    await settle();
    expect(oncreate).toHaveBeenCalledTimes(2);
  });
});
