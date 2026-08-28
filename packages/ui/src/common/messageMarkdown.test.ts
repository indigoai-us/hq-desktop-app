import { describe, expect, it } from "vitest";

import {
  clipMessageBodyForDisplay,
  isHeavyMessageBody,
  MESSAGE_PLAIN_DISPLAY_CHARS,
  renderMessageBodyMarkdown,
} from "./messageMarkdown.js";

describe("heavy message bodies", () => {
  it("treats large JSON dumps as heavy and renders them as a plain pre", () => {
    const body =
      `${JSON.stringify({ outcome: "doc-wrong", commandsRun: ["a"] })}\n`.repeat(
        40,
      );
    expect(body.length).toBeGreaterThan(400);
    expect(isHeavyMessageBody(body)).toBe(true);
    const started = Date.now();
    const html = renderMessageBodyMarkdown(body);
    expect(Date.now() - started).toBeLessThan(50);
    expect(html.startsWith('<pre class="dm-plain">')).toBe(true);
    expect(html).toContain("doc-wrong");
    expect(html).not.toContain("<p>");
  });

  it("clips huge dumps so the DOM does not receive the full log", () => {
    const body = `{"k":"${"x".repeat(12_000)}"}`;
    const html = renderMessageBodyMarkdown(body);
    expect(html.length).toBeLessThan(body.length);
    expect(html).toContain("…");
    expect(clipMessageBodyForDisplay(body).length).toBeLessThanOrEqual(
      MESSAGE_PLAIN_DISPLAY_CHARS + 2,
    );
  });

  it("keeps a window of long English docs cheap to render", () => {
    const bodies = Array.from(
      { length: 40 },
      (_, i) =>
        `You are testing HQ as a new team member ${i}\n\n${"paragraph ".repeat(200)}`,
    );
    const started = performance.now();
    const html = bodies.map((body) => renderMessageBodyMarkdown(body));
    expect(performance.now() - started).toBeLessThan(50);
    expect(html.every((row) => row.startsWith('<pre class="dm-plain">'))).toBe(
      true,
    );
    expect(Math.max(...html.map((row) => row.length))).toBeLessThan(800);
  });

  it("still renders short chat markdown", () => {
    const html = renderMessageBodyMarkdown("hello **Deacon**");
    expect(isHeavyMessageBody("hello **Deacon**")).toBe(false);
    expect(html).toContain("<strong>Deacon</strong>");
  });
});
