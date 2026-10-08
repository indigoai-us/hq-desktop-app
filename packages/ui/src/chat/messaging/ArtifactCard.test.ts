// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import ArtifactCard from "./ArtifactCard.svelte";
import type { ArtifactKind, ChatArtifact } from "./artifact-model.js";

const LONG = [
  "Legal page change request",
  "The terms of service must say that these are a binding agreement",
  "between the customer and the company.",
  "line 4",
  "line 5",
  "line 6",
  "TAIL — this text was unreachable before the artifact pane",
].join("\n");

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function mountCard(props: {
  text: string;
  eventId?: string;
  kind?: ArtifactKind;
  onopen?: (a: ChatArtifact) => void;
}): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ArtifactCard, {
    target: host,
    props: { eventId: "evt-1", kind: "details", ...props },
  });
  flushSync();
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.clearAllMocks();
});

const MARKDOWN = [
  "# Work Mesh Live — engineering handoff",
  "",
  "Rollout is complete on every surface.",
  "",
  "## Where things stand",
  "",
  "- **hq-pro production** deployed and quiet.",
  "- Fleet daemons idle under 1 percent CPU.",
  "",
  "| Check | Expected |",
  "| --- | --- |",
  "| Session status | bound |",
  "",
  "line 14",
  "line 15",
  "line 16",
  "line 17",
  "line 18",
  "TAIL — only in the pane",
].join("\n");

describe("ArtifactCard collapsed summary", () => {
  it("shows a one-line plain-text summary with markdown syntax stripped", () => {
    mountCard({ text: MARKDOWN });
    const summary = host.querySelector<HTMLElement>(
      "[data-testid='artifact-card-preview']",
    );
    expect(summary?.textContent).toBe("Rollout is complete on every surface.");
    expect(summary?.textContent).not.toContain("#");
    expect(summary?.textContent).not.toContain("**");
    // The card is a handle — no preview body, no fade, no rendered blocks.
    expect(host.querySelector(".artifact-card-fade")).toBeNull();
    expect(host.querySelector("h2, ul, table, pre")).toBeNull();
    expect(host.textContent).not.toContain("TAIL");
  });

  it("starts the summary after the title line for plain artifacts", () => {
    mountCard({ text: LONG });
    const summary =
      host.querySelector("[data-testid='artifact-card-preview']")?.textContent ??
      "";
    expect(summary).toContain("The terms of service must say");
    expect(summary).not.toContain("Legal page change request");
    expect(summary).not.toContain("TAIL");
  });

  it("omits the summary line when the artifact is only a title", () => {
    mountCard({ text: "# Just a heading" });
    expect(host.querySelector("[data-testid='artifact-card-preview']")).toBeNull();
    expect(
      host.querySelector("[data-testid='artifact-card-title']")?.textContent,
    ).toBe("Just a heading");
  });

  // The card shares `doc-card.css` with the file attachment card — the two
  // say the same thing to the reader, so they are the same object. It used to
  // carry an animated gradient mesh tile, the only gradient in the shell.
  it("uses the shared document-card shell and icon well, not a mesh tile", () => {
    mountCard({ text: LONG, kind: "prompt" });
    const card = host.querySelector("[data-artifact-card='true']");
    expect(card?.classList.contains("doc-card")).toBe(true);
    expect(
      host.querySelector('.doc-card-icon svg[data-rail-icon="terminal-window"]'),
    ).not.toBeNull();
    expect(host.querySelector(".artifact-tile, .artifact-tile-mesh")).toBeNull();
    expect(card?.getAttribute("data-kind")).toBe("prompt");
  });
});

describe("ArtifactCard chrome", () => {
  it("renders a title, a kind label and a size hint", () => {
    mountCard({ text: LONG });
    expect(
      host.querySelector("[data-testid='artifact-card-title']")?.textContent,
    ).toBe("Legal page change request");
    expect(
      host.querySelector("[data-testid='artifact-card-kind']")?.textContent,
    ).toBe("Details");
    const size =
      host.querySelector("[data-testid='artifact-card-size']")?.textContent ??
      "";
    expect(size).toContain("7 lines");
    expect(size).toMatch(/chars/);
  });

  it("exposes an accessible button role plus an explicit Open control", () => {
    mountCard({ text: LONG });
    const card = host.querySelector<HTMLElement>("[data-artifact-card='true']");
    expect(card?.getAttribute("role")).toBe("button");
    expect(card?.getAttribute("tabindex")).toBe("0");
    expect(card?.getAttribute("aria-label")).toContain("Legal page change");
    expect(
      host.querySelector("[data-testid='artifact-card-open']"),
    ).not.toBeNull();
  });
});

describe("ArtifactCard opening", () => {
  it("bubbles the FULL untruncated content on click", () => {
    const onopen = vi.fn();
    mountCard({ text: LONG, onopen });
    host
      .querySelector<HTMLElement>("[data-artifact-card='true']")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    flushSync();
    expect(onopen).toHaveBeenCalledTimes(1);
    const artifact = onopen.mock.calls[0]?.[0] as ChatArtifact;
    expect(artifact.text).toBe(LONG);
    expect(artifact.text).toContain("TAIL");
    expect(artifact.id).toBe("evt-1:details");
  });

  it("opens on Enter and on Space", () => {
    const onopen = vi.fn();
    mountCard({ text: LONG, onopen });
    const card = host.querySelector<HTMLElement>("[data-artifact-card='true']");
    card?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    card?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    flushSync();
    expect(onopen).toHaveBeenCalledTimes(2);
  });

  it("opens from the explicit Open control without double-firing", () => {
    const onopen = vi.fn();
    mountCard({ text: LONG, onopen });
    host
      .querySelector<HTMLElement>("[data-testid='artifact-card-open']")
      ?.click();
    flushSync();
    expect(onopen).toHaveBeenCalledTimes(1);
  });

  it("copies the full content without opening the pane", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const onopen = vi.fn();
    mountCard({ text: LONG, onopen });
    host
      .querySelector<HTMLElement>("[data-testid='message-details-copy']")
      ?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(LONG);
    expect(onopen).not.toHaveBeenCalled();
  });
});

describe("ArtifactCard actions", () => {
  // Copy / Open used to be words; a run of cards read as a toolbar competing
  // with the titles. They are icon buttons now, named by aria-label + tooltip.
  it("renders Copy and Open as icon-only buttons", () => {
    mountCard({ text: LONG });
    const copy = host.querySelector<HTMLButtonElement>(
      "[data-testid='message-details-copy']",
    );
    const openBtn = host.querySelector<HTMLButtonElement>(
      "[data-testid='artifact-card-open']",
    );
    for (const btn of [copy, openBtn]) {
      expect(btn?.classList.contains("doc-card-btn")).toBe(true);
      expect(btn?.textContent?.trim()).toBe("");
      expect(btn?.querySelector("svg")).not.toBeNull();
    }
    expect(copy?.getAttribute("aria-label")).toBe("Copy details");
    expect(openBtn?.getAttribute("aria-label")).toBe("Open details in side pane");
    expect(host.querySelector(".doc-card-actions")).not.toBeNull();
  });

  it("names each icon button with a tooltip on keyboard focus", () => {
    mountCard({ text: LONG });
    const copy = host.querySelector<HTMLButtonElement>(
      "[data-testid='message-details-copy']",
    )!;
    copy.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    flushSync();
    const tip = host.querySelector<HTMLElement>("[data-testid='tooltip-bubble']");
    expect(tip?.textContent?.trim()).toBe("Copy");
    expect(copy.getAttribute("aria-describedby")).toBe(tip?.id);

    copy.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    const openBtn = host.querySelector<HTMLButtonElement>(
      "[data-testid='artifact-card-open']",
    )!;
    openBtn.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    flushSync();
    expect(
      host.querySelector("[data-testid='tooltip-bubble']")?.textContent?.trim(),
    ).toBe("Open");
  });

  // The actions are keyboard reachable, so Enter on one of them must press
  // that button — not bubble to the card and open the pane instead.
  it("leaves Enter on the Copy button to the button", () => {
    const onopen = vi.fn();
    mountCard({ text: LONG, onopen });
    const copy = host.querySelector<HTMLButtonElement>(
      "[data-testid='message-details-copy']",
    )!;
    const ev = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    copy.dispatchEvent(ev);
    flushSync();
    expect(onopen).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
});
