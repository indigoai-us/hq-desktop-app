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

describe("ArtifactCard markdown preview", () => {
  it("renders markdown artifacts as a document, not as monospace text", () => {
    mountCard({ text: MARKDOWN });
    const preview = host.querySelector<HTMLElement>(
      "[data-testid='artifact-card-preview']",
    );
    expect(preview?.tagName).not.toBe("PRE");
    expect(preview?.getAttribute("data-render")).toBe("markdown");
    expect(preview?.classList.contains("artifact-md")).toBe(true);
    expect(preview?.querySelector("h2")?.textContent).toBe("Where things stand");
    expect(preview?.querySelectorAll("li").length).toBe(2);
    expect(preview?.querySelector("strong")?.textContent).toBe(
      "hq-pro production",
    );
    expect(preview?.querySelector("table")).not.toBeNull();
    // The card never repeats the raw `#` / `**` syntax.
    expect(preview?.textContent).not.toContain("**");
    expect(preview?.textContent).not.toContain("# Work");
  });

  it("fades a markdown preview and keeps the tail for the pane", () => {
    mountCard({ text: MARKDOWN });
    const preview =
      host.querySelector("[data-testid='artifact-card-preview']")
        ?.textContent ?? "";
    expect(preview).not.toContain("TAIL");
    expect(host.querySelector(".artifact-card-fade")).not.toBeNull();
    expect(host.querySelector(".artifact-card.is-markdown")).not.toBeNull();
  });

  it("keeps plain artifacts line-preserving in the UI face (no mono class)", () => {
    mountCard({ text: LONG });
    const preview = host.querySelector<HTMLElement>(
      "[data-testid='artifact-card-preview']",
    );
    expect(preview?.tagName).toBe("PRE");
    expect(preview?.getAttribute("data-render")).toBe("plain");
    expect(preview?.classList.contains("artifact-plain")).toBe(true);
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

  it("previews a few lines, faded — not hard-clamped with a bare ellipsis", () => {
    mountCard({ text: LONG });
    const preview =
      host.querySelector("[data-testid='artifact-card-preview']")
        ?.textContent ?? "";
    expect(preview).toContain("Legal page change request");
    expect(preview).not.toContain("…");
    expect(preview).not.toContain("TAIL");
    // A fade element stands in for the removed truncation marker.
    expect(host.querySelector(".artifact-card-fade")).not.toBeNull();
    expect(host.querySelector(".artifact-card.has-more")).not.toBeNull();
  });

  it("omits the fade when the whole artifact already fits", () => {
    mountCard({ text: "one\ntwo" });
    expect(host.querySelector(".artifact-card-fade")).toBeNull();
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
