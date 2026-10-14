// @vitest-environment happy-dom

/** AUDIT-3c: a failed Claude Code dispatch never puts adapter text in the tooltip. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import { failure } from "@hq/platform";
import OpenFileInClaudeCode from "./OpenFileInClaudeCode.svelte";

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("OpenFileInClaudeCode raw error text", () => {
  it("an authorized-file failure shows plain copy and logs the raw text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(OpenFileInClaudeCode, {
      target,
      props: {
        shell: { openFileInClaude: vi.fn(async () => failure("UPSTREAM_500", RAW)) } as never,
        file: "companies/acme/knowledge/a.md",
        authorizedFile: true,
      },
    });
    flushSync();
    (target.querySelector('[data-testid="open-in-claude-code"]') as HTMLButtonElement).click();
    for (let i = 0; i < 6; i++) { await tick(); await Promise.resolve(); }
    flushSync();
    const btn = target.querySelector('[data-testid="open-in-claude-code"]')!;
    expect(btn.getAttribute("title")).toBe("Couldn’t open Claude Code. Try again.");
    expect(target.innerHTML).not.toContain("HTTP 500");
    const logged = warn.mock.calls.find((c) => c[0] === "[open-in-claude-code] dispatch failed");
    expect((logged?.[1] as Error).message).toBe(RAW);
  });
});
