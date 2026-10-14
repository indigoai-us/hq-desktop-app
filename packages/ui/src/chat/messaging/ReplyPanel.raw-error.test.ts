// @vitest-environment happy-dom

/**
 * AUDIT-3c: a failed thread load must not show raw transport/server text in
 * the reply-error line. The raw text goes to the log.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ReplyPanel from "./ReplyPanel.svelte";
import type { ConversationApi } from "../chat-api";

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

const root = {
  eventId: "evt_root",
  direction: "in",
  fromPersonUid: "prs_stefan",
  fromDisplayName: "Stefan Johnson",
  body: "thread",
  createdAt: "2026-09-18T22:00:00.000Z",
};

describe("ReplyPanel load error", () => {
  it("shows plain copy instead of raw server text and logs the raw text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = {
      fetchReplyThread: async () => {
        throw new Error(RAW);
      },
      sendReply: vi.fn(),
    } as unknown as ConversationApi;
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ReplyPanel, {
      target: host,
      props: {
        api,
        rootEventId: "evt_root",
        scope: "channel",
        channelId: "chn_1",
        seedRoot: root,
        selfDisplayName: "Corey",
        onclose: () => {},
      },
    });
    await vi.waitFor(() => {
      expect(host.querySelector(".reply-error")).toBeTruthy();
    });
    await tick();
    const error = host.querySelector(".reply-error");
    expect(error?.textContent).toContain("Could not load replies. Try again.");
    expect(host.textContent).not.toContain("boom");
    expect(host.textContent).not.toContain("HTTP 500");
    for (const el of Array.from(host.querySelectorAll("[title]"))) {
      expect(el.getAttribute("title")).not.toContain("boom");
    }
    expect(warn.mock.calls.some((a) => a.some((x) => String(x).includes("boom")))).toBe(true);
  });
});
