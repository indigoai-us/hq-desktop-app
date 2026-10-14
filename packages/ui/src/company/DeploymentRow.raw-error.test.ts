// @vitest-environment happy-dom

/** AUDIT-3c: a failed browser handoff never puts transport text in the tooltip. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import DeploymentRow from "./DeploymentRow.svelte";

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("DeploymentRow raw error text", () => {
  it("shows plain copy with Retry and logs the raw error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = new Error(RAW);
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(DeploymentRow, {
      target,
      props: {
        deployment: {
          sub: "docs", url: "docs.example.com", state: "active",
          lastDeploy: "now", size: "1 MB", ver: "v1", pwd: false,
        },
        openExternal: async () => { throw err; },
      },
    });
    flushSync();
    (target.querySelector('button[aria-label="Open docs in browser"]') as HTMLButtonElement).click();
    for (let i = 0; i < 6; i++) { await tick(); await Promise.resolve(); }
    flushSync();
    const box = target.querySelector(".deployment-action-error");
    expect(box).not.toBeNull();
    expect(box!.getAttribute("title")).toBe("The browser didn’t open. Try again.");
    expect(target.innerHTML).not.toContain("HTTP 500");
    expect(warn).toHaveBeenCalledWith("[deployment] open failed", err);
  });
});
