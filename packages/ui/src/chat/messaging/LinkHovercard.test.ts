// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import LinkHovercard from "./LinkHovercard.svelte";
import { LinkHovercardController } from "./linkHovercardController.svelte";
import { linkPreview } from "../../common/linkPreview";
import {
  cachedPageTitle,
  onPageTitle,
  requestPageTitle,
  resetPageTitlesForTest,
  setPageTitleFetcher,
} from "../../common/linkTitles";
import { renderMessageBodyMarkdown } from "../../common/messageMarkdown";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  resetPageTitlesForTest();
  vi.useRealTimers();
});

function mountCard(href: string, extra: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const props = {
    id: "card-1",
    href,
    preview: linkPreview(href)!,
    rect: { left: 10, top: 10, bottom: 30, width: 100 },
    onopen: vi.fn(),
    oncopy: vi.fn(),
    ...extra,
  };
  component = mount(LinkHovercard, { target: host, props: props as never });
  flushSync();
  return { card: host.querySelector<HTMLElement>("[data-link-card]")!, props };
}

describe("LinkHovercard render", () => {
  it("renders a calendar card with fields and an Add to calendar action", () => {
    const href =
      "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Weekly+sync&dates=20261009T170000Z/20261009T173000Z&ctz=America/New_York&location=Zoom";
    const { card, props } = mountCard(href);
    expect(card.getAttribute("id")).toBe("card-1");
    expect(card.getAttribute("data-provider")).toBe("calendar");
    expect(card.querySelector(".link-card-kind")?.textContent).toBe("Calendar event");
    expect(card.querySelector(".link-card-title")?.textContent).toBe("Weekly sync · Fri, Oct 9");
    const labels = [...card.querySelectorAll("dt")].map((dt) => dt.textContent);
    expect(labels).toEqual(["Date", "Time", "Time zone", "Location"]);
    // Stroke icon only, no emoji or image.
    const icon = card.querySelector("svg.link-card-icon")!;
    expect(icon.getAttribute("fill")).toBe("none");
    expect(icon.getAttribute("stroke")).toBe("currentColor");

    const add = [...card.querySelectorAll("button")].find((b) => b.textContent === "Add to calendar")!;
    add.click();
    expect(props.onopen).toHaveBeenCalledWith(href);
  });

  it("renders a GitHub PR card from parsed fields", () => {
    const { card } = mountCard("https://github.com/indigoai-us/hq-desktop-app/pull/1512");
    expect(card.querySelector(".link-card-title")?.textContent).toBe(
      "indigoai-us/hq-desktop-app#1512",
    );
    const values = [...card.querySelectorAll("dd")].map((dd) => dd.textContent);
    expect(values).toEqual(["indigoai-us/hq-desktop-app", "#1512"]);
  });

  it("renders a generic card with the full URL, Open and Copy link", async () => {
    const href = "https://example.com/blog/post";
    const { card, props } = mountCard(href, { pageTitle: "A real page title" });
    expect(card.querySelector(".link-card-title")?.textContent).toBe("A real page title");
    expect(card.querySelector(".link-card-url")?.textContent).toBe(href);
    const buttons = [...card.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Open", "Copy link"]);
    buttons[1].click();
    expect(props.oncopy).toHaveBeenCalledWith(href);
    await vi.waitFor(() => {
      flushSync();
      expect(buttons[1].textContent?.trim()).toBe("Copied");
    });
  });

  it("does not move focus when it appears", () => {
    const before = document.activeElement;
    mountCard("https://example.com/");
    expect(document.activeElement).toBe(before);
  });
});

describe("LinkHovercardController", () => {
  function setup() {
    host = document.createElement("div");
    host.innerHTML = renderMessageBodyMarkdown("see https://github.com/acme/app/pull/7 now");
    document.body.appendChild(host);
    const controller = new LinkHovercardController();
    host.addEventListener("focusin", controller.onfocusin);
    host.addEventListener("focusout", controller.onfocusout);
    host.addEventListener("pointerover", controller.onpointerover as EventListener);
    host.addEventListener("pointerout", controller.onpointerout as EventListener);
    host.addEventListener("keydown", (e) => controller.onkeydown(e));
    const anchor = host.querySelector<HTMLAnchorElement>("a[data-link-preview]")!;
    return { controller, anchor };
  }

  it("renders the readable label in the message body", () => {
    const { anchor } = setup();
    expect(anchor.textContent).toBe("acme/app#7");
    expect(anchor.getAttribute("href")).toBe("https://github.com/acme/app/pull/7");
  });

  it("opens on keyboard focus and closes on Escape", () => {
    const { controller, anchor } = setup();
    anchor.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(controller.card?.href).toBe("https://github.com/acme/app/pull/7");
    expect(anchor.getAttribute("aria-describedby")).toBe(controller.id);

    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    anchor.dispatchEvent(escape);
    expect(controller.card).toBeNull();
    expect(escape.defaultPrevented).toBe(true);
    expect(anchor.hasAttribute("aria-describedby")).toBe(false);
  });

  it("opens on hover after a delay and closes after the pointer leaves", () => {
    vi.useFakeTimers();
    const { controller, anchor } = setup();
    anchor.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    expect(controller.card).toBeNull();
    vi.advanceTimersByTime(400);
    expect(controller.card?.preview.provider).toBe("github");
    anchor.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: host }));
    vi.advanceTimersByTime(250);
    expect(controller.card).toBeNull();
  });

  it("does not handle Escape when no card is open", () => {
    const { controller } = setup();
    const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    expect(controller.onkeydown(escape)).toBe(false);
    expect(escape.defaultPrevented).toBe(false);
  });
});

describe("linkTitles cache", () => {
  it("fetches through the host fetcher once and notifies listeners", async () => {
    const fetcher = vi.fn().mockResolvedValue("  Fetched title  ");
    setPageTitleFetcher(fetcher);
    const listener = vi.fn();
    onPageTitle(listener);
    requestPageTitle("https://example.com/a");
    requestPageTitle("https://example.com/a");
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cachedPageTitle("https://example.com/a")).toBe("Fetched title");
    requestPageTitle("https://example.com/a");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("caches failures and does nothing without a fetcher", async () => {
    requestPageTitle("https://example.com/none");
    expect(cachedPageTitle("https://example.com/none")).toBeUndefined();

    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
    setPageTitleFetcher(fetcher);
    requestPageTitle("https://example.com/b");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    requestPageTitle("https://example.com/b");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cachedPageTitle("https://example.com/b")).toBeUndefined();
  });
});
