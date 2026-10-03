// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import type { ConversationApi } from "../chat-api";
import ChannelConversation from "./ChannelConversation.svelte";
import ReplyPanel from "./ReplyPanel.svelte";

/** Component styles after the surfaces mount. Comments are stripped first.
 *  Plain imported CSS (chat-tokens.css) is not injected by this Vitest setup,
 *  so only the compiled Svelte `<style>` blocks are observable. */
function injectedCss(): string {
  const chunks: string[] = [];
  for (const el of document.querySelectorAll("style")) {
    chunks.push(el.textContent ?? "");
  }
  return chunks.join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
}

const LINK_TOKEN =
  "--message-markdown-link: var(--vio-ink, var(--accent, #e0c4fe))";

describe("message body link color", () => {
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

  async function mountSurfaces(): Promise<string> {
    host = document.createElement("div");
    document.body.appendChild(host);
    const message = {
      eventId: "evt_link",
      direction: "in" as const,
      fromPersonUid: "prs_ada",
      fromDisplayName: "Ada",
      body: "see https://example.com/docs",
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
        rootEventId: "evt_link",
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

  it("defines the link token from the violet interactive ink in both surfaces", async () => {
    const css = await mountSurfaces();
    expect(css.split(LINK_TOKEN).length - 1).toBeGreaterThanOrEqual(2);
  });

  it("colors body anchors with the link token, not the muted body token", async () => {
    const css = await mountSurfaces();
    expect(css).toMatch(
      /\.dm-bubble-body[^{]*a[^{]*\{[^}]*color:\s*var\(--message-markdown-link\)/,
    );
    expect(css).toMatch(
      /\.reply-md[^{]*a[^{]*\{[^}]*color:\s*var\(--message-markdown-link\)/,
    );
  });

  it("keeps the underline and brightens only on hover", async () => {
    const css = await mountSurfaces();
    expect(css).toContain("text-decoration: underline");
    expect(css).toContain(
      "color: color-mix(in srgb, var(--message-markdown-link) 88%, var(--t1))",
    );
  });

  it("falls back to the dark violet ink when the theme token is unset", async () => {
    const css = await mountSurfaces();
    // The surfaces compile `--vio-ink` with an AA dark fallback (#e0c4fe,
    // >= 4.5:1 on #1e1e24). The light-theme definition `--vio-ink: #854dee`
    // lives in chat-tokens.css, which this runner does not inject.
    expect(css.split(LINK_TOKEN).length - 1).toBeGreaterThanOrEqual(2);
    expect(css).toContain("#e0c4fe");
  });
});
