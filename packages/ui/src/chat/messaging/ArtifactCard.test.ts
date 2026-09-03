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
    const artifact = onopen.mock.calls[0][0] as ChatArtifact;
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
    const writeText = vi.fn(async () => {});
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
