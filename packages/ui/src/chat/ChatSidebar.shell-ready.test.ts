import { describe, expect, it } from "vitest";
import { shouldReportShellReady } from "./shell-ready.js";

describe("shouldReportShellReady", () => {
  it("reports after conversations have painted", () => {
    expect(
      shouldReportShellReady({
        loading: false,
        loadError: null,
        firstRefreshSettled: false,
        conversationCount: 3,
      }),
    ).toBe(true);
  });

  it("reports an empty state only after the first fetch settles", () => {
    expect(
      shouldReportShellReady({
        loading: true,
        loadError: null,
        firstRefreshSettled: false,
        conversationCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldReportShellReady({
        loading: false,
        loadError: null,
        firstRefreshSettled: true,
        conversationCount: 0,
      }),
    ).toBe(true);
  });

  it("does not report error states, even after the fetch settles", () => {
    expect(
      shouldReportShellReady({
        loading: false,
        loadError: "Could not load conversations",
        firstRefreshSettled: true,
        conversationCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldReportShellReady({
        loading: false,
        loadError: "Could not load conversations",
        firstRefreshSettled: true,
        conversationCount: 2,
      }),
    ).toBe(false);
  });
});
describe("ChatSidebar wires onShellReady through shouldReportShellReady", () => {
  it("calls the helper from maybeReportShellReady", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "ChatSidebar.svelte"),
      "utf8",
    );
    expect(src).toContain("shouldReportShellReady");
    expect(src).toContain("onShellReady?.()");
    expect(src).toContain("firstRefreshSettled");
  });
});
