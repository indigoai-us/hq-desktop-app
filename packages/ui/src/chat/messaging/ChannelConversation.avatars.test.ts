// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import { MARKETPLACE_COVER_HOST } from "../../avatars/csp-image-src";
import ChannelConversation from "./ChannelConversation.svelte";
import { agentAvatarAssets } from "./agent-avatars";

const AGENT_PHOTO = `https://${MARKETPLACE_COVER_HOST}/members/agt_photo/h.png?X-Amz-Signature=mock`;
const ADA_PHOTO = `https://${MARKETPLACE_COVER_HOST}/members/prs_h/h.png?X-Amz-Signature=mock`;
const SELF_PHOTO = `https://${MARKETPLACE_COVER_HOST}/members/prs_me/h.png?X-Amz-Signature=mock`;

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

const messages = [
  {
    eventId: "evt_photo",
    direction: "in",
    fromPersonUid: "agt_photo",
    fromDisplayName: "Photo Agent",
    body: "photo hello",
    createdAt: "2026-08-28T01:14:00.000Z",
  },
  {
    eventId: "evt_plain",
    direction: "in",
    fromPersonUid: "agt_plain",
    fromDisplayName: "Plain Agent",
    body: "plain hello",
    createdAt: "2026-08-28T01:15:00.000Z",
  },
  {
    eventId: "evt_human",
    direction: "in",
    fromPersonUid: "prs_h",
    fromDisplayName: "Ada Lovelace",
    body: "human hello",
    createdAt: "2026-08-28T01:16:00.000Z",
  },
];

describe("ChannelConversation message avatars", () => {
  it("renders photo, generated, and initials avatars on group-start rows", async () => {
    const root = mountWith({
      messages,
      avatarByUid: { agt_photo: AGENT_PHOTO },
    });
    await tick();

    const avatars = [...root.querySelectorAll(".dm-msg-avatar")];
    expect(avatars).toHaveLength(3);

    expect(avatars[0]?.querySelector("img.avatar-img")?.getAttribute("src")).toBe(
      AGENT_PHOTO,
    );

    const generatedSrc = avatars[1]
      ?.querySelector("img.avatar-img")
      ?.getAttribute("src");
    expect(agentAvatarAssets).toContain(generatedSrc);

    expect(avatars[2]?.querySelector(".monogram")?.textContent).toBe("AL");
    expect(avatars[2]?.querySelector("img")).toBeNull();

    expect(root.querySelector(".agent-glyph")).toBeNull();
  });

  it("renders a roster photo for a human author", async () => {
    const root = mountWith({
      messages: [messages[2]],
      avatarByUid: { prs_h: ADA_PHOTO },
    });
    await tick();
    const avatar = root.querySelector(".dm-msg-avatar");
    expect(avatar?.querySelector("img.avatar-img")?.getAttribute("src")).toBe(
      ADA_PHOTO,
    );
    expect(avatar?.querySelector(".monogram")).toBeNull();
  });

  it("renders the signed-in user's own photo on their messages", async () => {
    const root = mountWith({
      messages: [
        {
          eventId: "evt_self",
          direction: "out",
          fromPersonUid: "prs_me",
          fromDisplayName: "Corey",
          body: "mine",
          createdAt: "2026-08-28T01:17:00.000Z",
        },
      ],
      selfPersonUid: "prs_me",
      avatarByUid: { prs_me: SELF_PHOTO },
    });
    await tick();
    expect(
      root.querySelector(".dm-msg-avatar img.avatar-img")?.getAttribute("src"),
    ).toBe(SELF_PHOTO);
  });

  it("does not paint an arbitrary https roster URL (packaged CSP contract)", async () => {
    const root = mountWith({
      messages: [messages[2]],
      avatarByUid: { prs_h: "https://cdn.test/ada.jpg" },
    });
    await tick();
    const avatar = root.querySelector(".dm-msg-avatar");
    expect(avatar?.querySelector("img")).toBeNull();
    expect(avatar?.querySelector(".monogram")?.textContent).toBe("AL");
  });
});

// iOS #44: a bot's name carries the app's one tag, BOT, in the bot hue, so a
// bot reads as a bot without relying on its avatar's shape.
describe("ChannelConversation bot tag", () => {
  it("tags bot authors and leaves people untagged", async () => {
    const root = mountWith({ messages });
    await tick();
    const metas = [...root.querySelectorAll(".dm-msg-meta")];
    expect(metas).toHaveLength(3);
    const tagged = metas.map((meta) => meta.querySelector('[data-testid="author-bot-tag"]'));
    expect(tagged[0]?.classList.contains("hq-tag")).toBe(true);
    expect(tagged[0]?.classList.contains("is-bot")).toBe(true);
    expect(tagged[0]?.textContent).toBe("Bot");
    expect(tagged[1]).not.toBeNull();
    expect(tagged[2]).toBeNull();
  });
});

// iOS #44: the thread card is a soft lift with the count as the link, a
// caret, and a line that never wraps "3 replies" across rows.
describe("ChannelConversation thread card", () => {
  it("shows the count as its own unbreakable label with a caret", async () => {
    const root = mountWith({
      messages: [{ ...messages[2]!, eventId: "evt_thread", replyCount: 3 }],
    });
    await tick();
    const card = root.querySelector('[data-testid="message-replies"]');
    expect(card?.querySelector(".dm-replies-label")?.textContent).toBe("3 replies");
    expect(card?.querySelector(".dm-replies-caret [data-rail-icon='caret-right']")).not.toBeNull();

    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const css = readFileSync(resolve(process.cwd(), "src/chat/messaging/ChannelConversation.svelte"), "utf8");
    const rule = css.match(/\n  \.dm-replies-count \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/white-space: nowrap/);
    expect(rule).toMatch(/border: 1px solid transparent/);
    expect(rule).toMatch(/--reply-card-fill/);
  });
});
