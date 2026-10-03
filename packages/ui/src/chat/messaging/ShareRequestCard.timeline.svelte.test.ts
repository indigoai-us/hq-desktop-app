// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";
import type { ConversationMessageWire } from "../chat-api";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const messages: ConversationMessageWire[] = [
  {
    eventId: "evt_share",
    direction: "in",
    fromPersonUid: "prs_hassaan",
    fromDisplayName: "Hassaan Saleem",
    body: "",
    createdAt: "2026-09-30T17:02:00.000Z",
    systemEvent: {
      v: 1,
      type: "vault_share",
      id: "shr_1",
      path: "companies/indigo/projects/hq-onboarding-experience/copy/",
      level: "read",
      sharedBy: "Hassaan",
      files: [{ name: "welcome-v2.md", size: 4198 }],
    },
  },
  {
    eventId: "evt_req",
    direction: "in",
    fromPersonUid: "prs_hassaan",
    fromDisplayName: "Hassaan Saleem",
    body: "",
    createdAt: "2026-10-01T09:18:00.000Z",
    systemEvent: {
      v: 1,
      type: "access_request",
      id: "req_1",
      path: "companies/indigo/projects/hq-desktop-console-rail/",
      level: "read",
      note: "Hassaan asked for read access to the project folder.",
    },
  },
] as ConversationMessageWire[];

function mountWith(props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: { messages, channelId: "chn_dm", ...props },
  });
}

describe("US-015 share and request cards in the DM timeline", () => {
  it("renders both cards as timeline items with their actions", async () => {
    mountWith({});
    await tick();
    const cards = host.querySelectorAll('[data-testid="share-request-card"]');
    expect(cards.length).toBe(2);
    expect(cards[0].getAttribute("data-kind")).toBe("shared_folder");
    expect(cards[0].querySelector('[data-testid="share-request-copy"]')?.textContent).toBe("Copy prompt");
    expect(cards[0].querySelector('[data-testid="share-request-open-claude"]')).not.toBeNull();
    expect(cards[1].querySelector('[data-testid="share-request-approve"]')?.textContent).toBe("Approve read");
    expect(cards[1].querySelector('[data-testid="share-request-deny"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="share-request-row"]').length).toBe(2);
  });

  it("opens Claude Code with the folder and a prompt", async () => {
    const onopenurl = vi.fn();
    mountWith({ onopenurl, hqFolderPath: "/Users/me/HQ" });
    await tick();
    (host.querySelector('[data-testid="share-request-open-claude"]') as HTMLButtonElement).click();
    expect(onopenurl).toHaveBeenCalledTimes(1);
    expect(String(onopenurl.mock.calls[0][0])).toMatch(/^claude:\/\/code\/new\?/);
  });

  it("approves at write level and paints the outcome in the same frame", async () => {
    const oncardaction = vi.fn();
    mountWith({ oncardaction });
    await tick();
    (host.querySelector('[data-testid="share-request-level-write"]') as HTMLButtonElement).click();
    await tick();
    (host.querySelector('[data-testid="share-request-approve"]') as HTMLButtonElement).click();
    await tick();
    expect(oncardaction).toHaveBeenCalledWith({
      channelId: "chn_dm",
      cardId: "req_1",
      actionId: "grant_write",
      values: { level: "write", path: "companies/indigo/projects/hq-desktop-console-rail/" },
    });
    expect(host.querySelector('[data-testid="share-request-approve"]')).toBeNull();
    const metas = host.querySelectorAll('[data-testid="share-request-meta"]');
    expect(metas[1].textContent?.trim()).toBe("Write access granted");
  });

  it("denies the request", async () => {
    const oncardaction = vi.fn();
    mountWith({ oncardaction });
    await tick();
    (host.querySelector('[data-testid="share-request-deny"]') as HTMLButtonElement).click();
    await tick();
    expect(oncardaction.mock.calls[0][0].actionId).toBe("deny");
  });
});
