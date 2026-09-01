// @vitest-environment happy-dom

/**
 * Slack-style thread-reply affordance: overlapping participant avatars
 * (distinct reply authors, capped at 3) to the LEFT of "N replies", then a
 * muted "Last reply {relative}" stamp. Owner feedback follow-up to the
 * neutral-token styling pass — no link blue.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./messaging/ChannelConversation.svelte";
import type { ConversationMessageWire } from "./chat-api";
import type { ReplyPreview } from "./messaging/ReplyPanel.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const root: ConversationMessageWire = {
  eventId: "evt_root",
  body: "root body",
  createdAt: "2026-08-17T01:00:00.000Z",
  fromDisplayName: "Ada",
  replyCount: 4,
};

function mountWithPreview(preview: ReplyPreview | null): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: {
      messages: [root],
      ...(preview
        ? { replyPreviewByRoot: { [root.eventId]: preview } }
        : {}),
    },
  });
}

describe("thread-reply affordance avatars", () => {
  it("renders one small avatar per distinct reply author, before the count", async () => {
    mountWithPreview({
      author: "Izzy",
      at: "2026-08-17T02:00:00.000Z",
      authors: [
        { personUid: "prs_ada", displayName: "Ada Lovelace" },
        { personUid: "agt_izzy", displayName: "Izzy", agent: true },
      ],
    });
    await tick();
    const affordance = host.querySelector('[data-testid="message-replies"]');
    expect(affordance).not.toBeNull();
    const stack = affordance?.querySelector('[data-testid="reply-authors"]');
    expect(stack).not.toBeNull();
    expect(stack?.querySelectorAll(".dm-replies-avatar")).toHaveLength(2);
    // Initials fallback renders through IdentityMark.
    expect(stack?.textContent).toContain("AL");
    // Avatars come before the "N replies" text.
    expect(affordance?.textContent?.indexOf("AL")).toBeLessThan(
      affordance?.textContent?.indexOf("4 replies") ?? -1,
    );
  });

  it("caps the avatar stack at 3 authors", async () => {
    mountWithPreview({
      author: "E",
      at: "2026-08-17T02:00:00.000Z",
      authors: [
        { personUid: "prs_a", displayName: "Aa" },
        { personUid: "prs_b", displayName: "Bb" },
        { personUid: "prs_c", displayName: "Cc" },
        { personUid: "prs_d", displayName: "Dd" },
        { personUid: "prs_e", displayName: "Ee" },
      ],
    });
    await tick();
    expect(
      host.querySelectorAll(
        '[data-testid="reply-authors"] .dm-replies-avatar',
      ),
    ).toHaveLength(3);
  });

  it('renders a muted "Last reply {relative}" stamp from the preview', async () => {
    mountWithPreview({
      author: "Izzy",
      at: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
      authors: [{ personUid: "prs_a", displayName: "Aa" }],
    });
    await tick();
    const stamp = host.querySelector(".dm-replies-preview");
    expect(stamp?.textContent).toMatch(/Last reply .*/);
  });

  it("renders count-only when no preview is known yet", async () => {
    mountWithPreview(null);
    await tick();
    const affordance = host.querySelector('[data-testid="message-replies"]');
    expect(affordance?.textContent).toContain("4 replies");
    expect(host.querySelector('[data-testid="reply-authors"]')).toBeNull();
    expect(host.querySelector(".dm-replies-preview")).toBeNull();
  });
});
