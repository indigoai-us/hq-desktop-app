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
import {
  cachedGithubSummary,
  githubStatus,
  relativeAge,
  requestGithubSummary,
  resetGithubSummariesForTest,
  setGithubSummaryFetcher,
  type GithubLinkSummary,
} from "../../common/linkGithub";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  resetPageTitlesForTest();
  resetGithubSummariesForTest();
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
    expect(card.querySelector(".link-card-title")?.textContent).toBe("Weekly sync");
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

  it("shows the domain only once on a generic card without a fetched title", () => {
    const { card } = mountCard("https://example.com/blog/post");
    expect(card.querySelector(".link-card-kind")?.textContent).toBe("example.com");
    expect(card.querySelector(".link-card-title")?.textContent).toBe("blog/post");
    const bare = mountCard("https://example.org/").card;
    expect(bare.querySelector(".link-card-title")).toBeNull();
    expect(bare.getAttribute("aria-label")).toBe("example.org");
  });

  it("renders a GitHub PR header without repeating the repo or showing the URL", () => {
    const { card } = mountCard("https://github.com/indigoai-us/hq-desktop-app/pull/1512");
    expect(card.querySelector(".gh-repo")?.textContent).toBe("indigoai-us/hq-desktop-app");
    expect(card.querySelector(".gh-num")?.textContent).toBe("#1512");
    expect(card.querySelector(".link-card-kind")?.textContent).toBe("Pull request");
    // No fields grid, no raw URL, no repeated "owner/repo#n" title.
    expect(card.querySelector("dl")).toBeNull();
    expect(card.querySelector(".link-card-url")).toBeNull();
    expect(card.textContent).not.toContain("indigoai-us/hq-desktop-app#1512");
    expect(card.textContent).not.toContain("https://github.com");
  });

  it("renders live PR details: status, title, author, size and age", async () => {
    const href = "https://github.com/indigoai-us/hq-desktop-app/pull/1699";
    const summary: GithubLinkSummary = {
      kind: "pull",
      title: "Desktop usage meter and Settings > Usage",
      state: "open",
      review: "changes_requested",
      author: "coreyepstein",
      authorAvatar: "data:image/png;base64,AAAA",
      updatedAt: new Date(Date.now() - 16 * 3_600_000).toISOString(),
      additions: 2340,
      deletions: 161,
      changedFiles: 28,
    };
    const fetch = vi.fn(async () => summary);
    setGithubSummaryFetcher(fetch);
    requestGithubSummary(href);
    await vi.waitFor(() => expect(cachedGithubSummary(href)).toEqual(summary));
    const { card } = mountCard(href);
    expect(card.querySelector(".gh-pill")?.textContent?.trim()).toBe("Changes requested");
    expect(card.querySelector(".gh-pill")?.getAttribute("data-tone")).toBe("danger");
    expect(card.querySelector(".gh-title")?.textContent).toBe(summary.title);
    expect(card.querySelector(".gh-login")?.textContent).toBe("coreyepstein");
    expect(card.querySelector("img.gh-avatar")?.getAttribute("src")).toBe(summary.authorAvatar);
    expect(card.querySelector(".gh-add")?.textContent).toBe("+2,340");
    expect(card.querySelector(".gh-del")?.textContent).toBe("−161");
    const chips = [...card.querySelectorAll(".gh-chip")].map((c) => c.textContent?.replace(/\s+/g, " ").trim());
    expect(chips).toEqual(["+2,340 −161", "28 files"]);
    expect(card.querySelector(".gh-age")?.textContent).toBe("16h ago");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fills in issue details when they arrive after the card opened", async () => {
    const href = "https://github.com/acme/app/issues/7";
    let resolve!: (value: GithubLinkSummary) => void;
    setGithubSummaryFetcher(() => new Promise((r) => (resolve = r)));
    requestGithubSummary(href);
    const { card } = mountCard(href);
    expect(card.querySelector(".gh-title")).toBeNull();
    resolve({ kind: "issue", title: "Crash on launch", state: "completed", author: "sam", comments: 1 });
    await vi.waitFor(() => {
      flushSync();
      expect(card.querySelector(".gh-title")?.textContent).toBe("Crash on launch");
    });
    expect(card.querySelector(".gh-pill")?.textContent?.trim()).toBe("Closed");
    expect(card.querySelector(".gh-avatar-blank")?.textContent).toBe("S");
    expect([...card.querySelectorAll(".gh-chip")].map((c) => c.textContent)).toEqual(["1 comment"]);
  });

  it("keeps the parsed header when the lookup finds nothing", async () => {
    const href = "https://github.com/acme/private/pull/3";
    setGithubSummaryFetcher(async () => null);
    requestGithubSummary(href);
    await vi.waitFor(() => expect(cachedGithubSummary(href)).toBeNull());
    const { card } = mountCard(href);
    expect(card.querySelector(".gh-pill")).toBeNull();
    expect(card.querySelector(".gh-num")?.textContent).toBe("#3");
    expect([...card.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(["Open", "Copy link"]);
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

describe("GitHub link summaries", () => {
  it("asks the host at most once a minute per link", async () => {
    const href = "https://github.com/acme/app/pull/1";
    const fetch = vi.fn(async () => ({ kind: "pull", title: "t", state: "open" }) as GithubLinkSummary);
    setGithubSummaryFetcher(fetch);
    requestGithubSummary(href);
    requestGithubSummary(href);
    await vi.waitFor(() => expect(cachedGithubSummary(href)?.title).toBe("t"));
    requestGithubSummary(href);
    expect(fetch).toHaveBeenCalledTimes(1);
    requestGithubSummary(href, Date.now() + 61_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("maps states to pill labels and tones", () => {
    const pr = (state: GithubLinkSummary["state"], review: GithubLinkSummary["review"] = null) =>
      githubStatus({ kind: "pull", title: "t", state, review });
    expect(pr("open")).toEqual({ label: "Open", tone: "open" });
    expect(pr("open", "approved")).toEqual({ label: "Approved", tone: "open" });
    expect(pr("draft")).toEqual({ label: "Draft", tone: "muted" });
    expect(pr("merged")).toEqual({ label: "Merged", tone: "done" });
    expect(pr("closed")).toEqual({ label: "Closed", tone: "danger" });
    // A review decision only matters while the PR is open.
    expect(pr("merged", "changes_requested")).toEqual({ label: "Merged", tone: "done" });
    const issue = (state: GithubLinkSummary["state"]) => githubStatus({ kind: "issue", title: "t", state });
    expect(issue("completed")).toEqual({ label: "Closed", tone: "done" });
    expect(issue("not_planned")).toEqual({ label: "Not planned", tone: "muted" });
  });

  it("formats ages", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    expect(relativeAge(null, now)).toBe("");
    expect(relativeAge("2026-10-19T11:59:40Z", now)).toBe("just now");
    expect(relativeAge("2026-10-19T11:15:00Z", now)).toBe("45m ago");
    expect(relativeAge("2026-10-18T20:00:00Z", now)).toBe("16h ago");
    expect(relativeAge("2026-10-16T12:00:00Z", now)).toBe("3d ago");
  });
});
