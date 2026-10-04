// @vitest-environment happy-dom

// Suggested replies: a bot writes a `suggestions` block for its own message,
// and the conversation draws it as a row of buttons under that message's
// bubble, part of the message, for the bot's newest message only. A click
// sends the chosen text as the person's reply, once. Owner, live walkthrough
// 2026-10-03: the chips were pinned above the message box for every
// conversation, which read as a static control, and showed next to the
// decision cards, which was decision overload.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";
import { HQ_BLOCK_FENCE_LANG, type RichBlock } from "./richMessageContent";
import type { ConversationMessageWire } from "../chat-api";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

const BOT = "agt_setup";
const ME = "prs_me";

const fence = (blocks: unknown[]): string =>
  ["", "```" + HQ_BLOCK_FENCE_LANG, JSON.stringify({ v: 1, blocks }), "```"].join("\n");
const suggestions = (items: string[]): string => fence([{ kind: "suggestions", items }]);

let minute = 0;
/**
 * A row of the page. The person's rows are stamped now, so a row that echoes
 * a reply sent in the test reconciles with the optimistic row (same author,
 * same words, within the echo window) the way the server's echo does.
 */
function message(from: string, body: string, eventId = `evt_${from}_${minute}`): ConversationMessageWire {
  minute += 1;
  return {
    eventId,
    direction: from === ME ? "out" : "in",
    fromPersonUid: from,
    fromDisplayName: from === ME ? "Me" : "setup",
    body,
    createdAt: from === ME ? new Date().toISOString() : new Date(Date.UTC(2026, 8, 25, 10, minute)).toISOString(),
  } as ConversationMessageWire;
}

const QUESTION = "Are you setting HQ up for a company, or just for yourself right now?";

async function mountWith(props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const state = $state<Record<string, unknown>>({ suggestionsFrom: BOT, selfPersonUid: ME, selfDisplayName: "Me", ...props });
  component = mount(ChannelConversation, { target: host, props: state as never });
  flushSync();
  await tick();
  return { root: host, state };
}

/** Let a send finish: the reply is handed to the host and the optimistic row goes. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await tick();
    await Promise.resolve();
  }
  flushSync();
}

const buttons = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>('[data-testid="suggested-reply"]')];
const labels = (root: ParentNode) => buttons(root).map((b) => b.textContent?.trim());
const messageEl = (root: ParentNode, eventId: string): HTMLElement =>
  root.querySelector<HTMLElement>(`[data-testid="conversation-message"][data-event-id="${eventId}"]`)!;

describe("ChannelConversation suggested replies", () => {
  it("shows no buttons when the newest message carries no suggestions, or no bot is named", async () => {
    const { root, state } = await mountWith({ messages: [message(BOT, QUESTION, "q")] });
    expect(root.querySelector('[data-testid="suggested-replies"]')).toBeNull();
    state.messages = [message(BOT, QUESTION + suggestions(["For a company"]), "q2")];
    state.suggestionsFrom = null;
    flushSync();
    await tick();
    expect(root.querySelector('[data-testid="suggested-replies"]')).toBeNull();
  });

  it("draws each suggestion as a button inside that message, under its bubble, and a click sends it as the reply", async () => {
    const onsend = vi.fn(async () => {});
    const { root } = await mountWith({ onsend, messages: [message(BOT, QUESTION + suggestions(["For a company", "Just for me"]), "q")] });
    const row = messageEl(root, "q");
    expect(labels(row)).toEqual(["For a company", "Just for me"]);
    // Part of the message: in the thread, after the bubble, and never a
    // second copy anywhere else.
    const chips = row.querySelector<HTMLElement>('[data-testid="suggested-replies"]')!;
    const bubble = row.querySelector<HTMLElement>(".dm-bubble")!;
    expect(root.querySelector('[data-testid="conversation-thread"]')!.contains(chips)).toBe(true);
    expect(Boolean(bubble.compareDocumentPosition(chips) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(root.querySelectorAll('[data-testid="suggested-replies"]')).toHaveLength(1);
    expect(row.textContent).not.toContain("hq-block");
    buttons(root)[0].click();
    await tick();
    await tick();
    expect(onsend).toHaveBeenCalledTimes(1);
    expect((onsend.mock.calls[0] as unknown[])[0]).toBe("For a company");
  });

  it("hides the set after a click so it cannot be sent twice, and a newer bot message shows its own set", async () => {
    const onsend = vi.fn(async () => {});
    const first = message(BOT, QUESTION + suggestions(["Yes", "Not yet"]), "q1");
    const { root, state } = await mountWith({ onsend, messages: [first] });
    buttons(root)[1].click();
    buttons(root)[1]?.click();
    await tick();
    flushSync();
    expect(root.querySelector('[data-testid="suggested-replies"]')).toBeNull();
    expect(onsend).toHaveBeenCalledTimes(1);
    await settle();
    state.messages = [first, message(ME, "Not yet", "a1"), message(BOT, "Who else works here?" + suggestions(["Invite Sara", "Skip for now"]), "q2")];
    await settle();
    expect(labels(messageEl(root, "q2"))).toEqual(["Invite Sara", "Skip for now"]);
    expect(labels(messageEl(root, "q1"))).toEqual([]);
  });

  it("draws chips for the bot's newest message only, and none once the person has written after it", async () => {
    const older = message(BOT, "First question?" + suggestions(["One", "Two"]), "q1");
    const newer = message(BOT, "Second question?" + suggestions(["Three"]), "q2");
    const { root, state } = await mountWith({ messages: [older, newer] });
    expect(labels(messageEl(root, "q1"))).toEqual([]);
    expect(labels(messageEl(root, "q2"))).toEqual(["Three"]);
    state.messages = [older, newer, message(ME, "Three", "a1")];
    flushSync();
    await tick();
    expect(root.querySelector('[data-testid="suggested-replies"]')).toBeNull();
    // A newer bot message without suggestions replaces the old ones with nothing.
    state.messages = [older, newer, message(ME, "Three", "a1"), message(BOT, "Noted.", "q3")];
    flushSync();
    await tick();
    expect(root.querySelector('[data-testid="suggested-replies"]')).toBeNull();
  });

  it("draws no suggestions for a message that carries a connect block, its own or one the host attached: the cards are the decision", async () => {
    const own = message(BOT, "Connect something?" + fence([{ kind: "suggestions", items: ["Later"] }, { kind: "connect", items: [{ app: "slack" }] }]), "q1");
    const { root, state } = await mountWith({ messages: [own] });
    expect(root.querySelector('[data-testid="suggested-replies"]')).toBeNull();
    const plain = message(BOT, "Connect something?" + suggestions(["Later"]), "q2");
    state.messages = [plain];
    flushSync();
    await tick();
    expect(labels(messageEl(root, "q2"))).toEqual(["Later"]);
    const cards: RichBlock[] = [{ kind: "connect", items: [{ app: "slack" }] }];
    state.extraBlocksByEventId = { q2: cards };
    flushSync();
    await tick();
    expect(root.querySelector('[data-testid="suggested-replies"]')).toBeNull();
  });

  it("draws only the bot's own suggestions: a suggestions block the host attached is not drawn", async () => {
    // Owner, live walkthrough 2026-10-03: the app's "Connect more tools" chip
    // under every message was noise. Chips show only when the bot suggests.
    const own = message(BOT, "Quite a lot already." + suggestions(["List our open projects", "Summarize our files"]), "q1");
    const extra: RichBlock[] = [{ kind: "suggestions", items: ["Connect more tools"] }];
    const { root, state } = await mountWith({ messages: [own], extraBlocksByEventId: { q1: extra } });
    expect(labels(messageEl(root, "q1"))).toEqual(["List our open projects", "Summarize our files"]);
    expect(messageEl(root, "q1").textContent).not.toContain("Connect more tools");
    // A message with no suggestions of its own draws no row at all.
    state.messages = [message(BOT, "Quite a lot already.", "q2")];
    state.extraBlocksByEventId = { q2: extra };
    flushSync();
    await tick();
    expect(root.querySelector('[data-testid="suggested-replies"]')).toBeNull();
    expect(root.querySelector('[data-testid="suggested-reply-other"]')).toBeNull();
    expect(root.textContent).not.toContain("Connect more tools");
  });

  it("draws the bot's own 'Connect more tools' suggestion like any other", async () => {
    const { root } = await mountWith({ messages: [message(BOT, "Done." + suggestions(["Connect more tools", "List our open projects"]), "q")] });
    expect(labels(messageEl(root, "q"))).toEqual(["Connect more tools", "List our open projects"]);
  });

  it("offers Something else only with two or more suggestions, never with one, never alone", async () => {
    const { root, state } = await mountWith({ messages: [message(BOT, "Want a summary?" + suggestions(["Yes please"]), "q1")] });
    expect(labels(messageEl(root, "q1"))).toEqual(["Yes please"]);
    expect(root.querySelector('[data-testid="suggested-reply-other"]')).toBeNull();
    // No suggestions: no row, and no lone Something else.
    state.messages = [message(BOT, "Noted.", "q2")];
    flushSync();
    await tick();
    expect(root.querySelector('[data-testid="suggested-replies"]')).toBeNull();
    expect(root.querySelector('[data-testid="suggested-reply-other"]')).toBeNull();
    // Two: the list is not exhaustive, so Something else is the last chip.
    state.messages = [message(BOT, "Which tool?" + suggestions(["ClickUp", "Asana"]), "q3")];
    flushSync();
    await tick();
    const row = messageEl(root, "q3").querySelector<HTMLElement>('[data-testid="suggested-replies"]')!;
    const chips = [...row.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(chips).toEqual(["ClickUp", "Asana", "Something else"]);
  });

  it("with two or more suggestions offers Something else, which sends nothing and puts the cursor in the composer to type", async () => {
    // Test Mac 2026-09-27: ClickUp / Asana / Notion / Monday read as the only
    // choices. The last chip says other answers are fine.
    const onsend = vi.fn(async () => {});
    const { root } = await mountWith({ onsend, messages: [message(BOT, "Which tool?" + suggestions(["ClickUp", "Asana"]), "q")] });
    const other = root.querySelector<HTMLButtonElement>('[data-testid="suggested-reply-other"]')!;
    expect(other.textContent?.trim()).toBe("Something else");
    expect(messageEl(root, "q").contains(other)).toBe(true);
    const composer = root.querySelector<HTMLTextAreaElement>('[data-testid="conversation-composer"]')!;
    const before = composer.placeholder;
    other.click();
    flushSync();
    await tick();
    expect(onsend).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(composer);
    expect(composer.placeholder).toBe("Type your own answer here…");
    expect(buttons(root).length, "the suggestions stay available").toBe(2);
    // A typed answer or a new set of suggestions puts the normal prompt back.
    buttons(root)[0].click();
    await tick();
    flushSync();
    expect(composer.placeholder).toBe(before);
  });

  it("sends the host's text for a button whose label is not the message", async () => {
    const onsend = vi.fn(async () => {});
    const { root } = await mountWith({
      onsend,
      messages: [message(BOT, "Quite a lot already." + suggestions(["List our open projects", "Connect more"]), "q")],
      suggestedReplyText: { "Connect more": "Connect more tools" },
    });
    expect(labels(root)).toEqual(["List our open projects", "Connect more"]);
    buttons(root)[1].click();
    buttons(root)[1]?.click();
    await tick();
    await tick();
    flushSync();
    expect(onsend).toHaveBeenCalledTimes(1);
    expect((onsend.mock.calls[0] as unknown[])[0]).toBe("Connect more tools");
    expect(root.querySelector('[data-testid="suggested-replies"]')).toBeNull();
  });

  it("shows the same button again under a later message, once the first set was put away", async () => {
    const onsend = vi.fn(async () => {});
    const first = message(BOT, "Here you go." + suggestions(["Connect more tools"]), "q1");
    const { root, state } = await mountWith({ onsend, messages: [first] });
    buttons(root)[0].click();
    await tick();
    flushSync();
    expect(root.querySelector('[data-testid="suggested-replies"]')).toBeNull();
    await settle();
    // The reply landed, then the bot wrote again with the same words.
    state.messages = [first, message(ME, "Connect more tools", "a1")];
    await settle();
    state.messages = [first, message(ME, "Connect more tools", "a1"), message(BOT, "Here you go again." + suggestions(["Connect more tools"]), "q2")];
    await settle();
    expect(labels(messageEl(root, "q2"))).toEqual(["Connect more tools"]);
    buttons(root)[0].click();
    await tick();
    await tick();
    expect(onsend).toHaveBeenCalledTimes(2);
  });

  it("shows nothing while the composer is locked", async () => {
    const { root } = await mountWith({ messages: [message(BOT, QUESTION + suggestions(["Yes"]), "q")], composerLocked: true });
    expect(root.querySelector('[data-testid="suggested-replies"]')).toBeNull();
  });
});
