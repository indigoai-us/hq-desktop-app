// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

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
    expect(checked[0]!.querySelector('svg[data-rail-icon="check"]')).not.toBeNull();
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

  // Owner decision 2026-09-25: the control draws a bell, and a slash across
  // it only while the channel is muted. The current level is a background
  // highlight, never a left accent. Icons are Phosphor Regular (Bell /
  // BellSlash) from the shared rail-icon registry.
  function glyph(id: string): SVGSVGElement | null {
    return q(id).querySelector<SVGSVGElement>("svg[data-rail-icon]");
  }

  function muteStyles(): string {
    return [...document.querySelectorAll("style")]
      .map((node) => node.textContent ?? "")
      .filter((css) => css.includes("notify-item"))
      .join("\n");
  }

  it("draws a bell without a slash while the channel is unmuted", () => {
    render({ level: "all" });
    const open = glyph("channel-mute-toggle");
    expect(open?.getAttribute("data-rail-icon")).toBe("bell");
    expect(open?.getAttribute("viewBox")).toBe("0 0 256 256");
    expect(open?.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
  });

  it("adds the slash across the bell while the channel is muted", () => {
    render({ level: "muted" });
    const muted = glyph("channel-mute-toggle");
    expect(muted?.getAttribute("data-rail-icon")).toBe("bell-slash");
    expect(muted?.getAttribute("viewBox")).toBe("0 0 256 256");
  });

  it("highlights the current level with a background and no left accent", async () => {
    render({ level: "mentions" });
    q("channel-notify-menu-toggle").click();
    await tick();
    const current = q("channel-notify-mentions");
    expect(current.classList.contains("current")).toBe(true);
    const css = muteStyles();
    expect(css).toMatch(/notify-item[^{]*current[^{]*\{[^}]*background:\s*var\(--raised\)/);
    expect(css).not.toMatch(/border-left/);
  });
});
