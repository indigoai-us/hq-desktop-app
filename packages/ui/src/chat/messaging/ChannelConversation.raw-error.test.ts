// @vitest-environment happy-dom

/**
 * AUDIT-3c: a failed send must not put raw server/transport text in the
 * composer error line (or a title tooltip). The raw text goes to the log.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await tick();
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function dispatchPaste(el: HTMLElement, files: File[]): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { files, items: [], types: ["Files"] },
  });
  el.dispatchEvent(event);
}

describe("ChannelConversation send error", () => {
  it("shows plain copy instead of raw server text and logs the raw text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        messages: [],
        onsend: async () => {
          throw new Error(RAW);
        },
      },
    });
    await settle();
    const composer = host.querySelector('[data-testid="conversation-composer"]') as HTMLTextAreaElement;
    dispatchPaste(composer, [new File([new Uint8Array([1])], "report.pdf", { type: "application/pdf" })]);
    await settle();
    (host.querySelector('[data-testid="composer-send"]') as HTMLButtonElement).click();
    await settle();

    const error = host.querySelector(".composer-attach-error");
    expect(error?.textContent).toContain("Could not send the attachment. Try again.");
    expect(host.textContent).not.toContain("boom");
    expect(host.textContent).not.toContain("HTTP 500");
    for (const el of Array.from(host.querySelectorAll("[title]"))) {
      expect(el.getAttribute("title")).not.toContain("boom");
    }
    expect(warn.mock.calls.some((a) => a.some((x) => String(x).includes("boom")))).toBe(true);
  });
});
