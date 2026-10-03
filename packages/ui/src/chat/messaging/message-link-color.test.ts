// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import type { ConversationApi } from "../chat-api";
import ChannelConversation from "./ChannelConversation.svelte";
import ReplyPanel from "./ReplyPanel.svelte";

/** Component styles after the surfaces mount. Comments are stripped first.
 *  Plain imported CSS (chat-tokens.css) is not injected by this Vitest setup,
 *  so only the compiled Svelte `<style>` blocks are observable. The theme
 *  test installs that stylesheet itself and reads the custom property the
 *  browser applies. */
function injectedCss(): string {
  const chunks: string[] = [];
  for (const el of document.querySelectorAll("style")) {
    chunks.push(el.textContent ?? "");
  }
  return chunks.join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
}

const LINK_TOKEN =
  "--message-markdown-link: var(--vio-ink, var(--accent, #e0c4fe))";

type CssRule = { selector: string; body: string };

/** Declarations from top-level rules and from inside at-rules, kept per selector. */
function cssRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  let cursor = 0;
  while (cursor < css.length) {
    while (cursor < css.length && /\s/.test(css[cursor] ?? "")) cursor += 1;
    if (cursor >= css.length) break;
    const open = css.indexOf("{", cursor);
    if (open < 0) break;
    const selector = css.slice(cursor, open).trim();
    let depth = 0;
    let end = open;
    for (; end < css.length; end += 1) {
      const ch = css[end];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const inner = css.slice(open + 1, end);
    if (selector.startsWith("@")) rules.push(...cssRules(inner));
    else if (selector) rules.push({ selector, body: inner });
    cursor = Math.min(end + 1, css.length);
  }
  return rules;
}

function selectorTargets(
  selectorList: string,
  surface: string,
  anchor: "a" | "a:visited" | "a:hover",
): boolean {
  const anchorSource =
    anchor === "a" ? "a(?![:\\w-])" : `a:${anchor.slice(2)}(?![\\w-])`;
  const pattern = new RegExp(
    `\\.${surface}(?![\\w-])(?:\\.[\\w-]+)*\\s+${anchorSource}`,
  );
  return selectorList.split(",").some((part) => pattern.test(part));
}

function ruleWhere(
  css: string,
  surface: string,
  anchors: Array<"a" | "a:visited" | "a:hover">,
  declaration: string,
): CssRule | undefined {
  return cssRules(css).find(
    (rule) =>
      anchors.every((anchor) => selectorTargets(rule.selector, surface, anchor)) &&
      rule.body.includes(declaration),
  );
}

const LINK_SURFACES = ["dm-bubble-body", "reply-md"] as const;
const LINK_COLOR = "color: var(--message-markdown-link)";
const HOVER_COLOR =
  "color: color-mix(in srgb, var(--message-markdown-link) 88%, var(--t1))";

describe("message body link color", () => {
  let host: HTMLDivElement | null = null;
  let conversation: ReturnType<typeof mount> | null = null;
  let reply: ReturnType<typeof mount> | null = null;
  const themeNodes: HTMLElement[] = [];

  afterEach(async () => {
    if (reply) await unmount(reply);
    if (conversation) await unmount(conversation);
    reply = null;
    conversation = null;
    host?.remove();
    host = null;
    for (const node of themeNodes) node.remove();
    themeNodes.length = 0;
    document.documentElement.removeAttribute("data-force-theme");
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

  it("applies the dark and light violet tokens from chat-tokens.css", () => {
    const tokens = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../chat-tokens.css"),
      "utf8",
    );
    const style = document.createElement("style");
    style.textContent = tokens;
    document.head.appendChild(style);
    themeNodes.push(style);
    const shell = document.createElement("div");
    shell.className = "chat-shell";
    document.body.appendChild(shell);
    themeNodes.push(shell);

    document.documentElement.setAttribute("data-force-theme", "light");
    expect(getComputedStyle(shell).getPropertyValue("--vio-ink").trim()).toBe(
      "#854dee",
    );

    document.documentElement.removeAttribute("data-force-theme");
    const dark = document.createElement("div");
    dark.className = "dark";
    dark.appendChild(shell);
    document.body.appendChild(dark);
    themeNodes.push(dark);
    expect(getComputedStyle(shell).getPropertyValue("--vio-ink").trim()).toBe(
      "#e0c4fe",
    );
  });

  it("colors body anchors with the link token, not the muted body token", async () => {
    const css = await mountSurfaces();
    for (const surface of LINK_SURFACES) {
      expect(
        ruleWhere(css, surface, ["a", "a:visited"], LINK_COLOR),
        `${surface} a and a:visited share the link token`,
      ).toBeDefined();
    }
  });

  it("keeps the underline and brightens only on hover", async () => {
    const css = await mountSurfaces();
    for (const surface of LINK_SURFACES) {
      expect(
        ruleWhere(css, surface, ["a"], "text-decoration: underline"),
        `${surface} underline`,
      ).toBeDefined();
      expect(
        ruleWhere(css, surface, ["a:hover"], HOVER_COLOR),
        `${surface} hover color`,
      ).toBeDefined();
    }
  });
});
