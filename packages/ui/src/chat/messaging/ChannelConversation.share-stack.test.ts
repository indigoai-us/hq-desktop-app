// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function mountWith(props: Record<string, unknown>): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: { messages: [], ...props },
  });
  return host;
}

function folderShare(i: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    eventId: `evt_share_${i}`,
    direction: "in",
    fromPersonUid: "prs_corey",
    fromDisplayName: "Corey Epstein",
    body: "Shared a folder with you.",
    createdAt: new Date(Date.UTC(2026, 9, 14, 15, 18, i * 13)).toISOString(),
    attachments: [{ name, kind: "folder", vaultPath: `projects/${name}/` }],
    ...extra,
  };
}

const SIX = [
  "agent-box-size-billing-tiers",
  "agent-tier-upgrades",
  "hq-billing-outpost-compute",
  "outpost-autoscale",
  "outpost-box-resizing",
  "outpost-storage-autoscale",
].map((name, i) => folderShare(i, name));

describe("ChannelConversation share stack", () => {
  it("folds back-to-back folder shares into one row with one summary", async () => {
    const root = mountWith({ messages: SIX });
    await tick();
    expect(root.querySelectorAll('[data-testid="conversation-message"]')).toHaveLength(1);
    const stack = root.querySelector('[data-testid="share-stack"]');
    expect(stack?.getAttribute("data-count")).toBe("6");
    expect(stack?.textContent).toContain("Shared 6 folders with you.");
    expect(stack?.textContent).toContain("agent-box-size-billing-tiers, agent-tier-upgrades +4 more");
    expect(root.textContent).not.toContain("Shared a folder with you.");
  });

  it("expands to every folder card and collapses again", async () => {
    const root = mountWith({ messages: SIX });
    await tick();
    (root.querySelector('[data-testid="share-stack-expand"]') as HTMLButtonElement).click();
    await tick();
    const cards = root.querySelectorAll('[data-testid="attachment-card"]');
    expect(cards).toHaveLength(6);
    expect(cards[0]?.textContent).toContain("FOLDER");
    (root.querySelector('[data-testid="share-stack-collapse"]') as HTMLButtonElement).click();
    await tick();
    expect(root.querySelectorAll('[data-testid="attachment-card"]')).toHaveLength(0);
  });

  it("opens the clicked folder from the expanded stack", async () => {
    const opened: string[] = [];
    const root = mountWith({
      messages: SIX,
      onopenattachment: (item: { vaultPath: string }) => opened.push(item.vaultPath),
    });
    await tick();
    (root.querySelector('[data-testid="share-stack-expand"]') as HTMLButtonElement).click();
    await tick();
    (root.querySelectorAll('[data-testid="attachment-card"]')[3] as HTMLButtonElement).click();
    expect(opened).toEqual(["projects/outpost-autoscale/"]);
  });

  it("starts a new stack after a message with other content", async () => {
    const handoff = {
      eventId: "evt_handoff",
      direction: "in",
      fromPersonUid: "prs_corey",
      fromDisplayName: "Corey Epstein",
      body: "Handing you outpost-box-resizing.",
      prompt: "TITLE: Project handoff\nDo the thing.",
      createdAt: "2026-10-14T15:18:30.000Z",
    };
    const root = mountWith({
      messages: [SIX[0], SIX[1], handoff, folderShare(9, "outpost-autoscale")],
    });
    await tick();
    const stacks = root.querySelectorAll('[data-testid="share-stack"]');
    expect(stacks).toHaveLength(1);
    expect(stacks[0]?.getAttribute("data-count")).toBe("2");
    expect(root.textContent).toContain("Handing you outpost-box-resizing.");
    expect(root.textContent).toContain("Shared a folder with you.");
  });

  it("leaves a single share as a normal message with a folder badge", async () => {
    const root = mountWith({ messages: [SIX[0]] });
    await tick();
    expect(root.querySelector('[data-testid="share-stack"]')).toBeNull();
    expect(root.textContent).toContain("Shared a folder with you.");
    expect(root.querySelector('[data-testid="attachment-card"]')?.textContent).toContain("FOLDER");
  });

  it("does not stack shares from different senders or with reactions", async () => {
    const fromShawon = folderShare(1, "agent-tier-upgrades", {
      fromPersonUid: "prs_shawon",
      fromDisplayName: "Shawon",
      direction: "out",
    });
    const reacted = folderShare(2, "outpost-autoscale", {
      reactions: [{ emoji: "👍", count: 1, reactedByMe: true }],
    });
    const root = mountWith({ messages: [SIX[0], fromShawon, reacted] });
    await tick();
    expect(root.querySelector('[data-testid="share-stack"]')).toBeNull();
    expect(root.querySelectorAll('[data-testid="conversation-message"]')).toHaveLength(3);
  });
});
