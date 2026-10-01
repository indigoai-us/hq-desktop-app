// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import NewBotCreateScreen from "./NewBotCreateScreen.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const options = {
  defaultInstanceType: "t4g.medium",
  catalogVersion: "test",
  options: [{
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
  }],
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
      companies: [{ companyUid: "cmp_current", label: "Current company" }, { companyUid: "cmp_other", label: "Other company" }],
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

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("NewBotCreateScreen", () => {
  it("derives a handle, defaults to the current company, and preselects the signed-in brain", async () => {
    render();
    await settle();

    const input = document.querySelector<HTMLInputElement>("[data-testid='new-bot-name']")!;
    input.value = "Polar Bear";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();

    expect(document.querySelector("[data-testid='new-bot-derived-handle']")?.textContent).toContain("@polar-bear");
    expect(document.querySelector<HTMLSelectElement>("[data-testid='new-bot-company']")?.value).toBe("cmp_current");
    expect(document.querySelector<HTMLInputElement>("input[value='codex']")?.checked).toBe(true);
    expect(document.querySelector("[data-testid='new-bot-default-price']")?.textContent).toContain("$50.00/month");
  });

  it("shows a plain name problem without sending a request", async () => {
    const { oncreate } = render();
    await settle();

    document.querySelector<HTMLButtonElement>("[data-testid='new-bot-create-submit']")!.click();
    await settle();

    expect(document.querySelector("[role='alert']")?.textContent).toBe("Give your bot a name.");
    expect(oncreate).not.toHaveBeenCalled();
  });

  it("sends one subscription-only create request when clicked twice", async () => {
    const pending: { resolve: ((value: { ok: true; target: { channelId: string; cardId: null; cardKind: null } }) => void) | null } = { resolve: null };
    const oncreate = vi.fn(() => new Promise<{ ok: true; target: { channelId: string; cardId: null; cardKind: null } }>((resolve) => { pending.resolve = resolve; }));
    const { oncomplete } = render({ oncreate });
    await settle();

    const input = document.querySelector<HTMLInputElement>("[data-testid='new-bot-name']")!;
    input.value = "Polar";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();
    const create = document.querySelector<HTMLButtonElement>("[data-testid='new-bot-create-submit']")!;
    create.click();
    create.click();

    expect(oncreate).toHaveBeenCalledOnce();
    expect(oncreate).toHaveBeenCalledWith("cmp_current", expect.objectContaining({
      name: "Polar",
      handle: "polar",
      runtime: "codex",
      size: "basic",
      authMode: "subscription",
    }));
    pending.resolve?.({ ok: true, target: { channelId: "chn_bot", cardId: null, cardKind: null } });
    await settle();
    expect(oncomplete).toHaveBeenCalledOnce();
  });

  it("uses the chosen company and Claude when creating", async () => {
    const oncreate = vi.fn(async () => ({
      ok: true as const,
      target: { channelId: "chn_bot", cardId: null, cardKind: null },
    }));
    render({ oncreate, runtimeReady: { codex: false, claude: true, grok: false } });
    await settle();

    const input = document.querySelector<HTMLInputElement>("[data-testid='new-bot-name']")!;
    input.value = "Claude bot";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const company = document.querySelector<HTMLSelectElement>("[data-testid='new-bot-company']")!;
    company.value = "cmp_other";
    company.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    document.querySelector<HTMLButtonElement>("[data-testid='new-bot-create-submit']")!.click();
    await settle();

    expect(oncreate).toHaveBeenCalledWith("cmp_other", expect.objectContaining({
      runtime: "claude",
      authMode: "subscription",
    }));
  });

  it("creates in the only available company", async () => {
    const oncreate = vi.fn(async () => ({
      ok: true as const,
      target: { channelId: "chn_bot", cardId: null, cardKind: null },
    }));
    render({
      companies: [{ companyUid: "cmp_only", label: "Only company" }],
      currentCompanyUid: "cmp_only",
      oncreate,
    });
    await settle();

    const input = document.querySelector<HTMLInputElement>("[data-testid='new-bot-name']")!;
    input.value = "Only bot";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>("[data-testid='new-bot-create-submit']")!.click();
    await settle();

    expect(oncreate).toHaveBeenCalledWith("cmp_only", expect.objectContaining({ name: "Only bot" }));
  });

  it("keeps a server refusal inline and offers advanced fields without requiring them", async () => {
    const oncreate = vi.fn(async () => ({
        ok: false as const,
        blocked: true,
        reason: "Your company has reached its bot limit.",
      }));
    render({ oncreate });
    await settle();

    const input = document.querySelector<HTMLInputElement>("[data-testid='new-bot-name']")!;
    input.value = "Polar";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>("[data-testid='new-bot-create-submit']")!.click();
    await settle();

    expect(oncreate).toHaveBeenCalledOnce();
    expect(document.querySelector("[role='alert']")?.textContent).toBe(
      "Your company has reached its bot limit.",
    );

    document.querySelector<HTMLButtonElement>(".new-bot-more")!.click();
    await settle();
    expect(document.querySelector('[data-testid="new-bot-advanced-options"]')).toBeTruthy();
  });
});
