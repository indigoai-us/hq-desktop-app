// @vitest-environment happy-dom

/**
 * Human-only timeline when the SERVER filters and pages history
 * (`view=human`, echoed as `view: "human"`). The host passes
 * `serverHumanView` for a conversation whose pages carried that echo.
 *
 * Contract under test:
 *  - a full page renders as it arrives; "earlier" exists exactly when the
 *    host holds a cursor;
 *  - a page that adds no visible row while a cursor remains (the server's
 *    read budget ran out) makes the pane keep fetching, bounded per user
 *    action, behind a loading state. It never shows an empty pane with a
 *    "load earlier" button in that situation;
 *  - no cursor and no rows is the empty state, with no button;
 *  - without the echo (an older server) nothing here applies: see
 *    ChannelConversation.human-only.test.ts, which is unchanged.
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
  serverHumanView: boolean;
  hasEarlier: boolean;
  messages: ConversationMessageWire[];
  onloadearlier: () => Promise<void>;
  onsend?: (body: string) => Promise<void>;
  selfPersonUid?: string;
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
    serverHumanView?: boolean;
    humanOnly?: boolean;
  },
  pages: Page[] | ((call: number) => Page),
  hold?: () => Promise<void>,
) {
  const calls = { count: 0 };
  const props: HostProps = $state({
    humanOnly: initial.humanOnly ?? true,
    serverHumanView: initial.serverHumanView ?? true,
    hasEarlier: initial.hasEarlier,
    messages: initial.messages,
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

describe("ChannelConversation: server human view (view: \"human\" echoed)", () => {
  it("a full page renders at once, fetches nothing on its own, and offers earlier history", async () => {
    const { calls } = mountWithPages(
      { messages: [human(1), human(2), human(3)], hasEarlier: true },
      [],
    );
    await settle();
    expect(host.textContent).toContain("human-row-1-xyz");
    expect(host.textContent).toContain("human-row-3-xyz");
    expect(calls.count).toBe(0);
    expect(q("conversation-empty")).toBeNull();
    expect(q("conversation-scan-paused")).toBeNull();
    expect(loadEarlierButton()?.textContent ?? "").toContain("Load earlier messages");
  });

  it("no cursor means no button: hasEarlier is exactly the cursor", async () => {
    const { calls } = mountWithPages(
      { messages: [human(1), human(2)], hasEarlier: false },
      [],
    );
    await settle();
    expect(host.textContent).toContain("human-row-2-xyz");
    expect(loadEarlierButton()).toBeNull();
    expect(calls.count).toBe(0);
  });

  it("a truncated empty first page keeps fetching until a page brings rows", async () => {
    // Page 0: the server's budget ran out again (no rows, cursor kept).
    // Page 1: three human rows and the end of history.
    const { calls } = mountWithPages({ messages: [], hasEarlier: true }, [
      { cursor: true },
      { add: [human(1), human(2), human(3)], cursor: false },
    ]);
    await settle(20);
    expect(calls.count).toBe(2);
    expect(host.textContent).toContain("human-row-1-xyz");
    expect(host.textContent).toContain("human-row-3-xyz");
    expect(q("conversation-empty")).toBeNull();
    expect(q("conversation-scan-paused")).toBeNull();
    expect(loadEarlierButton()).toBeNull();
  });

  it("while the continuation runs the pane shows loading, never an empty pane with a button", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = mountWithPages(
      { messages: [], hasEarlier: true },
      [{ add: [human(1)], cursor: false }],
      () => gate,
    );
    await settle();
    // The request is in flight and nothing is visible yet.
    expect(calls.count).toBe(1);
    expect(q("conversation-loading-earlier")).not.toBeNull();
    expect(loadEarlierButton()).toBeNull();
    expect(q("conversation-empty")).toBeNull();
    expect(q("conversation-scan-paused")).toBeNull();

    release();
    await settle(20);
    expect(host.textContent).toContain("human-row-1-xyz");
    expect(q("conversation-loading-earlier")).toBeNull();
  });

  it("empty with no cursor shows the empty state and no button", async () => {
    const { calls } = mountWithPages({ messages: [], hasEarlier: false }, []);
    await settle();
    expect(q("conversation-empty")).not.toBeNull();
    expect(loadEarlierButton()).toBeNull();
    expect(q("conversation-loading-earlier")).toBeNull();
    expect(q("conversation-scan-paused")).toBeNull();
    expect(calls.count).toBe(0);
  });

  it("a continuation that ends with no rows and no cursor lands on the empty state", async () => {
    const { calls } = mountWithPages({ messages: [], hasEarlier: true }, [
      { cursor: true },
      { cursor: true },
      { cursor: false },
    ]);
    await settle(30);
    expect(calls.count).toBe(3);
    expect(q("conversation-empty")).not.toBeNull();
    expect(loadEarlierButton()).toBeNull();
  });

  it("the continuation is bounded per user action; the pane then says so and offers to keep looking", async () => {
    // Every page is empty and keeps its cursor.
    const { calls } = mountWithPages({ messages: [], hasEarlier: true }, () => ({
      cursor: true,
    }));
    await settle(60);
    expect(calls.count).toBe(8);
    // Not the empty state, and not the plain "load earlier" button.
    expect(q("conversation-empty")).toBeNull();
    expect(q("conversation-scan-paused")).not.toBeNull();
    const button = loadEarlierButton();
    expect(button?.textContent ?? "").toContain("Look further back");

    // Leaving it alone issues nothing more.
    await settle(30);
    expect(calls.count).toBe(8);

    // One press is one more bounded run.
    button!.click();
    await settle(60);
    expect(calls.count).toBe(16);
    expect(q("conversation-scan-paused")).not.toBeNull();
  });

  it("pressing the button with rows on screen continues past a page that adds nothing", async () => {
    const { calls } = mountWithPages(
      { messages: [human(10), human(11)], hasEarlier: true },
      [
        { cursor: true }, // truncated, nothing visible
        { add: [mesh(1), mesh(2)], cursor: true }, // rows this pane hides
        { add: [human(1), human(2)], cursor: true },
      ],
    );
    await settle();
    expect(calls.count).toBe(0);
    loadEarlierButton()!.click();
    await settle(40);
    expect(calls.count).toBe(3);
    expect(host.textContent).toContain("human-row-1-xyz");
    expect(host.textContent).toContain("human-row-10-xyz");
    // A cursor remains and rows are on screen: the ordinary button is back.
    expect(loadEarlierButton()?.textContent ?? "").toContain("Load earlier messages");
  });

  it("the local filter still applies: a non-human row in a server page stays hidden", async () => {
    mountWithPages(
      { messages: [mesh(1), human(1)], hasEarlier: false },
      [],
    );
    await settle();
    expect(host.textContent).toContain("human-row-1-xyz");
    expect(host.querySelector(".work-mesh-row")).toBeNull();
    expect(host.textContent).not.toContain("T-002 marked done");
  });

  it("keeps the person's own messages: one already on the wire and one just sent", async () => {
    const sent: string[] = [];
    const calls = { count: 0 };
    const props: HostProps = $state({
      humanOnly: true,
      serverHumanView: true,
      hasEarlier: false,
      selfPersonUid: "prs_me",
      messages: [
        {
          eventId: "evt_mine",
          direction: "out",
          fromPersonUid: "prs_me",
          fromDisplayName: "Me",
          body: "my-earlier-message-xyz",
          createdAt: "2026-08-28T10:00:00.000Z",
        } as ConversationMessageWire,
      ],
      onloadearlier: async () => {
        calls.count += 1;
      },
      onsend: async (body: string) => {
        sent.push(body);
      },
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, { target: host, props });
    await settle();
    expect(host.textContent).toContain("my-earlier-message-xyz");

    const composer = q("conversation-composer") as HTMLTextAreaElement | null;
    expect(composer, "composer is mounted").not.toBeNull();
    composer!.value = "my-just-sent-message-xyz";
    composer!.dispatchEvent(new Event("input", { bubbles: true }));
    composer!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await settle();
    expect(sent).toEqual(["my-just-sent-message-xyz"]);
    // The optimistic row is on screen before any server echo of the send.
    expect(host.textContent).toContain("my-just-sent-message-xyz");
    expect(calls.count).toBe(0);
  });
});

describe("ChannelConversation: no echo (older server) keeps the previous behaviour", () => {
  it("an empty local window auto-fetches one request per run, up to five", async () => {
    const { calls } = mountWithPages(
      { messages: [mesh(1)], hasEarlier: true, serverHumanView: false },
      () => ({ cursor: true }),
    );
    await settle(60);
    expect(calls.count).toBe(5);
    // After the cap the pane shows the plain button, as before.
    expect(q("conversation-scan-paused")).toBeNull();
    expect(loadEarlierButton()?.textContent ?? "").toContain("Load earlier messages");
  });

  it("a button press issues exactly one request, even when the page adds nothing", async () => {
    const { calls } = mountWithPages(
      { messages: [human(1)], hasEarlier: true, serverHumanView: false },
      () => ({ cursor: true }),
    );
    await settle();
    expect(calls.count).toBe(0);
    loadEarlierButton()!.click();
    await settle(30);
    expect(calls.count).toBe(1);
  });

  it("flag off: serverHumanView is ignored and nothing auto-fetches", async () => {
    const { calls } = mountWithPages(
      { messages: [], hasEarlier: true, serverHumanView: true, humanOnly: false },
      () => ({ cursor: true }),
    );
    await settle(30);
    expect(calls.count).toBe(0);
    expect(q("conversation-scan-paused")).toBeNull();
    loadEarlierButton()!.click();
    await settle(30);
    expect(calls.count).toBe(1);
  });
});
