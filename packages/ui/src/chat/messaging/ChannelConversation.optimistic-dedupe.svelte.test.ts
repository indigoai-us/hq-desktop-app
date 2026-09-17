// @vitest-environment happy-dom

/**
 * Regression: an optimistic send must never leave a duplicate of the user's own
 * message.
 *
 * Temp rows carry synthetic ids (`local-send-N`) and the timeline dedupe keys
 * purely on `eventId`, so a temp row can never reconcile against the server
 * echo by id. The perf branch made the sweep of `localSends` conditional on the
 * NEWEST event id changing — so an echo that does not sort last (clock skew, or
 * a concurrent inbound message landing after it) left the temp row on screen and
 * the user saw their own message twice.
 *
 * The removal must key on positive reconciliation (author + body + close
 * timestamp), not on newest-id identity.
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

const SELF_UID = "prs_self";

function bodies(root: HTMLElement): string[] {
  return [...root.querySelectorAll('[data-testid="conversation-message"]')].map(
    (row) => row.textContent ?? "",
  );
}

describe("ChannelConversation optimistic send reconciliation", () => {
  it("drops the temp row when the echo is not the newest message", async () => {
    const now = Date.now();
    // Already on screen, and (server clock) stamped slightly ahead of the echo
    // that is about to arrive — so the echo sorts BEFORE it and the newest
    // event id never changes.
    const existing: ConversationMessageWire = {
      eventId: "evt_existing",
      direction: "in",
      fromPersonUid: "prs_ada",
      fromDisplayName: "Ada",
      body: "earlier chatter",
      createdAt: new Date(now + 2000).toISOString(),
    } as ConversationMessageWire;

    const props = $state({
      messages: [existing] as ConversationMessageWire[],
      selfPersonUid: SELF_UID,
      selfDisplayName: "Operator",
      onsend: async () => undefined,
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, { target: host, props });
    await tick();

    const composer = host.querySelector(
      '[data-testid="conversation-composer"]',
    ) as HTMLTextAreaElement;
    composer.value = "ship it";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    (
      host.querySelector('[data-testid="composer-send"]') as HTMLButtonElement
    ).click();
    await tick();
    await tick();

    // Optimistic row is on screen.
    expect(bodies(host).filter((t) => t.includes("ship it"))).toHaveLength(1);

    // The host repolls: the server echo lands, but BEHIND `evt_existing`, so
    // `messages.at(-1)` is unchanged.
    const echo: ConversationMessageWire = {
      eventId: "evt_echo",
      direction: "out",
      fromPersonUid: SELF_UID,
      fromDisplayName: "Operator",
      body: "ship it",
      createdAt: new Date(now).toISOString(),
    } as ConversationMessageWire;
    props.messages = [echo, existing];
    await tick();
    await tick();

    expect(bodies(host).filter((t) => t.includes("ship it"))).toHaveLength(1);
  });

  it("keeps an unreconciled temp row visible while the send is in flight", async () => {
    const props = $state({
      messages: [] as ConversationMessageWire[],
      selfPersonUid: SELF_UID,
      selfDisplayName: "Operator",
      onsend: async () => undefined,
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, { target: host, props });
    await tick();

    const composer = host.querySelector(
      '[data-testid="conversation-composer"]',
    ) as HTMLTextAreaElement;
    composer.value = "still pending";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    (
      host.querySelector('[data-testid="composer-send"]') as HTMLButtonElement
    ).click();
    await tick();
    await tick();

    // An unrelated inbound message arrives; the user's own row must survive.
    props.messages = [
      {
        eventId: "evt_other",
        direction: "in",
        fromPersonUid: "prs_ada",
        fromDisplayName: "Ada",
        body: "unrelated",
        createdAt: new Date().toISOString(),
      } as ConversationMessageWire,
    ];
    await tick();
    await tick();

    expect(bodies(host).filter((t) => t.includes("still pending"))).toHaveLength(
      1,
    );
  });
});
