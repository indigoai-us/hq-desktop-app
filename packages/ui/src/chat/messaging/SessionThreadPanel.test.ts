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
  it("quotes the origin message and closes", () => {
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

  it("shows the bound work-mesh task id", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const thread = createSessionThread({
      origin: { kind: "channel", channelId: "chn_1", channelTitle: "testing" },
      actorKind: "human",
      actorName: "Stefan",
      now: "2026-09-10T12:00:00.000Z",
    });
    thread.taskId = "US-017";
    thread.taskCreated = true;
    component = mount(SessionThreadPanel, {
      target: host,
      props: { thread, onclose: () => {} },
    }) as Record<string, unknown>;
    flushSync();
    expect(host.querySelector('[data-testid="session-thread-task"]')?.textContent).toContain(
      "US-017",
    );
  });
});
