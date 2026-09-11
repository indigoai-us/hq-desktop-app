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
  it("uses the shared document-card shell, not chrome of its own", () => {
    mountCard({ text: LONG, kind: "prompt" });
    const card = host.querySelector("[data-artifact-card='true']");
    expect(card?.classList.contains("doc-card")).toBe(true);
    expect(host.querySelector(".doc-card-icon svg")).not.toBeNull();
    expect(host.querySelector(".artifact-tile-mesh")).toBeNull();
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
