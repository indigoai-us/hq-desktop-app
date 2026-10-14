// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";
import ReplyPanel from "./ReplyPanel.svelte";
import type { ConversationApi, ConversationMessageWire } from "../chat-api";
import type { ChatArtifact } from "./artifact-model";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function mountConversation(props: Record<string, unknown>): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: { messages: [], ...props },
  });
  return host;
}

const forwardedFrom = {
  senderUid: "prs_ada",
  senderName: "Ada Lovelace",
  sourceKind: "dm",
  originalCreatedAt: "2026-10-01T10:00:00.000Z",
};

const longDetails = `## Plan\n\n${"line of detail ".repeat(80)}\nEND-OF-DETAILS`;

const forwarded = {
  eventId: "evt_fwd",
  direction: "in",
  fromPersonUid: "prs_bob",
  fromDisplayName: "Bob",
  body: "The original words",
  details: longDetails,
  prompt: "Run the full prompt text",
  forwardedFrom,
  forwardNote: "Look at this",
  attachments: [
    { vaultPath: "companies/x/files/a.pdf", name: "a.pdf", kind: "file", sizeBytes: 10 },
  ],
  createdAt: "2026-10-02T10:00:00.000Z",
};

const plain = {
  eventId: "evt_plain",
  direction: "in",
  fromPersonUid: "prs_bob",
  fromDisplayName: "Bob",
  body: "Forwarded from Mallory",
  createdAt: "2026-10-02T10:01:00.000Z",
};


describe("forwarded message in the conversation view (DM and channel)", () => {
  for (const view of [
    { name: "1:1 DM", props: { withPersonUid: "prs_bob" } },
    { name: "channel", props: { channelId: "chn_1" } },
  ]) {
    it(`AC0: shows 'Forwarded from {senderName}' above the body in the ${view.name} view`, async () => {
      const root = mountConversation({ ...view.props, messages: [forwarded] });
      await tick();
      const header = root.querySelector('[data-testid="forwarded-header"]');
      expect(header?.textContent?.trim()).toBe("Forwarded from Ada Lovelace");
      const block = root.querySelector('[data-testid="forwarded-block"]')!;
      expect(block.textContent).toContain("The original words");
      // Header precedes the forwarded body inside the block.
      const html = block.innerHTML;
      expect(html.indexOf("Forwarded from Ada Lovelace")).toBeLessThan(
        html.indexOf("The original words"),
      );
    });
  }

  it("AC1: body text starting with 'Forwarded from' does not produce the header", async () => {
    const root = mountConversation({ messages: [plain] });
    await tick();
    expect(root.querySelector('[data-testid="forwarded-header"]')).toBeNull();
    expect(root.querySelector('[data-testid="forwarded-block"]')).toBeNull();
    expect(root.textContent).toContain("Forwarded from Mallory");
  });

  it("AC2: the note renders above the forwarded block, outside it", async () => {
    const root = mountConversation({ messages: [forwarded] });
    await tick();
    const bubble = root.querySelector(".dm-bubble")!;
    const children = Array.from(bubble.children);
    const noteIdx = children.findIndex((c) => c.textContent?.includes("Look at this"));
    const blockIdx = children.findIndex((c) => c.matches('[data-testid="forwarded-block"]'));
    expect(noteIdx).toBeGreaterThanOrEqual(0);
    expect(noteIdx).toBeLessThan(blockIdx);
    expect(children[blockIdx].textContent).not.toContain("Look at this");
  });

  it("AC2: with no note, only the forwarded block shows", async () => {
    const root = mountConversation({ messages: [{ ...forwarded, forwardNote: undefined }] });
    await tick();
    const bubble = root.querySelector(".dm-bubble")!;
    expect(bubble.children).toHaveLength(1);
    expect(bubble.children[0].matches('[data-testid="forwarded-block"]')).toBe(true);
  });

  it("AC3: Details and Prompt cards render inside the block and open with full text", async () => {
    const opened: ChatArtifact[] = [];
    const root = mountConversation({
      messages: [forwarded],
      onopenartifact: (a: ChatArtifact) => opened.push(a),
    });
    await tick();
    const block = root.querySelector('[data-testid="forwarded-block"]')!;
    const details = block.querySelector('[data-testid="message-details"]') as HTMLElement;
    const prompt = block.querySelector('[data-testid="message-prompt"]') as HTMLElement;
    expect(details).not.toBeNull();
    expect(prompt).not.toBeNull();
    details.click();
    expect(opened).toHaveLength(1);
    expect(JSON.stringify(opened[0])).toContain("END-OF-DETAILS");
  });

  it("AC4: forwarded attachments render with the attachment component inside the block", async () => {
    const root = mountConversation({ messages: [forwarded] });
    await tick();
    const block = root.querySelector('[data-testid="forwarded-block"]')!;
    const attachments = block.querySelector('[data-testid="message-attachments"]');
    expect(attachments?.textContent).toContain("a.pdf");
  });

  it("AC5: omittedAttachments > 0 shows '{n} file(s) not included' as plain text", async () => {
    const root = mountConversation({
      messages: [{ ...forwarded, omittedAttachments: 2 }],
    });
    await tick();
    const line = root.querySelector('[data-testid="forwarded-omitted"]');
    expect(line?.textContent?.trim()).toBe("2 files not included");
    expect(line?.children).toHaveLength(0);
  });

  it("AC5: omittedAttachments of 0 or absent shows nothing", async () => {
    const root = mountConversation({
      messages: [{ ...forwarded, omittedAttachments: 0 }],
    });
    await tick();
    expect(root.querySelector('[data-testid="forwarded-omitted"]')).toBeNull();
  });

  it("AC7: a row without forwardedFrom renders no forwarded block and keeps the body bubble", async () => {
    const root = mountConversation({ messages: [{ ...plain, body: "Hi there" }] });
    await tick();
    expect(root.querySelector('[data-testid="forwarded-block"]')).toBeNull();
    const bubble = root.querySelector(".dm-bubble")!;
    expect(bubble.firstElementChild?.classList.contains("dm-bubble-body")).toBe(true);
    expect(bubble.textContent).toContain("Hi there");
  });

});

describe("forwarded message in the reply panel", () => {
  function api(rootMsg: unknown, replies: unknown[]): ConversationApi {
    return {
      fetchReplyThread: async () => ({ scope: "channel", root: rootMsg, replies, replyCount: replies.length }),
      sendReply: async () => ({}),
    } as unknown as ConversationApi;
  }

  async function mountPanel(rootMsg: Record<string, unknown>, replies: unknown[] = []) {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ReplyPanel, {
      target: host,
      props: {
        api: api(rootMsg, replies),
        rootEventId: String(rootMsg.eventId),
        scope: "channel",
        channelId: "chn_1",
        seedRoot: rootMsg as unknown as ConversationMessageWire,
        onclose: () => {},
      },
    });
    await tick();
    await Promise.resolve();
    await tick();
    return host;
  }

  it("AC0: the forwarded root shows the header in the reply panel", async () => {
    const h = await mountPanel(forwarded);
    const rootEl = h.querySelector('[data-testid="reply-panel-root"]')!;
    expect(rootEl.querySelector('[data-testid="forwarded-header"]')?.textContent?.trim()).toBe(
      "Forwarded from Ada Lovelace",
    );
  });

  it("AC0: a forwarded reply shows the header in the reply panel", async () => {
    const h = await mountPanel(
      { ...plain, eventId: "evt_root", body: "root" },
      [{ ...forwarded, eventId: "evt_reply_fwd", rootEventId: "evt_root" }],
    );
    const row = h.querySelector('[data-testid="reply-panel-message"]')!;
    expect(row.querySelector('[data-testid="forwarded-header"]')?.textContent?.trim()).toBe(
      "Forwarded from Ada Lovelace",
    );
    expect(row.querySelector('[data-testid="message-details"]')).not.toBeNull();
  });

  it("AC2: the forwarder's note renders above the block, outside it, for the root and a reply", async () => {
    const h = await mountPanel(
      { ...forwarded, eventId: "evt_root" },
      [{ ...forwarded, eventId: "evt_reply_fwd", rootEventId: "evt_root", forwardNote: "Reply note" }],
    );
    for (const [sel, note] of [
      ['[data-testid="reply-panel-root"]', "Look at this"],
      ['[data-testid="reply-panel-message"]', "Reply note"],
    ] as const) {
      const el = h.querySelector(sel)!;
      const block = el.querySelector('[data-testid="forwarded-block"]')!;
      expect(el.textContent).toContain(note);
      expect(block.textContent).not.toContain(note);
      expect(el.textContent!.indexOf(note)).toBeLessThan(el.textContent!.indexOf("Forwarded from"));
    }
  });

  it("AC1/AC7: a plain root whose body starts with 'Forwarded from' gets no header", async () => {
    const h = await mountPanel({ ...plain, eventId: "evt_root" });
    expect(h.querySelector('[data-testid="forwarded-header"]')).toBeNull();
  });
});

describe("ForwardedBlock styling (US-008 AC6)", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "ForwardedBlock.svelte"),
    "utf8",
  );
  const style = src.slice(src.indexOf("<style>"));

  it("has no left accent bar", () => {
    expect(style).not.toMatch(/border-left|inset-inline-start|::before/);
  });

  it("uses only existing theme tokens for colors", () => {
    expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    for (const m of style.matchAll(/color:\s*([^;]+);/g)) {
      expect(m[1].trim()).toMatch(/^var\(--[a-z0-9-]+\)$/);
    }
  });

  it("never renders the header with {@html}", () => {
    expect(src).not.toContain("{@html");
  });
});
