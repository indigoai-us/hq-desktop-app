// @vitest-environment happy-dom

/**
 * The New Bot create screen when its list of companies changes while it is
 * open (round 4, item 5). These tests change props on a mounted screen, so
 * they live in a runes test file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import NewBotCreateScreen from "./NewBotCreateScreen.svelte";
import type { EntryPointResult } from "../lifecycle-entry-points.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const OPTIONS = {
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

const CURRENT = { companyUid: "cmp_current", label: "Current company" };
const OTHER = { companyUid: "cmp_other", label: "Other company" };
const THIRD = { companyUid: "cmp_third", label: "Third company" };

const GONE = "This company can't be used for a new bot right now. Close this screen and try again.";

async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

function createButton(): HTMLButtonElement {
  return q<HTMLButtonElement>("[data-testid='new-bot-create-submit']")!;
}

/** Name the bot and walk to the last step, where Create bot is. */
async function reachCreate(): Promise<void> {
  const input = q<HTMLInputElement>("[data-testid='new-bot-name']")!;
  input.value = "Polar";
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await settle();
  q<HTMLButtonElement>("[data-testid='new-bot-continue-name']")!.click();
  await settle();
  q<HTMLButtonElement>("[data-testid='new-bot-continue-brain']")!.click();
  await settle();
  await vi.waitFor(() => expect(createButton().disabled).toBe(false));
}

/** Every way the screen sends a create: the button, and Enter. */
async function tryToCreate(): Promise<void> {
  createButton().click();
  await settle();
  q("[data-testid='new-bot-step-3']")!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  await settle();
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("NewBotCreateScreen: the selected company leaves the list while the screen is open", () => {
  function render(companies: Array<{ companyUid: string; label: string }>) {
    host = document.createElement("div");
    document.body.appendChild(host);
    const oncreate = vi.fn(async (): Promise<EntryPointResult> => ({
      ok: true,
      target: { channelId: "chn_bot", cardId: null, cardKind: null },
    }));
    const props = $state({
      companies,
      currentCompanyUid: "cmp_current",
      runtimeReady: { codex: true, claude: false, grok: false },
      loadProvisionOptions: async () => ({ ok: true as const, value: OPTIONS }),
      oncreate,
      oncomplete: vi.fn(),
    });
    component = mount(NewBotCreateScreen, { target: host, props });
    return { props, oncreate };
  }

  it("sends nothing, turns Create bot off and says why", async () => {
    const { props, oncreate } = render([CURRENT, OTHER, THIRD]);
    await settle();
    await reachCreate();
    expect(q("[data-testid='new-bot-company-gone']")).toBeNull();

    // The selected company is no longer offered.
    props.companies = [OTHER, THIRD];
    await settle();

    expect(createButton().disabled).toBe(true);
    const line = q("[data-testid='new-bot-company-gone']");
    expect(line?.textContent?.trim()).toBe(GONE);
    expect(line?.getAttribute("role")).toBe("alert");
    await tryToCreate();
    expect(oncreate).not.toHaveBeenCalled();

    // A company that is still offered can be picked, and the create goes there.
    q<HTMLButtonElement>("[data-company-uid='cmp_other']")!.click();
    await settle();
    await vi.waitFor(() => expect(createButton().disabled).toBe(false));
    expect(q("[data-testid='new-bot-company-gone']")).toBeNull();
    createButton().click();
    await settle();
    expect(oncreate).toHaveBeenCalledTimes(1);
    expect(oncreate.mock.calls[0]![0]).toBe("cmp_other");
  });

  it("sends nothing when only one other company is left", async () => {
    const { props, oncreate } = render([CURRENT, OTHER]);
    await settle();
    await reachCreate();

    props.companies = [OTHER];
    await settle();

    expect(createButton().disabled).toBe(true);
    expect(q("[data-testid='new-bot-company-gone']")?.textContent?.trim()).toBe(GONE);
    await tryToCreate();
    expect(oncreate).not.toHaveBeenCalled();
  });

  it("sends nothing when no company is left", async () => {
    const { props, oncreate } = render([CURRENT, OTHER]);
    await settle();
    await reachCreate();

    props.companies = [];
    await settle();

    expect(createButton().disabled).toBe(true);
    expect(q("[data-testid='new-bot-company-gone']")?.textContent?.trim()).toBe(GONE);
    await tryToCreate();
    expect(oncreate).not.toHaveBeenCalled();
  });
});
