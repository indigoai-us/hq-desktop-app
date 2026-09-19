// @vitest-environment happy-dom

/**
 * Create a company from the palette, without leaving the modal.
 *
 * The typed name is offered as a company alongside the channel row; choosing
 * it opens a second step in the SAME card that renders the server's own
 * `create_company` fields plus an invite list. Back returns to the search step
 * with the query intact, and the card never changes size between the two.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import CreateModal from "./CreateModal.svelte";
import type { ChatSidebarApi } from "./chat-api.js";
import type {
  CompanyCreateSeam,
  CompanyDraftForm,
  CompanyInvite,
  CreateCompanyResult,
} from "./create-company/create-company-flow.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const $ = <T extends Element>(selector: string): T | null =>
  document.querySelector<T>(selector);

function stubApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "createcompanycursor0000000000000000",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: [],
    }),
    listContacts: async () => ({ contacts: [] }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => null,
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    searchMessages: async () => ({ results: [] }),
    createChannel: async () => ({ channelId: "chn_new" }),
    addChannelMember: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
  };
}

function form(overrides: Partial<CompanyDraftForm> = {}): CompanyDraftForm {
  return {
    channelId: "setup",
    cardId: "card_create_company_2",
    title: "Name your company",
    summary: "This creates the company channel, vault, and team roster.",
    actionId: "submit",
    nameFieldId: "name",
    fields: [
      {
        id: "name",
        label: "Company name",
        control: "text",
        options: [],
        value: "",
        required: true,
        error: null,
        hint: "Shown in the sidebar and on invites.",
        description: null,
      },
      {
        id: "slug",
        label: "Company address",
        control: "text",
        options: [],
        value: "test-12323",
        required: true,
        error: null,
        hint: null,
        description: null,
      },
    ],
    ...overrides,
  };
}

const created: CreateCompanyResult = {
  ok: true,
  company: {
    companyUid: "cmp_new",
    companyChannelId: "chn_company",
    inviteFailures: [],
  },
};

interface SeamCalls {
  submitted: Array<{
    values: Record<string, string>;
    invites: readonly CompanyInvite[];
  }>;
}

function seam(
  overrides: Partial<CompanyCreateSeam> = {},
): { seam: CompanyCreateSeam; calls: SeamCalls } {
  const calls: SeamCalls = { submitted: [] };
  return {
    calls,
    seam: {
      open: overrides.open ?? (async () => ({ ok: true, form: form() })),
      submit:
        overrides.submit ??
        (async (_form, values, invites) => {
          calls.submitted.push({ values, invites });
          return created;
        }),
    },
  };
}

function open(props: Record<string, unknown> = {}) {
  const onclose = vi.fn();
  component = mount(CreateModal, {
    target: host,
    props: {
      api: stubApi(),
      rows: [],
      contacts: [],
      scopeCompanies: [{ companyUid: "cmp_indigo", label: "Indigo" }],
      activeScope: "cmp_indigo",
      self: { uid: "prs_me", displayName: "Stefan" },
      onclose,
      onpick: () => {},
      oncreated: () => {},
      ...props,
    },
  });
  return { onclose };
}

function type(node: HTMLInputElement, value: string): void {
  node.value = value;
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(node: EventTarget, key: string, init: KeyboardEventInit = {}) {
  node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
}

async function settleQuery(): Promise<void> {
  await vi.advanceTimersByTimeAsync(150);
  await tick();
}

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function typeQuery(value: string): Promise<void> {
  // The debounce effect only exists once the first flush has run.
  await settle(2);
  type($<HTMLInputElement>('[data-testid="chat-create-query"]')!, value);
  await settleQuery();
}

async function gotoCompanyStep(name = "Test 12323"): Promise<void> {
  await typeQuery(name);
  $<HTMLButtonElement>('[data-testid="chat-create-company-row"]')!.click();
  await settle();
}

function field(id: string): HTMLInputElement {
  return $<HTMLInputElement>(`[data-testid="chat-create-company-field-${id}"]`)!;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.localStorage?.clear?.();
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document
    .querySelectorAll('[data-testid="chat-create-modal"]')
    .forEach((node) => node.remove());
  vi.useRealTimers();
});

describe("CreateModal — create company from the palette", () => {
  it("offers the typed name as a company next to the channel row", async () => {
    open({ companyCreate: seam().seam });
    await typeQuery("Test 12323");
    const row = $('[data-testid="chat-create-company-row"]');
    expect(row?.textContent).toContain("Create company Test 12323");
    expect($('[data-testid="chat-create-channel-row"]')?.textContent).toContain(
      "Create channel #test-12323",
    );
  });

  it("offers no company row when the host did not wire the flow", async () => {
    open();
    await typeQuery("Test 12323");
    expect($('[data-testid="chat-create-company-row"]')).toBeNull();
  });

  it("opens the second step with the typed name prefilled and focused", async () => {
    open({ companyCreate: seam().seam });
    await gotoCompanyStep();
    expect($('[data-testid="chat-create-company-step"]')).toBeTruthy();
    expect(field("name").value).toBe("Test 12323");
    // The server's own second field keeps the value the card carried.
    expect(field("slug").value).toBe("test-12323");
    await vi.advanceTimersByTimeAsync(50);
    expect(document.activeElement).toBe(field("name"));
  });

  it("the static New company row opens the same step, not #setup", async () => {
    const oncreatecompany = vi.fn();
    open({ companyCreate: seam().seam, oncreatecompany });
    await settle();
    $<HTMLButtonElement>('[data-testid="chat-create-new-company"]')!.click();
    await settle();
    expect($('[data-testid="chat-create-company-step"]')).toBeTruthy();
    expect(oncreatecompany).not.toHaveBeenCalled();
  });

  it("holds the primary action until every required field is filled", async () => {
    open({ companyCreate: seam().seam });
    await gotoCompanyStep();
    const submit = $<HTMLButtonElement>('[data-testid="chat-create-company-submit"]')!;
    expect(submit.disabled).toBe(false);
    type(field("name"), "   ");
    await settle();
    expect(
      $<HTMLButtonElement>('[data-testid="chat-create-company-submit"]')!.disabled,
    ).toBe(true);
  });

  it("creates the company with the card's fields and the invites typed", async () => {
    const { seam: wired, calls } = seam();
    const { onclose } = open({ companyCreate: wired });
    await gotoCompanyStep();
    const invite = $<HTMLInputElement>(
      '[data-testid="chat-create-company-invite-input"]',
    )!;
    type(invite, "ada@example.com");
    press(invite, "Enter");
    await settle();
    expect($('[data-testid="chat-create-company-invite"]')?.textContent).toContain(
      "ada@example.com",
    );
    $<HTMLButtonElement>('[data-testid="chat-create-company-submit"]')!.click();
    await settle();
    expect(calls.submitted).toEqual([
      {
        values: { name: "Test 12323", slug: "test-12323" },
        invites: [{ email: "ada@example.com", role: "member" }],
      },
    ]);
    expect(onclose).toHaveBeenCalled();
  });

  it("invites an address that was typed but never added", async () => {
    const { seam: wired, calls } = seam();
    open({ companyCreate: wired });
    await gotoCompanyStep();
    type(
      $<HTMLInputElement>('[data-testid="chat-create-company-invite-input"]')!,
      "grace@example.com",
    );
    await settle();
    $<HTMLButtonElement>('[data-testid="chat-create-company-submit"]')!.click();
    await settle();
    expect(calls.submitted[0]?.invites).toEqual([
      { email: "grace@example.com", role: "member" },
    ]);
  });

  it("shows the server's own reason inline and stays on the step", async () => {
    const { seam: wired } = seam({
      submit: async () => ({
        ok: false,
        reason: "The handle test-12323 is already taken.",
        blocked: true,
      }),
    });
    const { onclose } = open({ companyCreate: wired });
    await gotoCompanyStep();
    $<HTMLButtonElement>('[data-testid="chat-create-company-submit"]')!.click();
    await settle();
    expect($('[data-testid="chat-create-company-error"]')?.textContent).toContain(
      "The handle test-12323 is already taken.",
    );
    expect($('[data-testid="chat-create-company-step"]')).toBeTruthy();
    expect(onclose).not.toHaveBeenCalled();
  });

  it("reports the server's reason when the form itself cannot be opened", async () => {
    const { seam: wired } = seam({
      open: async () => ({ ok: false, reason: "Only owners can do that", blocked: true }),
    });
    open({ companyCreate: wired });
    await gotoCompanyStep();
    expect($('[data-testid="chat-create-company-error"]')?.textContent).toContain(
      "Only owners can do that",
    );
    expect($('[data-testid="chat-create-company-submit"]')).toBeNull();
  });

  it("names the invites the server refused, and keeps the company", async () => {
    const { seam: wired } = seam({
      submit: async () => ({
        ok: true,
        company: {
          companyUid: "cmp_new",
          companyChannelId: "chn_company",
          inviteFailures: [{ email: "ada@example.com", reason: "Already a member." }],
        },
      }),
    });
    const { onclose } = open({ companyCreate: wired });
    await gotoCompanyStep();
    $<HTMLButtonElement>('[data-testid="chat-create-company-submit"]')!.click();
    await settle();
    expect(
      $('[data-testid="chat-create-company-invite-error"]')?.textContent,
    ).toContain("ada@example.com wasn't invited: Already a member.");
    expect(onclose).not.toHaveBeenCalled();
  });

  it("Back returns to the search step with the query intact", async () => {
    open({ companyCreate: seam().seam });
    await gotoCompanyStep();
    $<HTMLButtonElement>('[data-testid="chat-create-back"]')!.click();
    await settle();
    expect($('[data-testid="chat-create-company-step"]')).toBeNull();
    expect($<HTMLInputElement>('[data-testid="chat-create-query"]')!.value).toBe(
      "Test 12323",
    );
    expect($('[data-testid="chat-create-company-row"]')).toBeTruthy();
  });

  it("Escape closes the modal from the company step", async () => {
    const { onclose } = open({ companyCreate: seam().seam });
    await gotoCompanyStep();
    press(window, "Escape");
    await settle();
    expect(onclose).toHaveBeenCalled();
  });

  it("reaches the company row with the arrow keys and opens it with Enter", async () => {
    open({ companyCreate: seam().seam });
    await typeQuery("Test 12323");
    const input = $<HTMLInputElement>('[data-testid="chat-create-query"]')!;
    press(input, "ArrowDown");
    await tick();
    expect($('[data-testid="chat-create-company-row"]')?.getAttribute("aria-selected")).toBe(
      "true",
    );
    press(input, "Enter");
    await settle();
    expect($('[data-testid="chat-create-company-step"]')).toBeTruthy();
  });

  it("Tab still cycles inside the dialog on the company step", async () => {
    open({ companyCreate: seam().seam });
    await gotoCompanyStep();
    const card = $<HTMLElement>('[role="dialog"]')!;
    const focusables = Array.from(
      card.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled])"),
    );
    expect(focusables.length).toBeGreaterThan(1);
    focusables[0].focus();
    press(card, "Tab");
    await tick();
    expect(card.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(focusables[0]);
  });

  it("keeps one card width across both steps", async () => {
    open({ companyCreate: seam().seam });
    await typeQuery("Test 12323");
    const card = $<HTMLElement>('[role="dialog"]')!;
    const before = card.className;
    await gotoCompanyStep();
    expect($<HTMLElement>('[role="dialog"]')!.className).toBe(before);
    expect(card.classList.contains("create-card--wide")).toBe(false);
  });
});
