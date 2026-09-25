// @vitest-environment happy-dom

// Suggested replies: the host hands the conversation a few short answers or
// next questions; each is a button after the newest message, and a click sends
// it as the person's reply, once.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";
import type { ConversationMessageWire } from "../chat-api";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

const MESSAGES: ConversationMessageWire[] = [
  {
    eventId: "evt_q",
    direction: "in" as const,
    fromPersonUid: "agt_setup",
    fromDisplayName: "setup",
    body: "Are you setting HQ up for a company, or just for yourself right now?",
    createdAt: "2026-09-25T10:00:00.000Z",
  },
];

async function mountWith(props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const state = $state<Record<string, unknown>>({ messages: MESSAGES, ...props });
  component = mount(ChannelConversation, { target: host, props: state as never });
  flushSync();
  await tick();
  return { root: host, state };
}

const buttons = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLButtonElement>('[data-testid="suggested-reply"]')];

describe("ChannelConversation suggested replies", () => {
  it("shows no buttons when the host passes none", async () => {
    const { root } = await mountWith({});
    expect(root.querySelector('[data-testid="suggested-replies"]')).toBeNull();
  });

  it("shows each suggestion as a button and a click sends it as the reply", async () => {
    const onsend = vi.fn(async () => {});
    const { root } = await mountWith({
      onsend,
      suggestedReplies: ["For a company", "Just for me"],
    });
    expect(buttons(root).map((b) => b.textContent?.trim())).toEqual(["For a company", "Just for me"]);
    buttons(root)[0].click();
    await tick();
    await tick();
    expect(onsend).toHaveBeenCalledTimes(1);
    expect((onsend.mock.calls[0] as unknown[])[0]).toBe("For a company");
  });

  it("hides the set after a click so it cannot be sent twice, and shows a new set", async () => {
    const onsend = vi.fn(async () => {});
    const { root, state } = await mountWith({ onsend, suggestedReplies: ["Yes", "Not yet"] });
    buttons(root)[1].click();
    await tick();
    flushSync();
    expect(root.querySelector('[data-testid="suggested-replies"]')).toBeNull();
    state.suggestedReplies = ["Invite Sara", "Skip for now"];
    flushSync();
    await tick();
    expect(buttons(root).map((b) => b.textContent?.trim())).toEqual(["Invite Sara", "Skip for now"]);
  });

  it("shows nothing while the composer is locked", async () => {
    const { root } = await mountWith({ suggestedReplies: ["Yes"], composerLocked: true });
    expect(root.querySelector('[data-testid="suggested-replies"]')).toBeNull();
  });
});
