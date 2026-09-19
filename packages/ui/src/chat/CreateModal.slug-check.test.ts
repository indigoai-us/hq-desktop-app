// @vitest-environment happy-dom

/**
 * The live handle check in the create-company step: every state the person can
 * land in, the one-click suggestion, what disables Create, the stale-answer
 * guard, and the reserved-height status row that keeps the card from jumping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import CreateModal from "./CreateModal.svelte";
import type { ChatSidebarApi } from "./chat-api.js";
import type {
  CompanyCreateSeam,
  CompanyDraftForm,
  CreateCompanyResult,
} from "./create-company/create-company-flow.js";

const COMPANY_SLUG_CONSTRAINTS = {
  pattern: "^[a-z][a-z0-9-]{0,29}$",
  minLength: 1,
  maxLength: 30,
  description:
    "Slug must start with a letter and use only lowercase letters, numbers, and hyphens (max 30 characters)",
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const $ = <T extends Element>(selector: string): T | null =>
  document.querySelector<T>(selector);

function stubApi(): ChatSidebarApi {
  return {
    listChannels: async () => [],
    createChannel: async () => {
      throw new Error("not used");
    },
  } as unknown as ChatSidebarApi;
}

function form(): CompanyDraftForm {
  return {
    channelId: "setup",
    cardId: "card_create_company_2",
    title: "Name your company",
    summary: null,
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
        hint: null,
        description: null,
        constraints: null,
      },
      {
        id: "slug",
        label: "Company address",
        control: "text",
        options: [],
        value: "",
        required: true,
        error: null,
        hint: null,
        description: null,
        constraints: COMPANY_SLUG_CONSTRAINTS,
      },
    ],
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

function seam(
  checkSlug: CompanyCreateSeam["checkSlug"],
): CompanyCreateSeam {
  return {
    open: async () => ({ ok: true, form: form() }),
    submit: async () => created,
    checkSlug,
  };
}

function answer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    valid: true,
    available: true,
    normalized: "acme",
    constraints: COMPANY_SLUG_CONSTRAINTS,
    ...over,
  };
}

function open(companyCreate: CompanyCreateSeam) {
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
      companyCreate,
    },
  });
  return { onclose };
}

function type(node: HTMLInputElement, value: string): void {
  node.value = value;
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function gotoCompanyStep(): Promise<void> {
  await settle(2);
  type($<HTMLInputElement>('[data-testid="chat-create-query"]')!, "Acme");
  await vi.advanceTimersByTimeAsync(150);
  await tick();
  $<HTMLButtonElement>('[data-testid="chat-create-company-row"]')!.click();
  await settle();
}

function slugField(): HTMLInputElement {
  return $<HTMLInputElement>('[data-testid="chat-create-company-field-slug"]')!;
}

function status(): HTMLElement {
  return $<HTMLElement>('[data-testid="chat-create-company-slug-status"]')!;
}

function submitButton(): HTMLButtonElement {
  return $<HTMLButtonElement>('[data-testid="chat-create-company-submit"]')!;
}

/** Type a handle and let the debounce + the answer land. */
async function typeSlug(value: string): Promise<void> {
  type(slugField(), value);
  await settle(2);
  await vi.advanceTimersByTimeAsync(400);
  await settle();
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
  vi.useRealTimers();
});

describe("create-company handle check", () => {
  it("says available once the check answers", async () => {
    open(seam(async () => answer()));
    await gotoCompanyStep();
    await typeSlug("acme");
    expect(status().dataset.status).toBe("available");
    expect(status().textContent).toContain("acme is available.");
  });

  it("shows checking while the answer is in flight, and blocks Create", async () => {
    let resolve: ((value: unknown) => void) | null = null;
    open(
      seam(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      ),
    );
    await gotoCompanyStep();
    type($<HTMLInputElement>('[data-testid="chat-create-company-field-name"]')!, "Acme");
    await settle(2);
    type(slugField(), "acme");
    await settle(2);

    expect(status().dataset.status).toBe("checking");
    expect(submitButton().disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(400);
    await settle();
    resolve!(answer());
    await settle();
    expect(status().dataset.status).toBe("available");
    expect(submitButton().disabled).toBe(false);
  });

  it("says taken, offers the suggestion, and fills it in one click", async () => {
    open(
      seam(async () =>
        answer({ available: false, reasons: ["taken"], suggestion: "acme-2" }),
      ),
    );
    await gotoCompanyStep();
    await typeSlug("acme");

    expect(status().dataset.status).toBe("taken");
    expect(submitButton().disabled).toBe(true);

    $<HTMLButtonElement>(
      '[data-testid="chat-create-company-slug-suggestion"]',
    )!.click();
    await settle();
    expect(slugField().value).toBe("acme-2");
  });

  it("says invalid with the reason, without calling the route", async () => {
    const check = vi.fn(async () => answer());
    open(seam(check));
    await gotoCompanyStep();
    await typeSlug("Acme!");

    expect(status().dataset.status).toBe("invalid");
    expect(status().textContent).toContain("lowercase letters");
    expect(check).not.toHaveBeenCalled();
    expect(submitButton().disabled).toBe(true);
  });

  it("says it couldn't check, and still lets the person create", async () => {
    open(
      seam(async () => {
        throw new Error("network down");
      }),
    );
    await gotoCompanyStep();
    type($<HTMLInputElement>('[data-testid="chat-create-company-field-name"]')!, "Acme");
    await settle(2);
    await typeSlug("acme");

    expect(status().dataset.status).toBe("unknown");
    expect(status().textContent).toContain("Couldn't check");
    expect(submitButton().disabled).toBe(false);
  });

  it("never lets a late answer for an older handle win", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    open(
      seam(
        () =>
          new Promise((r) => {
            resolvers.push(r);
          }),
      ),
    );
    await gotoCompanyStep();

    type(slugField(), "acm");
    await settle(2);
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    type(slugField(), "acme");
    await settle(2);
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    expect(resolvers).toHaveLength(2);

    resolvers[1]!(answer({ normalized: "acme" }));
    await settle();
    expect(status().dataset.status).toBe("available");

    // The stale "acm is taken" answer lands last and must be ignored.
    resolvers[0]!(
      answer({ normalized: "acm", available: false, reasons: ["taken"] }),
    );
    await settle();
    expect(status().dataset.status).toBe("available");
    expect(status().textContent).toContain("acme is available.");
  });

  it("keeps the status row in the layout so nothing shifts", async () => {
    open(seam(async () => answer()));
    await gotoCompanyStep();

    // Present and reserving height before anything has been typed.
    expect(status()).not.toBeNull();
    expect(status().dataset.status).toBe("idle");
    const before = status().getBoundingClientRect().height;
    const rowsBefore = document.querySelectorAll(
      '[data-testid="chat-create-company-step"] .create-field',
    ).length;

    await typeSlug("acme");

    expect(status().dataset.status).toBe("available");
    expect(status().getBoundingClientRect().height).toBe(before);
    expect(
      document.querySelectorAll(
        '[data-testid="chat-create-company-step"] .create-field',
      ).length,
    ).toBe(rowsBefore);
  });

  it("stays out of the way entirely when the host has no check", async () => {
    open(seam(null));
    await gotoCompanyStep();
    expect($('[data-testid="chat-create-company-slug-status"]')).toBeNull();
    type($<HTMLInputElement>('[data-testid="chat-create-company-field-name"]')!, "Acme");
    await settle(2);
    type(slugField(), "acme");
    await settle();
    expect(submitButton().disabled).toBe(false);
  });
});
