// @vitest-environment happy-dom

/**
 * usage-only-pricing US-024: a chat attachment refused by a usage pause shows
 * the server's usage message and an action for the reader's role (owner or
 * admin: Open Billing; member: ask an owner), never plan or upgrade wording.
 * Drives the real composer, upload helper and Sync adapter error mapping;
 * only the Rust `hq_pro_fetch` bridge is faked with hq-pro's 402 body.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import { createSyncPlatformAdapter } from "@hq/platform";

import ChannelConversation from "./ChannelConversation.svelte";
import { uploadChatAttachments } from "./upload-chat-attachments";
import { loadCallerRole, resetCallerRoles } from "../../company/company-roles.svelte.js";

const ACTION_URL = "https://hq.computer/companies/acme/billing";
const USAGE_MESSAGE =
  "Cloud sync is paused. Acme used its $10.00 monthly allowance. Add a card on the Billing page to resume. Files on this computer are not affected.";

const USAGE_PAUSE_BODY = {
  error: "plan_limit_reached",
  code: "PLAN_LIMIT_EXCEEDED",
  status: 402,
  blocked: "files.create",
  reason: "usage_card_required",
  resources: [],
  fixOptions: {},
  message: "New files are paused by your plan limit.",
  upgradeUrl: ACTION_URL,
  usagePause: { code: "usage_paused", reason: "usage_card_required", message: USAGE_MESSAGE, actionUrl: ACTION_URL },
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  resetCallerRoles();
  vi.restoreAllMocks();
});

function pausedUploader() {
  const adapter = createSyncPlatformAdapter({
    invoke: async (cmd: string) => {
      if (cmd === "hq_pro_fetch") return { status: 402, body: JSON.stringify(USAGE_PAUSE_BODY) };
      throw new Error(`unexpected command ${cmd}`);
    },
    fetch: (() => {
      throw new Error("production must not use window.fetch");
    }) as unknown as typeof globalThis.fetch,
    requestPolicy: { throttle: null, sleep: async () => {} },
  });
  const putObject = vi.fn();
  const upload = (files: File[]) =>
    uploadChatAttachments({
      files,
      companyUid: "cmp_acme",
      scope: "chan",
      scopeId: "chn_1",
      presignPut: (cmp, key, contentType, integrity) => adapter.files.presignVaultPut(cmp, key, contentType, integrity),
      putObject,
    });
  return { upload, putObject };
}

function report(): File {
  return new File([new Uint8Array([1, 2, 3, 4])], "report.pdf", { type: "application/pdf" });
}

function dispatchPaste(el: HTMLElement, files: File[]): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files, items: [], types: ["Files"] } });
  el.dispatchEvent(event);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await tick();
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function sendRefused(onopenurl: (url: string) => void): Promise<void> {
  const { upload, putObject } = pausedUploader();
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: {
      messages: [],
      companyUid: "cmp_acme",
      onopenurl,
      onsend: async (_body: string, _mentions: unknown, files?: File[]) => {
        await upload(files ?? []);
      },
    },
  });
  await settle();
  const composer = host.querySelector('[data-testid="conversation-composer"]') as HTMLTextAreaElement;
  dispatchPaste(composer, [report()]);
  await settle();
  (host.querySelector('[data-testid="composer-send"]') as HTMLButtonElement).click();
  await settle();
  expect(putObject).not.toHaveBeenCalled();
}

async function seedRole(role: string): Promise<void> {
  loadCallerRole({
    companyUid: "cmp_acme",
    selfUid: "prs_me",
    company: {
      listCompanyMemberships: async () => ({ ok: true as const, value: { members: [{ personUid: "prs_me", role }] } }),
    } as never,
  });
  await settle();
}

describe("chat attachment refused by a usage pause (US-024)", () => {
  it("an owner sees the server message and Open Billing", async () => {
    await seedRole("owner");
    const onopenurl = vi.fn();
    await sendRefused(onopenurl);
    expect(host.querySelector(".composer-attach-error")?.textContent).toBe(USAGE_MESSAGE);
    const billing = host.querySelector('[data-testid="composer-attach-billing"]') as HTMLButtonElement | null;
    expect(billing?.textContent?.trim()).toBe("Open Billing");
    billing?.click();
    expect(onopenurl).toHaveBeenCalledWith(ACTION_URL);
    expect(host.querySelector('[data-testid="composer-attach-upgrade"]')).toBeNull();
    expect(host.textContent).not.toMatch(/plan limit|Upgrade|Starter|Workforce|Individual/);
  });

  it("a member is asked to contact an owner and gets no Billing button", async () => {
    await seedRole("member");
    const onopenurl = vi.fn();
    await sendRefused(onopenurl);
    expect(host.querySelector(".composer-attach-error")?.textContent).toBe(USAGE_MESSAGE);
    expect(host.querySelector('[data-testid="composer-attach-ask-owner"]')?.textContent).toBe(
      "Ask a company owner or admin to add a card on the Billing page.",
    );
    expect(host.querySelector('[data-testid="composer-attach-billing"]')).toBeNull();
    expect(host.querySelector('[data-testid="composer-attach-upgrade"]')).toBeNull();
    expect(host.textContent).not.toMatch(/plan limit|Upgrade|Starter|Workforce|Individual/);
  });
});
