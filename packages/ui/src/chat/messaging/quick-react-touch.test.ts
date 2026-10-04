// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import type { ConversationApi } from "../chat-api";
import ChannelConversation from "./ChannelConversation.svelte";
import ReplyPanel from "./ReplyPanel.svelte";

function injectedCss(): string {
  const chunks: string[] = [];
  for (const el of document.querySelectorAll("style")) {
    chunks.push(el.textContent ?? "");
  }
  return chunks.join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The block of one `@media (hover: none)` rule, braces included. */
function hoverNoneBlocks(css: string): string[] {
  const query = "@media (hover: none)";
  const blocks: string[] = [];
  let from = 0;
  while (from < css.length) {
    const at = css.indexOf(query, from);
    if (at < 0) break;
    const open = css.indexOf("{", at);
    if (open < 0) break;
    let depth = 0;
    let end = open;
    for (; end < css.length; end++) {
      if (css[end] === "{") depth += 1;
      else if (css[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(css.slice(at, end + 1));
    from = end + 1;
  }
  return blocks;
}

/**
 * The class must run straight into its declaration block. A Svelte scope
 * class (`.dm-quick-react.svelte-hash`) is part of that selector; a
 * pseudo-class such as `:hover` is not, because touch input never reaches it.
 */
function touchRule(css: string, selector: string): string | undefined {
  const ruleRe = new RegExp(
    `(?:^|[{}])\\s*\\.${selector}(?![\\w-])(?:\\.[\\w-]+)*\\s*\\{`,
  );
  return hoverNoneBlocks(css).find((block) => ruleRe.test(block));
}

describe("conversation pane captures clicks on a transparent macOS window", () => {
  let host: HTMLDivElement | null = null;
  let component: ReturnType<typeof mount> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    host?.remove();
    host = null;
  });

  it("gives the isolated conversation layer a hittable fill", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        messages: [
          {
            eventId: "evt_touch",
            direction: "in",
            fromPersonUid: "prs_ada",
            fromDisplayName: "Ada",
            body: "hello",
            createdAt: "2026-08-28T01:14:00.000Z",
          },
        ],
      },
    });
    await tick();
    const css = injectedCss();
    const rule = css.match(/\.conversation[^{]*\{([^}]*)\}/);
    expect(rule?.[1]).toContain("isolation: isolate");
    expect(rule?.[1]).toContain("pointer-events: auto");
    expect(rule?.[1]).toMatch(/color-mix\(in srgb, var\(--t1(?:, #111)?\) 1%, transparent\)/);
  });
});

describe("quick-react toolbar on touch input", () => {
  let host: HTMLDivElement | null = null;
  let conversation: ReturnType<typeof mount> | null = null;
  let reply: ReturnType<typeof mount> | null = null;

  afterEach(async () => {
    if (reply) await unmount(reply);
    if (conversation) await unmount(conversation);
    reply = null;
    conversation = null;
    host?.remove();
    host = null;
  });

  async function css(): Promise<string> {
    host = document.createElement("div");
    document.body.appendChild(host);
    const message = {
      eventId: "evt_touch",
      direction: "in" as const,
      fromPersonUid: "prs_ada",
      fromDisplayName: "Ada",
      body: "hello",
      createdAt: "2026-08-28T01:14:00.000Z",
    };
    conversation = mount(ChannelConversation, {
      target: host,
      props: { messages: [message] },
    });
    const replyHost = document.createElement("div");
    host.appendChild(replyHost);
    reply = mount(ReplyPanel, {
      target: replyHost,
      props: {
        api: {
          fetchReplyThread: async () => ({
            scope: "channel",
            root: message,
            replies: [],
            replyCount: 0,
          }),
          sendReply: async () => {},
        } as unknown as ConversationApi,
        rootEventId: "evt_touch",
        scope: "channel",
        channelId: "chn_1",
        seedRoot: message,
        selfDisplayName: "Ada",
        onclose: () => {},
      },
    });
    await tick();
    return injectedCss();
  }

  it.each([
    ["reply root", "reply-quick-react-root"],
    ["reply row", "reply-quick-react"],
    ["main chat", "dm-quick-react"],
  ])("keeps the %s toolbar reachable without hover", async (_label, selector) => {
    const found = touchRule(await css(), selector);
    expect(found).toBeDefined();
    expect(found).toContain("opacity: 1");
    expect(found).toContain("pointer-events: auto");
  });
});
