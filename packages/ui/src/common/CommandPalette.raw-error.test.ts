// @vitest-environment happy-dom

/** AUDIT-3c: a failed palette command never puts transport text in the error tooltip. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import CommandPalette from "./CommandPalette.svelte";

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("CommandPalette raw error text", () => {
  it("shows plain copy with Retry and logs the raw error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = new Error(RAW);
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(CommandPalette, {
      target,
      props: {
        commands: [
          { id: "boom", label: "Do thing", detail: "x", keepOpen: true, action: async () => { throw err; } },
        ],
        onclose: () => {},
      } as never,
    });
    flushSync();
    (target.querySelector('button[role="option"]') as HTMLButtonElement).click();
    for (let i = 0; i < 6; i++) { await tick(); await Promise.resolve(); }
    flushSync();
    const box = target.querySelector(".command-action-error");
    expect(box).not.toBeNull();
    expect(box!.getAttribute("title")).toBe("The command didn’t finish. Try again.");
    expect(target.innerHTML).not.toContain("HTTP 500");
    expect(box!.textContent).toContain("Retry");
    expect(warn).toHaveBeenCalledWith("[command-palette] action failed", err);
  });
});
