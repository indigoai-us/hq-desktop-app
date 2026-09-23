// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import ChannelNotifyBell from "./ChannelNotifyBell.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function render(props: { level: "all" | "mentions" | "files" | "muted" | null; busy?: boolean; onchange?: (l: string) => void }) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const onchange = props.onchange ?? vi.fn();
  component = mount(ChannelNotifyBell, {
    target: host,
    props: { level: props.level, busy: props.busy ?? false, onchange },
  });
  return { onchange };
}

function bell(): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>('[data-testid="channel-notify-bell"]')!;
}

describe("ChannelNotifyBell", () => {
  it("opens a menu of four levels with a check on the current one", async () => {
    render({ level: "mentions" });
    expect(host.querySelector('[role="menu"]')).toBeNull();
    bell().click();
    await tick();
    const items = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    expect(items.map((i) => i.dataset.testid)).toEqual([
      "channel-notify-all",
      "channel-notify-files",
      "channel-notify-mentions",
      "channel-notify-muted",
    ]);
    const checked = items.filter((i) => i.getAttribute("aria-checked") === "true");
    expect(checked.map((i) => i.dataset.testid)).toEqual(["channel-notify-mentions"]);
    expect(checked[0]!.querySelector("svg")).not.toBeNull();
    expect(bell().getAttribute("aria-expanded")).toBe("true");
  });

  it("reports a new pick and closes", async () => {
    const onchange = vi.fn();
    render({ level: "all", onchange });
    bell().click();
    await tick();
    host.querySelector<HTMLButtonElement>('[data-testid="channel-notify-muted"]')!.click();
    await tick();
    expect(onchange).toHaveBeenCalledWith("muted");
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it("does not report re-picking the current level", async () => {
    const onchange = vi.fn();
    render({ level: "all", onchange });
    bell().click();
    await tick();
    host.querySelector<HTMLButtonElement>('[data-testid="channel-notify-all"]')!.click();
    await tick();
    expect(onchange).not.toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    render({ level: "all" });
    bell().click();
    await tick();
    host
      .querySelector('[role="menu"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it("shows the muted state on the bell", () => {
    render({ level: "muted" });
    expect(bell().classList.contains("muted")).toBe(true);
    expect(bell().getAttribute("aria-label")).toBe("Notifications: Muted");
  });

  it("marks the current item with a background highlight, never a left accent bar", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/chat/ChannelNotifyBell.svelte"),
      "utf8",
    );
    expect(source).not.toMatch(/border-left/);
    expect(source).toMatch(/\.notify-item\.current\s*\{[^}]*background/);
  });
});
