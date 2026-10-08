// @vitest-environment happy-dom

/** AUDIT-3c: a failed clipboard write never puts the raw error text in the tooltip. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import CopyPromptButton from "./CopyPromptButton.svelte";

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

describe("CopyPromptButton raw error text", () => {
  it("shows plain copy in the tooltip and logs the raw error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = new Error(RAW);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw err; }) },
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(CopyPromptButton, {
      target: host,
      props: { issue: { kind: "auth-expired" } as never },
    });
    flushSync();
    host.querySelector("button")!.click();
    for (let i = 0; i < 5; i++) { await tick(); await Promise.resolve(); }
    flushSync();
    const btn = host.querySelector("button")!;
    expect(btn.textContent).toContain("Copy failed");
    expect(btn.getAttribute("title")).toBe("Copy failed. Try again.");
    expect(host.innerHTML).not.toContain("HTTP 500");
    expect(warn).toHaveBeenCalledWith("[copy-prompt] clipboard write failed", err);
  });
});
