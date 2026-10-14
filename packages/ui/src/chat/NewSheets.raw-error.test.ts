// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import NewChannelSheet from "./NewChannelSheet.svelte";
import NewMessageSheet from "./NewMessageSheet.svelte";
import type { ChatSidebarApi } from "./chat-api.js";
import type { ConversationRow } from "./sidebar-model.js";

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

function mountInto<T extends Record<string, unknown>>(Comp: unknown, props: T) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(Comp as never, { target: host, props: props as never });
}

function assertNoRaw() {
  expect(host.textContent).not.toContain("boom");
  expect(host.textContent).not.toContain("HTTP 500");
  for (const el of host.querySelectorAll("[title], [aria-label]")) {
    expect(el.getAttribute("title") ?? "").not.toContain("boom");
    expect(el.getAttribute("aria-label") ?? "").not.toContain("boom");
  }
}

const ROW: ConversationRow = {
  id: "dm:prs_ada",
  kind: "dm",
  title: "Ada",
  companyUid: null,
  unreadDot: false,
  lastActivityAt: 0,
  pinned: false,
  personUid: "prs_ada",
} as ConversationRow;

describe("NewChannelSheet raw errors", () => {
  it("shows plain copy and logs the raw text when create fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = new Error(RAW);
    const api = {
      createChannel: vi.fn(async () => {
        throw raw;
      }),
      sendChannelMessage: vi.fn(),
      listContacts: vi.fn(async () => ({ contacts: [] })),
    } as unknown as ChatSidebarApi;
    mountInto(NewChannelSheet, {
      api,
      rows: [],
      contacts: [],
      companies: [],
      onclose: vi.fn(),
      aftercreate: vi.fn(),
    });
    await tick();
    const input = host.querySelector<HTMLInputElement>('[data-testid="new-channel-name"]')!;
    input.value = "growth";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    host.querySelector<HTMLButtonElement>('[data-testid="new-channel-create"]')!.click();
    await vi.waitFor(() => {
      expect(host.querySelector(".sf .hint")?.textContent).toContain(
        "Could not create the channel. Try again.",
      );
    });
    assertNoRaw();
    expect(warn).toHaveBeenCalledWith("[new-channel] create failed", raw);
  });
});

describe("NewMessageSheet raw errors", () => {
  it("shows plain copy and logs the raw text when send fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = new Error(RAW);
    const api = {
      sendDm: vi.fn(async () => {
        throw raw;
      }),
      listContacts: vi.fn(async () => ({ contacts: [] })),
    } as unknown as ChatSidebarApi;
    const onopen = vi.fn();
    mountInto(NewMessageSheet, {
      api,
      rows: [ROW],
      contacts: [],
      companies: [],
      onclose: vi.fn(),
      onopen,
    });
    await tick();
    host.querySelector<HTMLButtonElement>('[data-testid="recipient-row"][data-id="dm:prs_ada"]')!.click();
    flushSync();
    const body = host.querySelector<HTMLTextAreaElement>('[data-testid="new-message-body"]')!;
    body.value = "hi";
    body.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    host.querySelector<HTMLButtonElement>('[data-testid="new-message-send"]')!.click();
    await vi.waitFor(() => {
      expect(host.querySelector(".rp-foot-status")?.textContent).toContain("Could not send. Try again.");
    });
    assertNoRaw();
    expect(onopen).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[new-message] send failed", raw);
  });
});
