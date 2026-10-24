// @vitest-environment happy-dom

/**
 * History paging in the human-only timeline. The host always reads the
 * full timeline (hq-message-visibility US-006 removed the server human
 * view), so the pane pages one request per action and auto-fetches only
 * while no visible row is loaded, bounded at five requests per mount.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";
import type { ConversationMessageWire } from "../chat-api";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const MESH_BODY =
  '{"v":1,"kind":"work-session-event","threadId":"work-desktop-dogfood:T-002","event":{"kind":"done","at":"2026-08-28T15:14:05.854Z","by":"Stefan Johnson","summary":"T-002 marked done on the board"}}';

function human(n: number): ConversationMessageWire {
  return {
    eventId: `evt_h_${n}`,
    direction: "in",
    fromPersonUid: "prs_ada",
    fromDisplayName: "Ada",
    body: `human-row-${n}-xyz`,
    createdAt: new Date(Date.UTC(2026, 7, 28, 10, n)).toISOString(),
  } as ConversationMessageWire;
}

function mesh(n: number): ConversationMessageWire {
  return {
    eventId: `evt_m_${n}`,
    direction: "in",
    fromDisplayName: "work-mesh",
    body: MESH_BODY,
    isMeshEvent: true,
    createdAt: new Date(Date.UTC(2026, 7, 28, 9, n)).toISOString(),
  } as ConversationMessageWire;
}

interface HostProps {
  humanOnly: boolean;
  hasEarlier: boolean;
  messages: ConversationMessageWire[];
  onloadearlier: () => Promise<void>;
  onsend?: (body: string) => Promise<void>;
  selfPersonUid?: string;
  conversationKey?: string | null;
}

/** One history page as the host would apply it. */
interface Page {
  add?: ConversationMessageWire[];
  /** The page carried a `nextCursor`. */
  cursor: boolean;
}

/**
 * Mount with reactive props and a scripted host: each `onloadearlier` call
 * applies the next page (prepends its rows, sets `hasEarlier` from its
 * cursor), the way DesktopApp does after a history request.
 */
function mountWithPages(
  initial: {
    messages: ConversationMessageWire[];
    hasEarlier: boolean;
    humanOnly?: boolean;
    conversationKey?: string | null;
  },
  pages: Page[] | ((call: number) => Page),
  hold?: () => Promise<void>,
) {
  const calls = { count: 0 };
  const props: HostProps = $state({
    humanOnly: initial.humanOnly ?? true,
    hasEarlier: initial.hasEarlier,
    messages: initial.messages,
    conversationKey: initial.conversationKey ?? null,
    onloadearlier: async () => {
      const index = calls.count;
      calls.count += 1;
      if (hold) await hold();
      const page =
        typeof pages === "function"
          ? pages(index)
          : (pages[index] ?? { cursor: false });
      if (page.add && page.add.length > 0) {
        props.messages = [...page.add, ...props.messages];
      }
      props.hasEarlier = page.cursor;
    },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, { target: host, props });
  return { props, calls };
}

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

const q = (testid: string) => host.querySelector(`[data-testid="${testid}"]`);
const loadEarlierButton = () =>
  q("conversation-load-earlier") as HTMLButtonElement | null;

describe("ChannelConversation: history paging", () => {
  it("an empty local window auto-fetches one request per run, up to five", async () => {
    const { calls } = mountWithPages(
      { messages: [mesh(1)], hasEarlier: true },
      () => ({ cursor: true }),
    );
    await settle(60);
    expect(calls.count).toBe(5);
    // After the cap the pane shows the plain button.
    expect(loadEarlierButton()?.textContent ?? "").toContain("Load earlier messages");
  });

  it("a button press issues exactly one request, even when the page adds nothing", async () => {
    const { calls } = mountWithPages(
      { messages: [human(1)], hasEarlier: true },
      () => ({ cursor: true }),
    );
    await settle();
    expect(calls.count).toBe(0);
    loadEarlierButton()!.click();
    await settle(30);
    expect(calls.count).toBe(1);
  });

  it("flag off: nothing auto-fetches", async () => {
    const { calls } = mountWithPages(
      { messages: [], hasEarlier: true, humanOnly: false },
      () => ({ cursor: true }),
    );
    await settle(30);
    expect(calls.count).toBe(0);
    loadEarlierButton()!.click();
    await settle(30);
    expect(calls.count).toBe(1);
  });

  it("a hidden-only page folds instead of leaving the pane empty", async () => {
    mountWithPages({ messages: [mesh(1), mesh(2)], hasEarlier: false }, []);
    await settle();
    expect(q("conversation-empty")).toBeNull();
    expect(host.querySelectorAll('[data-testid="message-fold"]').length).toBe(1);
  });
});
