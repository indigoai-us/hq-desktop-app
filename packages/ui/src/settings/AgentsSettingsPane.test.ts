// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import type { PlatformAdapter } from "@hq/platform";
import ShellSettings from "./ShellSettings.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function adapter(preflight?: () => Promise<unknown>): PlatformAdapter {
  return {
    isAvailable: () => false,
    sessions: preflight ? { preflight } : {},
  } as unknown as PlatformAdapter;
}

async function render(preflight?: () => Promise<unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ShellSettings, {
    target: host,
    props: { adapter: adapter(preflight) },
  });
  await tick();
  await Promise.resolve();
  flushSync();
}

describe("Settings → AI tools (Work shell)", () => {
  it("is a first-class ShellSettings nav item when the desktop session preflight exists", async () => {
    await render(async () => ({ ok: true, value: {} }));
    const nav = host.querySelector<HTMLButtonElement>("[data-testid='settings-nav-agents']");
    expect(nav?.textContent).toContain("AI tools");
    nav?.click();
    await tick();
    flushSync();
    expect(host.querySelector("[data-testid='settings-agents-pane']")).not.toBeNull();
  });

  it("hides AI tools when the host has no session preflight", async () => {
    await render();
    expect(host.querySelector("[data-testid='settings-nav-agents']")).toBeNull();
    expect(host.querySelector("[data-testid='settings-agents-pane']")).toBeNull();
  });
});
