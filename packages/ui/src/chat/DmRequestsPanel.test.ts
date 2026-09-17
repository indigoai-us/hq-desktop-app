// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import DmRequestsPanel from "./DmRequestsPanel.svelte";
import { createChatWakeBus, type ChatSidebarApi } from "./chat-api";
import type { DmRequest } from "./dm-requests";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const ADA: DmRequest = {
  pairKey: "pk_ada",
  fromPersonUid: "prs_ada",
  fromEmail: "ada@example.com",
  fromDisplayName: "Ada Lovelace",
  message: "Hi — can we talk about the launch?",
  createdAt: "2026-09-10T00:00:00.000Z",
};
const BOB: DmRequest = {
  pairKey: "pk_bob",
  fromPersonUid: "prs_bob",
  fromEmail: "bob@example.com",
  fromDisplayName: "",
  message: null,
  createdAt: "2026-09-10T00:01:00.000Z",
};

function api(
  overrides: Partial<Pick<ChatSidebarApi, "listDmRequests" | "respondDmRequest">> = {},
): Pick<ChatSidebarApi, "listDmRequests" | "respondDmRequest"> {
  return {
    listDmRequests: async () => ({ requests: [ADA, BOB] }),
    respondDmRequest: async () => {},
    ...overrides,
  };
}

function cards(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[data-testid="dm-request-card"]')];
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("DmRequestsPanel", () => {
  it("lists pending requests with name, email and held message; empty state when none", async () => {
    component = mount(DmRequestsPanel, { target: host, props: { api: api() } });
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    const [ada, bob] = cards();
    expect(ada.getAttribute("data-pair-key")).toBe("pk_ada");
    expect(ada.querySelector('[data-testid="dm-request-name"]')?.textContent).toBe(
      "Ada Lovelace",
    );
    expect(ada.textContent).toContain("ada@example.com");
    expect(
      ada.querySelector('[data-testid="dm-request-message"]')?.textContent?.trim(),
    ).toBe("Hi — can we talk about the launch?");
    // No display name → email is the label; no message → explicit note.
    expect(bob.querySelector('[data-testid="dm-request-name"]')?.textContent).toBe(
      "bob@example.com",
    );
    expect(bob.textContent).toContain("No message included.");
    expect(host.querySelector('[data-testid="dm-requests-empty"]')).toBeNull();

    await unmount(component);
    component = mount(DmRequestsPanel, {
      target: host,
      props: { api: api({ listDmRequests: async () => ({ requests: [] }) }) },
    });
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="dm-requests-empty"]')).toBeTruthy(),
    );
  });

  it("accept calls respondDmRequest, prunes the card, emits dm:request-update and reports the resolution", async () => {
    const respondDmRequest = vi.fn(async () => {});
    const wakes = createChatWakeBus();
    const updates: Array<{ pairKey: string }> = [];
    wakes.on("dm:request-update", (payload) => updates.push(payload));
    const onresolved = vi.fn();
    component = mount(DmRequestsPanel, {
      target: host,
      props: { api: api({ respondDmRequest }), wakes, onresolved },
    });
    await vi.waitFor(() => expect(cards()).toHaveLength(2));

    cards()[0]
      .querySelector<HTMLButtonElement>('[data-testid="dm-request-accept"]')!
      .click();
    await vi.waitFor(() => expect(cards()).toHaveLength(1));

    expect(respondDmRequest).toHaveBeenCalledWith({ pairKey: "pk_ada", action: "accept" });
    expect(updates).toEqual([{ pairKey: "pk_ada" }]);
    expect(onresolved).toHaveBeenCalledWith(ADA, "accept");
    expect(cards()[0].getAttribute("data-pair-key")).toBe("pk_bob");
  });

  it("decline and block prune the card and stay on the panel", async () => {
    const respondDmRequest = vi.fn(async () => {});
    const onresolved = vi.fn();
    component = mount(DmRequestsPanel, {
      target: host,
      props: { api: api({ respondDmRequest }), onresolved },
    });
    await vi.waitFor(() => expect(cards()).toHaveLength(2));

    cards()[0]
      .querySelector<HTMLButtonElement>('[data-testid="dm-request-decline"]')!
      .click();
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    cards()[0]
      .querySelector<HTMLButtonElement>('[data-testid="dm-request-block"]')!
      .click();
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="dm-requests-empty"]')).toBeTruthy(),
    );

    expect(respondDmRequest.mock.calls).toEqual([
      [{ pairKey: "pk_ada", action: "decline" }],
      [{ pairKey: "pk_bob", action: "block" }],
    ]);
    expect(onresolved.mock.calls).toEqual([
      [ADA, "decline"],
      [BOB, "block"],
    ]);
    expect(host.querySelector('[data-testid="dm-requests-panel"]')).toBeTruthy();
  });

  it("shows an inline error and keeps the card when the respond call fails", async () => {
    const respondDmRequest = vi.fn(async () => {
      throw new Error("server said no");
    });
    const onresolved = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    component = mount(DmRequestsPanel, {
      target: host,
      props: { api: api({ respondDmRequest }), onresolved },
    });
    await vi.waitFor(() => expect(cards()).toHaveLength(2));

    cards()[0]
      .querySelector<HTMLButtonElement>('[data-testid="dm-request-accept"]')!
      .click();
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="dm-request-error"]')).toBeTruthy(),
    );
    expect(host.querySelector('[data-testid="dm-request-error"]')?.textContent).toContain(
      "Could not accept this request: server said no",
    );
    expect(cards()).toHaveLength(2);
    expect(onresolved).not.toHaveBeenCalled();
    // Buttons are re-enabled for a retry.
    expect(
      cards()[0].querySelector<HTMLButtonElement>('[data-testid="dm-request-accept"]')!
        .disabled,
    ).toBe(false);
    consoleError.mockRestore();
  });

  it("reacts to dm:request-new / dm:request-update wakes", async () => {
    const wakes = createChatWakeBus();
    component = mount(DmRequestsPanel, {
      target: host,
      props: { api: api({ listDmRequests: async () => ({ requests: [ADA] }) }), wakes },
    });
    await vi.waitFor(() => expect(cards()).toHaveLength(1));

    wakes.emit("dm:request-new", BOB);
    await tick();
    await vi.waitFor(() => expect(cards()).toHaveLength(2));
    // Re-emit is deduped by pairKey.
    wakes.emit("dm:request-new", BOB);
    await tick();
    expect(cards()).toHaveLength(2);

    wakes.emit("dm:request-update", { pairKey: "pk_ada" });
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0].getAttribute("data-pair-key")).toBe("pk_bob");
  });

  it("renders read-only cards when the host has no respondDmRequest seam", async () => {
    component = mount(DmRequestsPanel, {
      target: host,
      props: { api: { listDmRequests: async () => ({ requests: [ADA] }) } },
    });
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(host.querySelector('[data-testid="dm-request-accept"]')).toBeNull();
    expect(host.querySelector('[data-testid="dm-request-readonly"]')).toBeTruthy();
  });
});
