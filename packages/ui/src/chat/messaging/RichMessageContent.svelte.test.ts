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

  it("renders a badge pill with its tone class", async () => {
    const el = render({
      v: 1,
      blocks: [{ kind: "badge", label: "Live", tone: "success" }],
    });
    await tick();
    const badge = el.querySelector('[data-testid="rich-badge"] .rich-badge');
    expect(badge?.textContent?.trim()).toBe("Live");
    expect(badge?.classList.contains("tone-success")).toBe(true);
  });

  it("renders a keyValue definition list with aligned rows", async () => {
    const el = render({
      v: 1,
      blocks: [
        {
          kind: "keyValue",
          items: [
            { key: "Owner", value: "Corey" },
            { key: "PRs", value: "7" },
          ],
        },
      ],
    });
    await tick();
    const rows = el.querySelectorAll('[data-testid="rich-keyvalue"] .rich-kv-row');
    expect(rows).toHaveLength(2);
    expect(el.querySelector(".rich-kv-key")?.textContent).toBe("Owner");
    expect(el.querySelector(".rich-kv-value")?.textContent).toBe("Corey");
  });

  it("renders a progress meter with a numeric % and clamped width", async () => {
    const el = render({
      v: 1,
      blocks: [{ kind: "progress", label: "Rollout", value: 150, tone: "accent" }],
    });
    await tick();
    expect(el.querySelector(".rich-progress-pct")?.textContent).toBe("100%");
    const meter = el.querySelector('[role="meter"]');
    expect(meter?.getAttribute("aria-valuenow")).toBe("100");
    const fill = el.querySelector(".rich-progress-fill") as HTMLElement | null;
    expect(fill?.style.width).toBe("100%");
    expect(
      el.querySelector('[data-testid="rich-progress"]')?.classList.contains("tone-accent"),
    ).toBe(true);
  });

  it("renders a callout: tinted block, per-tone icon, markdown body (no raw HTML)", async () => {
    const el = render({
      v: 1,
      blocks: [
        {
          kind: "callout",
          tone: "warning",
          title: "Heads up",
          body: "check the [logs](javascript:alert(1)) <script>alert(1)</script>",
        },
      ],
    });
    await tick();
    const callout = el.querySelector('[data-testid="rich-callout"]');
    expect(callout?.classList.contains("tone-warning")).toBe(true);
    expect(callout?.querySelector(".rich-callout-icon svg")).not.toBeNull();
    expect(el.querySelector(".rich-callout-title")?.textContent).toBe("Heads up");
    // Body is routed through the CSP-safe markdown renderer: no <script> node,
    // and the javascript: href is rejected (never a live navigable anchor).
    expect(callout?.querySelector("script")).toBeNull();
    expect(el.querySelectorAll("script")).toHaveLength(0);
    const anchor = callout?.querySelector("a");
    expect(anchor?.getAttribute("href") ?? "").not.toContain("javascript:");
  });

  it("badge/keyValue string data is inert (no markup interpreted)", async () => {
    const el = render({
      v: 1,
      blocks: [
        { kind: "badge", label: "<img src=x onerror=alert(1)>", tone: "danger" },
        {
          kind: "keyValue",
          items: [{ key: "<b>k</b>", value: "<script>alert(1)</script>" }],
        },
      ],
    });
    await tick();
    expect(el.querySelectorAll("img")).toHaveLength(0);
    expect(el.querySelectorAll("script")).toHaveLength(0);
    expect(el.querySelector(".rich-badge")?.textContent).toContain("<img");
    expect(el.querySelector(".rich-kv-value")?.textContent).toContain("<script>");
  });
});

describe("RichMessageContent — decision block interactivity", () => {
  function renderDecision(
    over: Record<string, unknown> = {},
    props: Record<string, unknown> = {},
  ): { el: HTMLElement; calls: Array<{ questionId?: string; option: unknown }> } {
    const raw = {
      v: 1,
      blocks: [
        {
          kind: "decision",
          question: "Append the smoke-test line?",
          options: [
            { id: "1", label: "Yes, append it", recommended: true },
            { id: "2", label: "No, cancel" },
          ],
          allowOther: true,
          questionId: "clarify_abc123",
          ...over,
        },
      ],
    };
    const content = parseRichContent(raw);
    if (!content) throw new Error("fixture did not parse");
    const calls: Array<{ questionId?: string; option: unknown }> = [];
    host = document.createElement("div");
    host.className = "chat-shell";
    document.body.appendChild(host);
    component = mount(RichMessageContent, {
      target: host,
      props: { content, ondecision: (d: unknown) => calls.push(d as never), ...props },
    });
    return { el: host, calls };
  }

  it("renders one button per option plus Other, with the recommended pill", async () => {
    const { el } = renderDecision();
    await tick();
    expect(el.querySelector('[data-testid="rich-decision"]')).not.toBeNull();
    expect(el.querySelectorAll('[data-testid="rich-decision-option"]')).toHaveLength(2);
    expect(el.querySelector('[data-testid="rich-decision-other"]')).not.toBeNull();
    const first = el.querySelector('[data-testid="rich-decision-option"]');
    expect(first?.classList.contains("is-recommended")).toBe(true);
    expect(first?.querySelector(".rich-decision-tag")?.textContent).toContain(
      "Recommended",
    );
  });

  it("fires ondecision with the chosen option and disables after a click", async () => {
    const { el, calls } = renderDecision();
    await tick();
    const buttons = el.querySelectorAll<HTMLButtonElement>(
      '[data-testid="rich-decision-option"]',
    );
    buttons[0].click();
    await tick();
    expect(calls).toHaveLength(1);
    expect((calls[0].option as { label: string }).label).toBe("Yes, append it");
    expect(calls[0].questionId).toBe("clarify_abc123");
    // All buttons disabled + chosen shown.
    el.querySelectorAll<HTMLButtonElement>("button").forEach((b) =>
      expect(b.disabled).toBe(true),
    );
    expect(
      el.querySelector('[data-testid="rich-decision-answered"]')?.textContent,
    ).toContain("Yes, append it");
    // A second click does nothing.
    buttons[1].click();
    await tick();
    expect(calls).toHaveLength(1);
  });

  it("fires ondecision with option=null for Other", async () => {
    const { el, calls } = renderDecision();
    await tick();
    el.querySelector<HTMLButtonElement>('[data-testid="rich-decision-other"]')!.click();
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].option).toBeNull();
  });

  it("omits Other when allowOther is false", async () => {
    const { el } = renderDecision({ allowOther: false });
    await tick();
    expect(el.querySelector('[data-testid="rich-decision-other"]')).toBeNull();
  });

  it("renders disabled when the questionId is already answered", async () => {
    const { el, calls } = renderDecision(
      {},
      { answeredQuestionIds: new Set(["clarify_abc123"]) },
    );
    await tick();
    el.querySelectorAll<HTMLButtonElement>("button").forEach((b) =>
      expect(b.disabled).toBe(true),
    );
    el.querySelector<HTMLButtonElement>('[data-testid="rich-decision-option"]')!.click();
    await tick();
    expect(calls).toHaveLength(0);
  });

  it("highlights the persisted choice (reload) from answeredChoices, not local state", async () => {
    // No click happened this session — the choice comes purely from the thread
    // answer (derived by decision-answers.ts and passed as answeredChoices).
    const { el } = renderDecision(
      {},
      {
        answeredChoices: new Map([["clarify_abc123", "Yes, append it"]]),
      },
    );
    await tick();
    // Locked.
    el.querySelectorAll<HTMLButtonElement>("button").forEach((b) =>
      expect(b.disabled).toBe(true),
    );
    // The matching option is marked chosen with a check; the other is inactive.
    const options = el.querySelectorAll<HTMLButtonElement>(
      '[data-testid="rich-decision-option"]',
    );
    const chosen = [...options].find(
      (b) => b.dataset.chosen === "true",
    );
    expect(chosen?.textContent).toContain("Yes, append it");
    expect(chosen?.querySelector(".rich-decision-check")).not.toBeNull();
    expect(chosen?.getAttribute("aria-pressed")).toBe("true");
    const other = [...options].find((b) => b.dataset.chosen !== "true");
    expect(other?.classList.contains("is-inactive")).toBe(true);
    // Answered caption echoes the persisted choice.
    expect(
      el.querySelector('[data-testid="rich-decision-answered"]')?.textContent,
    ).toContain("Yes, append it");
  });

  it("drops the recommended accent once answered so only the choice stands out", async () => {
    const { el } = renderDecision(
      {},
      {
        // Chose the NON-recommended option; the recommended one must not keep
        // its accent (which would read like a second selected state).
        answeredChoices: new Map([["clarify_abc123", "No, cancel"]]),
      },
    );
    await tick();
    const recommended = el.querySelector('[data-testid="rich-decision-option"]');
    expect(recommended?.classList.contains("is-recommended")).toBe(false);
    // The RECOMMENDED badge itself is informational and remains.
    expect(recommended?.querySelector(".rich-decision-tag")).not.toBeNull();
  });
});
