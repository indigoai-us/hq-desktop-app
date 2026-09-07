// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import ArtifactPanel from "./ArtifactPanel.svelte";
import { chatArtifact } from "./artifact-model.js";

const LONG = `${"Paragraph one.\n\n"}${"word ".repeat(400)}\n\nTAIL LINE`;

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function mountPanel(
  text = LONG,
  onclose = vi.fn(),
  onopenurl?: (url: string) => void,
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ArtifactPanel, {
    target: host,
    props: {
      artifact: chatArtifact({ text, eventId: "evt-1", kind: "details" }),
      onclose,
      onopenurl,
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

const MARKDOWN = [
  "# Handoff",
  "",
  "Paragraph with `code` and **bold**.",
  "",
  "1. first",
  "2. second",
  "",
  "```sh",
  "hq mesh session status",
  "```",
  "",
  "TAIL LINE",
].join("\n");

describe("ArtifactPanel markdown", () => {
  it("renders a markdown artifact as a full document", () => {
    mountPanel(MARKDOWN);
    const body = host.querySelector<HTMLElement>(
      "[data-testid='artifact-panel-content']",
    );
    expect(body?.tagName).toBe("ARTICLE");
    expect(body?.getAttribute("data-render")).toBe("markdown");
    expect(body?.classList.contains("artifact-md")).toBe(true);
    expect(body?.querySelector("h1")?.textContent).toBe("Handoff");
    expect(body?.querySelectorAll("ol li").length).toBe(2);
    expect(body?.querySelector("pre code")?.textContent).toContain(
      "hq mesh session status",
    );
    expect(body?.querySelector("strong")?.textContent).toBe("bold");
    expect(body?.textContent).toContain("TAIL LINE");
    expect(body?.textContent).not.toContain("**");
  });

  it("copies the raw markdown source, not the rendered text", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    mountPanel(MARKDOWN);
    host
      .querySelector<HTMLElement>("[data-testid='artifact-panel-copy']")
      ?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(MARKDOWN);
  });

  it("routes markdown links through the host opener instead of navigating", () => {
    const onopenurl = vi.fn();
    mountPanel("# Doc\n\nSee [the runbook](https://example.test/runbook).", vi.fn(), onopenurl);
    const a = host.querySelector<HTMLAnchorElement>(
      "[data-testid='artifact-panel-content'] a",
    );
    expect(a?.getAttribute("href")).toBe("https://example.test/runbook");
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    a?.dispatchEvent(ev);
    expect(onopenurl).toHaveBeenCalledWith("https://example.test/runbook");
    expect(ev.defaultPrevented).toBe(true);
  });

  it("skips the markdown pass for oversized dumps", () => {
    mountPanel(`# Big\n\n${"- line\n".repeat(40_000)}`);
    expect(
      host.querySelector("[data-testid='artifact-panel-content']")
        ?.getAttribute("data-render"),
    ).toBe("plain");
  });
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
