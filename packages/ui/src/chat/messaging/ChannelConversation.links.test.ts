// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document
    .querySelectorAll('[data-testid="link-context-menu"]')
    .forEach((node) => node.remove());
});

function mountWith(props: Record<string, unknown>): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: { messages: [], ...props },
  });
  return host;
}

function linkMessage(body = "see https://example.com/docs") {
  return {
    eventId: "evt_link",
    direction: "in" as const,
    fromPersonUid: "prs_ada",
    fromDisplayName: "Ada",
    body,
    createdAt: "2026-08-28T01:14:00.000Z",
  };
}

async function mountLinked(onopenurl = vi.fn()) {
  const root = mountWith({
    messages: [linkMessage()],
    onopenurl,
  });
  await tick();
  const anchor = root.querySelector(
    ".dm-bubble-body a[href]",
  ) as HTMLAnchorElement | null;
  expect(anchor).not.toBeNull();
  return { root, anchor: anchor!, onopenurl };
}

describe("ChannelConversation body links", () => {
  it("opens a bare URL via onopenurl and prevents default navigation", async () => {
    const { anchor, onopenurl } = await mountLinked();
    expect(anchor.getAttribute("href")).toBe("https://example.com/docs");

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    const propagated = anchor.dispatchEvent(event);
    await tick();

    expect(onopenurl).toHaveBeenCalledTimes(1);
    expect(onopenurl).toHaveBeenCalledWith("https://example.com/docs");
    expect(event.defaultPrevented).toBe(true);
    expect(propagated).toBe(false);
  });

  it("right-click shows Open Link and Copy Link and prevents the native menu", async () => {
    const { anchor, onopenurl } = await mountLinked();
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 24,
      clientY: 16,
    });
    const propagated = anchor.dispatchEvent(event);
    await tick();

    const menu = document.querySelector('[data-testid="link-context-menu"]');
    expect(menu).toBeTruthy();
    expect(
      document.querySelector('[data-testid="link-context-open"]')?.textContent,
    ).toContain("Open Link");
    expect(
      document.querySelector('[data-testid="link-context-copy"]')?.textContent,
    ).toContain("Copy Link");
    expect(event.defaultPrevented).toBe(true);
    expect(propagated).toBe(false);
    expect(onopenurl).not.toHaveBeenCalled();
  });

  it("Open Link calls the external opener with the href", async () => {
    const { anchor, onopenurl } = await mountLinked();
    anchor.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 24,
        clientY: 16,
      }),
    );
    await tick();
    document
      .querySelector<HTMLButtonElement>('[data-testid="link-context-open"]')!
      .click();
    await tick();
    expect(onopenurl).toHaveBeenCalledTimes(1);
    expect(onopenurl).toHaveBeenCalledWith("https://example.com/docs");
    expect(document.querySelector('[data-testid="link-context-menu"]')).toBeNull();
  });

  it("Copy Link writes the href to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { anchor, onopenurl } = await mountLinked();
    anchor.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 24,
        clientY: 16,
      }),
    );
    await tick();
    document
      .querySelector<HTMLButtonElement>('[data-testid="link-context-copy"]')!
      .click();
    await tick();
    expect(writeText).toHaveBeenCalledWith("https://example.com/docs");
    expect(onopenurl).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="link-context-menu"]')).toBeNull();
  });

  it("right-click on plain text does not render the custom menu", async () => {
    const root = mountWith({
      messages: [linkMessage("just words, no url")],
      onopenurl: vi.fn(),
    });
    await tick();
    const body = root.querySelector(".dm-bubble-body") as HTMLElement;
    expect(body.querySelector("a[href]")).toBeNull();
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    body.dispatchEvent(event);
    await tick();
    expect(document.querySelector('[data-testid="link-context-menu"]')).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  it("cmd-click and middle-click open externally", async () => {
    const { anchor, onopenurl } = await mountLinked();
    const cmd = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    expect(anchor.dispatchEvent(cmd)).toBe(false);
    expect(cmd.defaultPrevented).toBe(true);
    expect(onopenurl).toHaveBeenCalledWith("https://example.com/docs");

    onopenurl.mockClear();
    const middle = new MouseEvent("auxclick", {
      bubbles: true,
      cancelable: true,
      button: 1,
    });
    expect(anchor.dispatchEvent(middle)).toBe(false);
    expect(middle.defaultPrevented).toBe(true);
    expect(onopenurl).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("ignores a non-http scheme", async () => {
    const { root, onopenurl } = await mountLinked();
    const body = root.querySelector(".dm-bubble-body") as HTMLElement;
    const bad = document.createElement("a");
    bad.setAttribute("href", "javascript:alert(1)");
    bad.textContent = "bad";
    body.appendChild(bad);

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    bad.dispatchEvent(click);
    await tick();
    expect(onopenurl).not.toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(true);

    const menuEvt = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    bad.dispatchEvent(menuEvt);
    await tick();
    expect(document.querySelector('[data-testid="link-context-menu"]')).toBeNull();
    expect(onopenurl).not.toHaveBeenCalled();
  });
});
