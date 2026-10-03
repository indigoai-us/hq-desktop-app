// @vitest-environment happy-dom

// The host's text for a message (`textByEventId`): the cloud bot's hello is
// drawn with the app lines and the "/help" sentence taken out, while every
// other message keeps its own words. Live, 2026-10-03, bot "Big Nuts": the
// hello named slack.com, notion.com and sentry.io in its text and ended with
// "/help shows the available commands", with no envelope at all.

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";
import { cleanAgentHelloText } from "../agent-channel.js";
import type { RichBlock } from "./richMessageContent";
import type { ConversationMessageWire } from "../chat-api";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

const BOT = "agt_big_nuts";
const ME = "prs_me";

const HELLO =
  "Hi Stefan, I'm Big Nuts at Indigo. The company files are still downloading.\n\n" +
  "slack.com: See the conversations behind the work.\n" +
  "notion.com: Use the team's shared docs.\n" +
  "sentry.io: Investigate reported errors.\n\n" +
  "Which one would you like to connect or share first? /help shows the available commands.";

let minute = 0;
function message(from: string, body: string, eventId: string): ConversationMessageWire {
  minute += 1;
  return {
    eventId,
    direction: from === ME ? "out" : "in",
    fromPersonUid: from,
    fromDisplayName: from === ME ? "Me" : "Big Nuts",
    body,
    createdAt: new Date(Date.UTC(2026, 9, 3, 20, minute)).toISOString(),
  } as ConversationMessageWire;
}

async function mountWith(props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const state = $state<Record<string, unknown>>({ selfPersonUid: ME, selfDisplayName: "Me", ...props });
  component = mount(ChannelConversation, { target: host, props: state as never });
  flushSync();
  await tick();
  return { root: host, state };
}

const bodyOf = (root: ParentNode, eventId: string): string =>
  root.querySelector<HTMLElement>(`[data-testid="conversation-message"][data-event-id="${eventId}"] .dm-bubble-body`)?.textContent ?? "";

describe("ChannelConversation textByEventId", () => {
  it("draws the host's text for the named message and the message's own text for every other", async () => {
    const hello = message(BOT, HELLO, "hello");
    const later = message(BOT, "notion.com: still here in an ordinary message.", "later");
    const cleaned = cleanAgentHelloText(HELLO, [{ app: "slack" }]);
    const { root } = await mountWith({ messages: [hello, later], textByEventId: { hello: cleaned } });
    expect(bodyOf(root, "hello")).toContain("Hi Stefan, I'm Big Nuts at Indigo.");
    expect(bodyOf(root, "hello")).toContain("Which one would you like to connect or share first?");
    expect(bodyOf(root, "hello")).not.toContain("slack.com");
    expect(bodyOf(root, "hello")).not.toContain("sentry.io");
    expect(bodyOf(root, "hello")).not.toContain("/help");
    expect(bodyOf(root, "later")).toContain("notion.com: still here in an ordinary message.");
  });

  it("keeps the message's own text when nothing is named, and takes the host's text together with the host's blocks", async () => {
    const hello = message(BOT, HELLO, "hello");
    const { root, state } = await mountWith({ messages: [hello], suggestionsFrom: BOT });
    expect(bodyOf(root, "hello")).toContain("sentry.io: Investigate reported errors.");
    expect(root.querySelector('[data-testid="suggested-reply"]')).toBeNull();
    const extra: RichBlock[] = [{ kind: "suggestions", items: ["Connect more tools"] }];
    state.textByEventId = { hello: cleanAgentHelloText(HELLO, [{ app: "slack" }]) };
    state.extraBlocksByEventId = { hello: extra };
    flushSync();
    await tick();
    expect(bodyOf(root, "hello")).not.toContain("sentry.io");
    expect(bodyOf(root, "hello")).toContain("Which one would you like to connect or share first?");
    const chip = root.querySelector<HTMLButtonElement>('[data-event-id="hello"] [data-testid="suggested-reply"]');
    expect(chip?.textContent?.trim()).toBe("Connect more tools");
  });
});
