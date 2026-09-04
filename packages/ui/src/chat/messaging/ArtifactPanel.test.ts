// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import ArtifactPanel from "./ArtifactPanel.svelte";
import { chatArtifact } from "./artifact-model.js";

const LONG = `${"Paragraph one.\n\n"}${"word ".repeat(400)}\n\nTAIL LINE`;

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function mountPanel(text = LONG, onclose = vi.fn()) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ArtifactPanel, {
    target: host,
    props: {
      artifact: chatArtifact({ text, eventId: "evt-1", kind: "details" }),
      onclose,
    },
  });
  flushSync();
  return onclose;
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.clearAllMocks();
});

describe("ArtifactPanel body", () => {
  it("renders the FULL content, untruncated", () => {
    mountPanel();
    const body =
      host.querySelector("[data-testid='artifact-panel-content']")
        ?.textContent ?? "";
    expect(body).toContain("Paragraph one.");
    expect(body).toContain("TAIL LINE");
    expect(body).not.toContain("…");
    expect(body.length).toBeGreaterThan(1500);
  });

  it("preserves blank lines and structure", () => {
    mountPanel();
    const pre = host.querySelector<HTMLElement>(
      "[data-testid='artifact-panel-content']",
    );
    expect(pre?.tagName).toBe("PRE");
    expect(pre?.textContent).toContain("\n\n");
  });

  it("shows the title, kind and size in the header", () => {
    mountPanel();
    expect(
      host.querySelector("[data-testid='artifact-panel-title']")?.textContent,
    ).toBe("Paragraph one.");
    expect(
      host.querySelector("[data-testid='artifact-panel-kind']")?.textContent,
    ).toBe("Details");
    expect(
      host.querySelector("[data-testid='artifact-panel-size']")?.textContent,
    ).toMatch(/chars/);
  });
});

describe("ArtifactPanel controls", () => {
  it("Copy writes the full content to the clipboard", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    mountPanel();
    host
      .querySelector<HTMLElement>("[data-testid='artifact-panel-copy']")
      ?.click();
    await Promise.resolve();
    await Promise.resolve();
    const written = writeText.mock.calls[0]?.[0] ?? "";
    expect(written).toContain("Paragraph one.");
    expect(written).toContain("TAIL LINE");
    expect(written.length).toBeGreaterThan(1500);
  });

  it("✕ closes the pane", () => {
    const onclose = mountPanel();
    host
      .querySelector<HTMLElement>("[data-testid='artifact-panel-close']")
      ?.click();
    flushSync();
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("Escape closes the pane", () => {
    const onclose = mountPanel();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    flushSync();
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("stops listening for Escape once unmounted", async () => {
    const onclose = mountPanel();
    if (component) await unmount(component);
    component = null;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onclose).not.toHaveBeenCalled();
  });
});
