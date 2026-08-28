// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function mountComposer(onsend?: (body: string) => void): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: {
      messages: [],
      onsend,
    },
  });
  return host;
}

describe("ChannelConversation composer", () => {
  it("enables send after input and submits the draft", async () => {
    const sent: string[] = [];
    const root = mountComposer((body) => {
      sent.push(body);
    });
    await tick();
    const composer = root.querySelector(
      '[data-testid="conversation-composer"]',
    ) as HTMLTextAreaElement;
    const sendBtn = root.querySelector(
      '[data-testid="composer-send"]',
    ) as HTMLButtonElement;
    expect(sendBtn.getAttribute("aria-disabled")).toBe("true");
    expect(composer.getAttribute("data-gramm")).toBe("false");
    expect(composer.getAttribute("data-enable-grammarly")).toBe("false");
    composer.value = "hello deacon";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(sendBtn.getAttribute("aria-disabled")).toBe("false");
    sendBtn.click();
    await tick();
    expect(sent).toEqual(["hello deacon"]);
  });

  it("sends the native textarea value on Enter even if bind lagged", async () => {
    const sent: string[] = [];
    const root = mountComposer((body) => {
      sent.push(body);
    });
    await tick();
    const composer = root.querySelector(
      '[data-testid="conversation-composer"]',
    ) as HTMLTextAreaElement;
    composer.value = "typed without svelte bind";
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await tick();
    expect(sent).toEqual(["typed without svelte bind"]);
  });

  it("keeps the send control clickable so a DOM-synced draft can submit", async () => {
    const sent: string[] = [];
    const root = mountComposer((body) => {
      sent.push(body);
    });
    await tick();
    const composer = root.querySelector(
      '[data-testid="conversation-composer"]',
    ) as HTMLTextAreaElement;
    const sendBtn = root.querySelector(
      '[data-testid="composer-send"]',
    ) as HTMLButtonElement;
    composer.value = "click send";
    expect(sendBtn.disabled).toBe(false);
    sendBtn.click();
    await tick();
    expect(sent).toEqual(["click send"]);
  });
});
