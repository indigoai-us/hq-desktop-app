// @vitest-environment happy-dom
/**
 * The message hover bar (owner, #772, restored 2026-10-21): it hangs 4px
 * under everything that belongs to the message, opens above instead on the
 * newest message, and every message that takes reactions offers it, cards
 * included. happy-dom does not lay out, so geometry is read from the
 * stylesheet the mounted conversation injects; structure from the DOM.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";
import ReplyPanel from "./ReplyPanel.svelte";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

const at = (min: number): string =>
  new Date(Date.UTC(2026, 9, 21, 12, min)).toISOString();

const messages = [
  {
    eventId: "m1",
    direction: "in" as const,
    fromPersonUid: "prs_ada",
    fromDisplayName: "Ada",
    body: "First, with a thread.",
    createdAt: at(0),
    replyCount: 3,
  },
  {
    eventId: "run",
    direction: "in" as const,
    fromPersonUid: "agt_fleet",
    fromDisplayName: "Fleet Agent",
    body: "Run complete",
    messageKind: "system",
    createdAt: at(1),
    systemEvent: {
      v: 1,
      type: "run_complete",
      title: "Nightly sweep — complete",
      summary: "Done.",
    },
  },
  {
    eventId: "m2",
    direction: "in" as const,
    fromPersonUid: "prs_ada",
    fromDisplayName: "Ada",
    body: "Newest.",
    createdAt: at(2),
  },
];

async function render(): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: {
      messages,
      mentionCandidates: [],
      allowHereMention: false,
      onsend: () => {},
      onreply: () => {},
    },
  });
  await tick();
  return host;
}

function row(root: HTMLElement, id: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`.dm-msg[data-event-id="${id}"]`);
  expect(el, `row ${id}`).not.toBeNull();
  return el!;
}

function css(): string {
  return [...document.querySelectorAll("style")]
    .map((node) => node.textContent ?? "")
    .filter((text) => text.includes("dm-quick-react"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@media\s*\(hover:\s*none\)\s*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, "");
}

function rule(text: string, selector: RegExp): string {
  const found = [...text.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, sel]) =>
    selector.test(sel.trim()),
  );
  expect(found, String(selector)).toBeDefined();
  return found![2];
}

describe("message hover bar", () => {
  it("is the last thing in the message, after its thread card", async () => {
    const root = await render();
    const column = row(root, "m1").querySelector(":scope > .dm-msg-column")!;
    expect(column.lastElementChild?.classList.contains("dm-quick-react")).toBe(true);
    expect(column.querySelector(".dm-replies-count")).not.toBeNull();
  });

  it("is offered on a run card too, with reactions but not reply or copy", async () => {
    const root = await render();
    const bar = row(root, "run").querySelector(":scope > .dm-msg-column > .dm-quick-react");
    expect(bar).not.toBeNull();
    expect(bar!.querySelector('[data-testid="message-react-more"]')).not.toBeNull();
    expect(bar!.querySelector('[data-testid="message-reply-quick"]')).toBeNull();
    expect(bar!.querySelector('[data-testid="message-copy"]')).toBeNull();
  });

  it("marks only the newest message as the tail", async () => {
    const root = await render();
    expect(row(root, "m2").classList.contains("dm-msg-tail")).toBe(true);
    expect(row(root, "m1").classList.contains("dm-msg-tail")).toBe(false);
  });

  it("hangs 4px under the message, flush with the row's hover wash", async () => {
    await render();
    const body = rule(css(), /^\.dm-quick-react(\.[\w-]+)?$/);
    expect(body).toMatch(/top: 100%/);
    expect(body).toMatch(/bottom: auto/);
    expect(body).toMatch(/right: -8px/);
    expect(body).toMatch(/margin: 4px 0 0/);
  });

  it("opens 4px above the newest message or a row clipped at the bottom", async () => {
    await render();
    const body = rule(css(), /dm-msg-tail[^,]*dm-quick-react[^,]*,\s*\.dm-msg[^,]*\[data-menu-flip\]/);
    expect(body).toMatch(/top: auto/);
    expect(body).toMatch(/bottom: 100%/);
    expect(body).toMatch(/margin: 0 0 4px/);
  });

  it("uses an icon, not a typed plus, to add a reaction", async () => {
    const root = await render();
    const more = row(root, "m2").querySelector('[data-testid="message-react-more"]')!;
    expect(more.textContent?.trim()).toBe("");
    expect(more.querySelector("svg")).not.toBeNull();
  });
});

describe("thread panel hover bar", () => {
  it("hangs under the reply like the main chat's", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const root = messages[0];
    component = mount(ReplyPanel, {
      target: host,
      props: {
        api: {
          fetchReplyThread: async () => ({
            scope: "channel",
            root,
            replies: [],
            replyCount: 0,
          }),
          sendReply: async () => {},
        } as never,
        rootEventId: root.eventId,
        scope: "channel",
        channelId: "chn_1",
        seedRoot: root,
        selfDisplayName: "Ada",
        onclose: () => {},
      },
    });
    await tick();
    const text = [...document.querySelectorAll("style")]
      .map((node) => node.textContent ?? "")
      .filter((t) => t.includes("reply-quick-react"))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@media\s*\(hover:\s*none\)\s*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, "");
    const body = rule(text, /^\.reply-quick-react(\.[\w-]+)?$/);
    expect(body).toMatch(/top: 100%/);
    expect(body).toMatch(/margin-top: 4px/);
    const flip = rule(text, /reply-row-tail[^,]*reply-quick-react/);
    expect(flip).toMatch(/bottom: 100%/);
  });
});
