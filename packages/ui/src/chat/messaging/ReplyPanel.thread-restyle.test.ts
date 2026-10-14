// @vitest-environment happy-dom
/**
 * Thread panel restyle (PR #772 design, never shipped):
 * - header: no rule under the title; a 24px icon close instead of a typed ×.
 *   On the console-rail beta the title keeps the owner's recorded Messages
 *   type (AUDIT-2-06, 15px / 700, chat/messages-type-exception.ts) instead of
 *   the PR's 10px mono caption;
 * - rows and root: 32px avatar on a 12px gutter (the main chat's geometry);
 * - the reply count as hairline / caption / hairline, drawn once (no root
 *   border-bottom and label border-top pair) and only when replies exist (no
 *   "0 replies" divider), and no "No replies yet" prose;
 * - the panel paints the rail's `--side-bg` and no border-left of its own
 *   (the host column owns the divider);
 * - the hover bar hangs 4px under its own message like the main timeline's,
 *   with transparent 24px buttons, a pointer bridge, and a flip above the
 *   body for the last reply.
 *
 * happy-dom does not compute scoped styles, so CSS is read from the stylesheet
 * the mounted panel injects.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ReplyPanel from "./ReplyPanel.svelte";
import type { ConversationApi } from "../chat-api";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

const root = {
  eventId: "evt_root",
  direction: "in",
  fromPersonUid: "prs_ada",
  fromDisplayName: "Ada",
  body: "root body",
  createdAt: "2026-08-28T01:14:00.000Z",
};

const replies = [
  {
    eventId: "evt_r1",
    direction: "in",
    fromPersonUid: "prs_bob",
    fromDisplayName: "Bob",
    body: "first reply",
    createdAt: "2026-08-28T01:15:00.000Z",
  },
  {
    eventId: "evt_r2",
    direction: "in",
    fromPersonUid: "prs_cy",
    fromDisplayName: "Cy",
    body: "second reply",
    createdAt: "2026-08-28T01:16:00.000Z",
  },
];

let fetchReplyThread: ReturnType<typeof vi.fn>;

async function render(withReplies = true): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  const list = withReplies ? replies : [];
  fetchReplyThread = vi.fn(async () => ({
    scope: "channel",
    root,
    replies: list,
    replyCount: list.length,
  }));
  component = mount(ReplyPanel, {
    target: host,
    props: {
      api: {
        fetchReplyThread,
        sendReply: async () => ({}),
      } as unknown as ConversationApi,
      rootEventId: "evt_root",
      scope: "channel",
      channelId: "chn_1",
      seedRoot: root,
      reactions: {
        evt_root: [{ emoji: "👍", count: 1, reactedByMe: false }],
        evt_r1: [{ emoji: "🎉", count: 2, reactedByMe: true }],
      },
      onclose: () => {},
    },
  });
  await tick();
  return host;
}

function rules(): { selector: string; body: string }[] {
  const text = [...document.querySelectorAll("style")]
    .map((node) => node.textContent ?? "")
    .filter((t) => t.includes("reply-panel"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@media\s*\(hover:\s*none\)\s*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, "");
  return [...text.matchAll(/([^{}]+)\{([^}]*)\}/g)].flatMap((m) =>
    m[1].split(",").map((selector) => ({
      selector: selector
        .replace(/:where\(\.svelte-[a-z0-9]+\)/g, "")
        .replace(/\.svelte-[a-z0-9]+/g, "")
        .replace(/\s+/g, " ")
        .trim(),
      body: m[2],
    })),
  );
}

function block(selector: string): string {
  return rules()
    .filter((r) => r.selector === selector)
    .map((r) => r.body)
    .join(";");
}

function decl(selector: string, prop: string): string | undefined {
  const all = [...block(selector).matchAll(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`, "g"))];
  return all.at(-1)?.[1].trim();
}

describe("thread panel header", () => {
  it("titles the panel Thread in the recorded Messages type with no rule under it", async () => {
    const root = await render();
    expect(root.querySelector('[data-testid="reply-panel-title"]')?.textContent).toBe("Thread");
    expect(decl(".reply-title", "font-size")).toBe("15px");
    expect(decl(".reply-title", "font-weight")).toBe("700");
    expect(block(".reply-header")).not.toMatch(/border-bottom/);
  });

  it("closes from a 24px drawn icon, not a typed ×", async () => {
    const onclose = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ReplyPanel, {
      target: host,
      props: {
        api: {
          fetchReplyThread: async () => ({ scope: "channel", root, replies: [], replyCount: 0 }),
          sendReply: async () => ({}),
        } as unknown as ConversationApi,
        rootEventId: "evt_root",
        scope: "channel",
        channelId: "chn_1",
        seedRoot: root,
        onclose,
      },
    });
    await tick();
    const close = host.querySelector<HTMLButtonElement>('[data-testid="reply-panel-close"]');
    expect(close?.querySelector("svg")).not.toBeNull();
    expect(close?.textContent?.trim()).toBe("");
    expect(decl(".reply-close", "width")).toBe("24px");
    expect(decl(".reply-close", "height")).toBe("24px");
    close!.click();
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});

describe("thread rows", () => {
  it("sets the root and every reply on a 32px avatar with a 12px gutter", async () => {
    await render();
    for (const selector of [".reply-root", ".reply-row"]) {
      expect(decl(selector, "grid-template-columns"), selector).toBe("32px minmax(0, 1fr)");
      expect(decl(selector, "gap"), selector).toBe("12px");
    }
    expect(decl(".reply-avatar", "width")).toBe("32px");
  });

  it("draws the reply count once as hairline / caption / hairline", async () => {
    const root = await render();
    await vi.waitFor(() =>
      expect(root.querySelector(".reply-root-label")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
        "2 replies",
      ),
    );
    expect(block(".reply-root")).not.toMatch(/border-bottom/);
    expect(block(".reply-root-label")).not.toMatch(/border-top/);
    expect(decl(".reply-root-label", "display")).toBe("flex");
    expect(decl(".reply-root-label", "font-size")).toBe("10px");
    expect(decl(".reply-root-label", "font-family")).toBe("var(--font-mono)");
    for (const side of ["::before", "::after"]) {
      expect(decl(`.reply-root-label${side}`, "height"), side).toBe("1px");
      expect(decl(`.reply-root-label${side}`, "background"), side).toBe("var(--line)");
      expect(decl(`.reply-root-label${side}`, "flex"), side).toBe("1");
    }
  });

  it("draws no count divider and no prose for an empty thread", async () => {
    // A lone "0 REPLIES" rule under the root read as a broken label; the
    // divider only separates the root from replies that exist.
    const root = await render(false);
    // Wait for the thread fetch to settle so the absence below is the loaded
    // state, not the loading one.
    await vi.waitFor(() => {
      expect(fetchReplyThread).toHaveBeenCalled();
      expect(root.querySelector('[data-testid="reply-panel-root"]')).not.toBeNull();
      expect(root.textContent).not.toContain("Loading replies");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
    expect(root.querySelector(".reply-root-label")).toBeNull();
    expect(root.querySelector('[data-testid="reply-count-divider"]')).toBeNull();
    expect(root.textContent?.toLowerCase()).not.toContain("0 replies");
    expect(root.querySelector('[data-testid="reply-panel-empty"]')).toBeNull();
    expect(root.textContent).not.toContain("No replies yet");
  });
});

describe("thread panel ground", () => {
  it("paints the rail's --side-bg and leaves the divider to the host column", async () => {
    await render();
    expect(decl(".reply-panel", "background")).toMatch(/^var\(--side-bg\b/);
    expect(block(".reply-panel")).not.toMatch(/border-left/);
  });
});

describe("thread hover bar placement", () => {
  it("hangs the bar off the message body, never the reaction row", async () => {
    const root = await render();
    await vi.waitFor(() =>
      expect(root.querySelectorAll('[data-testid="reply-panel-message"]').length).toBe(2),
    );
    // Both the root and the first reply carry a reaction row; it sits after
    // the bar's box, so the bar never lands under the reactions.
    expect(root.querySelectorAll(".reaction-bar").length).toBe(2);
    for (const bar of root.querySelectorAll(".reply-quick-react")) {
      expect(bar.parentElement?.classList.contains("reply-main")).toBe(true);
      expect(bar.parentElement?.querySelector(".reaction-bar")).toBeNull();
    }
    expect(root.querySelector(".reply-root .reply-main > .reply-quick-react-root")).not.toBeNull();
  });

  it("opens 4px under the message's right edge like the main timeline", async () => {
    await render();
    expect(decl(".reply-main", "position")).toBe("relative");
    expect(decl(".reply-quick-react", "top")).toBe("100%");
    expect(decl(".reply-quick-react", "right")).toBe("0");
    expect(decl(".reply-quick-react", "margin-top")).toBe("4px");
    expect(block(".reply-quick-react")).not.toMatch(/top:\s*-12px/);
    // The root's old in-row override (top: 8px; right: 16px) is gone too.
    expect(decl(".reply-quick-react-root", "top")).toBeUndefined();
    expect(decl(".reply-quick-react::before", "inset")).toBe("-6px -4px -4px");
  });

  it("flips the last reply's bar above its body so the list does not clip it", async () => {
    const root = await render();
    await vi.waitFor(() =>
      expect(root.querySelectorAll('[data-testid="reply-panel-message"]').length).toBe(2),
    );
    const rows = [...root.querySelectorAll('[data-testid="reply-panel-message"]')];
    expect(rows.map((row) => row.classList.contains("reply-row-last"))).toEqual([false, true]);
    expect(decl(".reply-row-last .reply-quick-react", "top")).toBe("auto");
    expect(decl(".reply-row-last .reply-quick-react", "bottom")).toBe("100%");
  });

  it("uses transparent 24px buttons", async () => {
    await render();
    expect(decl(".reply-quick-react-btn", "min-width")).toBe("24px");
    expect(decl(".reply-quick-react-btn", "height")).toBe("24px");
    expect(decl(".reply-quick-react-btn", "background")).toBe("transparent");
    expect(decl(".reply-quick-react-btn:hover", "background")).toBe("var(--hover)");
  });
});
