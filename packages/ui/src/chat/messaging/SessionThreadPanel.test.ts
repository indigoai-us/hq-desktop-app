// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("svelte", async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import("../../../node_modules/svelte/src/index-client.js");
});

import { flushSync, mount, unmount } from "svelte";
import SessionThreadPanel from "./SessionThreadPanel.svelte";
import { createSessionThread } from "./session-thread";

let host: HTMLElement;
let component: Record<string, unknown> | null = null;

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
});

describe("SessionThreadPanel", () => {
  it("opens from a message with the quote and closes", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const onclose = vi.fn();
    const thread = createSessionThread({
      origin: {
        kind: "message",
        eventId: "evt_1",
        excerpt: "How did you build sessions?",
        author: "Stefan Johnson",
      },
      actorKind: "human",
      actorName: "Stefan Johnson",
      now: "2026-09-10T12:00:00.000Z",
    });
    component = mount(SessionThreadPanel, {
      target: host,
      props: { thread, onclose },
    }) as Record<string, unknown>;
    flushSync();
    expect(host.querySelector('[data-testid="session-thread-panel"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="session-thread-origin"]')?.textContent).toContain(
      "How did you build sessions?",
    );
    (host.querySelector('[data-testid="session-thread-close"]') as HTMLButtonElement).click();
    flushSync();
    expect(onclose).toHaveBeenCalled();
  });

  it("sends a prompt from the composer", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const onprompt = vi.fn();
    const thread = createSessionThread({
      origin: { kind: "channel", channelId: "chn_1", channelTitle: "hq-desktop-sessions-testing" },
      actorKind: "agent",
      actorName: "Deacon",
      now: "2026-09-10T12:00:00.000Z",
    });
    component = mount(SessionThreadPanel, {
      target: host,
      props: { thread, onclose: () => {}, onprompt },
    }) as Record<string, unknown>;
    flushSync();
    const input = host.querySelector(
      '[data-testid="session-thread-composer"]',
    ) as HTMLTextAreaElement;
    input.value = "look at US-008";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    (host.querySelector('[data-testid="session-thread-send"]') as HTMLButtonElement).click();
    flushSync();
    expect(onprompt).toHaveBeenCalledWith(thread, "look at US-008");
  });
});
