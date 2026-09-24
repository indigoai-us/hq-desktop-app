// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import ChannelMuteControl from "./ChannelMuteControl.svelte";
import type { NotifyLevel } from "./notify-level";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function render(props: {
  level: NotifyLevel | null;
  rememberedLevel?: NotifyLevel | null;
  busy?: boolean;
  onchange?: (l: NotifyLevel) => void;
}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const onchange = props.onchange ?? vi.fn();
  component = mount(ChannelMuteControl, {
    target: host,
    props: {
      level: props.level,
      rememberedLevel: props.rememberedLevel ?? null,
      busy: props.busy ?? false,
      onchange,
    },
  });
  return { onchange };
}

const q = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;

describe("ChannelMuteControl", () => {
  it("mutes with one click on the speaker", () => {
    const onchange = vi.fn();
    render({ level: "all", onchange });
    expect(q("channel-mute-toggle").getAttribute("aria-label")).toBe("Mute channel");
    expect(q("channel-mute-toggle").getAttribute("aria-pressed")).toBe("false");
    q("channel-mute-toggle").click();
    expect(onchange).toHaveBeenCalledWith("muted");
  });

  it("unmutes to the remembered level", () => {
    const onchange = vi.fn();
    render({ level: "muted", rememberedLevel: "files", onchange });
    expect(q("channel-mute-toggle").getAttribute("aria-label")).toBe("Unmute channel");
    expect(q("channel-mute-toggle").getAttribute("aria-pressed")).toBe("true");
    q("channel-mute-toggle").click();
    expect(onchange).toHaveBeenCalledWith("files");
  });

  it("unmutes to mentions when no level is remembered", () => {
    const onchange = vi.fn();
    render({ level: "muted", onchange });
    q("channel-mute-toggle").click();
    expect(onchange).toHaveBeenCalledWith("mentions");
  });

  it("ignores clicks while a change is in flight", () => {
    const onchange = vi.fn();
    render({ level: "all", busy: true, onchange });
    q("channel-mute-toggle").click();
    expect(onchange).not.toHaveBeenCalled();
  });

  it("opens the four levels from the chevron with a check on the current one", async () => {
    render({ level: "mentions" });
    expect(host.querySelector('[role="menu"]')).toBeNull();
    q("channel-notify-menu-toggle").click();
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
  });

  it("opens the menu on right-click of the speaker", async () => {
    render({ level: "all" });
    q("channel-mute-toggle").dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    await tick();
    expect(host.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("reports a new pick, ignores re-picks, and closes", async () => {
    const onchange = vi.fn();
    render({ level: "all", onchange });
    q("channel-notify-menu-toggle").click();
    await tick();
    q("channel-notify-all").click();
    await tick();
    expect(onchange).not.toHaveBeenCalled();
    q("channel-notify-menu-toggle").click();
    await tick();
    q("channel-notify-files").click();
    await tick();
    expect(onchange).toHaveBeenCalledWith("files");
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it("closes on Escape", async () => {
    render({ level: "all" });
    q("channel-notify-menu-toggle").click();
    await tick();
    host
      .querySelector('[role="menu"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it("draws a speaker, not a bell, and uses background highlight only", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/chat/ChannelMuteControl.svelte"),
      "utf8",
    );
    expect(source).not.toMatch(/border-left/);
    expect(source).not.toMatch(/bell/i);
    expect(source).toMatch(/\.notify-item\.current\s*\{[^}]*background/);
  });
});
