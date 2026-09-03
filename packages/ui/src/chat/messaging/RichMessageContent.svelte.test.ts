// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import RichMessageContent from "./RichMessageContent.svelte";
import { parseRichContent } from "./richMessageContent.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function render(raw: unknown): HTMLElement {
  const content = parseRichContent(raw);
  if (!content) throw new Error("fixture did not parse");
  host = document.createElement("div");
  host.className = "chat-shell";
  document.body.appendChild(host);
  component = mount(RichMessageContent, { target: host, props: { content } });
  return host;
}

describe("RichMessageContent renders each block type from fixture data", () => {
  it("renders stat tiles with label, value, and delta", async () => {
    const el = render({
      v: 1,
      blocks: [
        {
          kind: "stat",
          items: [{ label: "MRR", value: "$42k", delta: "+12%", trend: "up" }],
        },
      ],
    });
    await tick();
    expect(el.querySelector('[data-testid="rich-stat"]')).not.toBeNull();
    expect(el.querySelector(".rich-stat-label")?.textContent).toBe("MRR");
    expect(el.querySelector(".rich-stat-value")?.textContent).toBe("$42k");
    expect(el.querySelector(".rich-stat-delta")?.textContent?.trim()).toBe("+12%");
    expect(el.querySelector(".rich-stat-delta")?.classList.contains("trend-up")).toBe(
      true,
    );
  });

  it("renders a table with headers and rows", async () => {
    const el = render({
      v: 1,
      blocks: [
        {
          kind: "table",
          columns: ["Repo", "PRs"],
          rows: [
            ["hq-pro", "12"],
            ["hq-desktop-app", "7"],
          ],
        },
      ],
    });
    await tick();
    expect(el.querySelectorAll('[data-testid="rich-table"] thead th')).toHaveLength(2);
    expect(el.querySelectorAll('[data-testid="rich-table"] tbody tr')).toHaveLength(2);
    expect(el.querySelector("tbody td")?.textContent).toBe("hq-pro");
  });

  it("renders a chart as inline SVG (line paths, no external lib)", async () => {
    const el = render({
      v: 1,
      blocks: [
        {
          kind: "chart",
          chartType: "line",
          series: [{ name: "Signups", data: [1, 4, 2, 6] }],
        },
      ],
    });
    await tick();
    const svg = el.querySelector('[data-testid="rich-chart"] svg');
    expect(svg).not.toBeNull();
    expect(svg?.querySelector("path")).not.toBeNull();
  });

  it("renders a bar chart as rects", async () => {
    const el = render({
      v: 1,
      blocks: [
        {
          kind: "chart",
          chartType: "bar",
          series: [{ name: "x", data: [3, 1, 4] }],
        },
      ],
    });
    await tick();
    expect(
      el.querySelectorAll('[data-testid="rich-chart"] svg rect').length,
    ).toBeGreaterThan(0);
  });

  it("does not execute or emit raw markup from string cell data", async () => {
    const el = render({
      v: 1,
      blocks: [
        {
          kind: "table",
          columns: ["c"],
          rows: [["<img src=x onerror=alert(1)>"]],
        },
      ],
    });
    await tick();
    // The angle brackets are rendered as TEXT (escaped by Svelte binding), so
    // no <img> element is ever created in the DOM — the payload is inert data.
    expect(el.querySelector("td img")).toBeNull();
    expect(el.querySelectorAll("img")).toHaveLength(0);
    expect(el.querySelector("td")?.textContent).toContain("<img");
  });
});
