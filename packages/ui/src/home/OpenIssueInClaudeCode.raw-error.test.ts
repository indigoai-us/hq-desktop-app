// @vitest-environment happy-dom

/** AUDIT-3c: a failed Claude Code dispatch never puts adapter text in the tooltip. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import { failure } from "@hq/platform";
import OpenIssueInClaudeCode from "./OpenIssueInClaudeCode.svelte";

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("OpenIssueInClaudeCode raw error text", () => {
  it("a failed dispatch with no clipboard shows plain copy and logs the raw text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error("denied"); }) },
    });
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(OpenIssueInClaudeCode, {
      target,
      props: {
        shell: { openClaudeCodeLink: vi.fn(async () => failure("UPSTREAM_500", RAW)) } as never,
        issue: { kind: "auth-expired" } as never,
        folder: "/tmp/hq",
      },
    });
    flushSync();
    (target.querySelector("button") as HTMLButtonElement).click();
    for (let i = 0; i < 6; i++) { await tick(); await Promise.resolve(); }
    flushSync();
    const btn = target.querySelector("button")!;
    expect(btn.getAttribute("title")).toBe("Couldn’t open Claude Code. Try again.");
    expect(target.innerHTML).not.toContain("HTTP 500");
    const logged = warn.mock.calls.find((c) => c[0] === "[open-issue-in-claude-code] dispatch failed");
    expect((logged?.[1] as Error).message).toBe(RAW);
  });
});
