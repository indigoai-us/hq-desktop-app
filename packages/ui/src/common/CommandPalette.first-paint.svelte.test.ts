// @vitest-environment happy-dom

// US-040: the first Cmd-K frame paints the input and a short head of rows;
// the full list mounts on the next animation frame.
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import CommandPalette from "./CommandPalette.svelte";

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
});

function commands(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `cmd-${i}`,
    label: `Command ${i}`,
    detail: "Run it",
    action: () => {},
  }));
}

describe("CommandPalette first paint", () => {
  it("paints the input and the first rows, then the rest on the next frame", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(CommandPalette, {
      target: host,
      props: { commands: commands(40), onclose: () => {} },
    });
    flushSync();
    expect(host.querySelector("input")).not.toBeNull();
    expect(host.querySelectorAll('button[role="option"]').length).toBe(8);
    // The result count reflects the full list from the first frame.
    expect(host.querySelector(".command-foot")?.textContent).toContain("40 results");

    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    flushSync();
    expect(host.querySelectorAll('button[role="option"]').length).toBe(40);
  });

  it("stays mounted but hidden while closed, and each open starts fresh", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const props = $state({ commands: commands(3), onclose: () => {}, open: false });
    component = mount(CommandPalette, { target: host, props });
    flushSync();
    const backdrop = host.querySelector<HTMLElement>(".command-backdrop");
    expect(backdrop?.hidden).toBe(true);
    expect(host.querySelectorAll('button[role="option"]').length).toBe(3);

    props.open = true;
    flushSync();
    expect(backdrop?.hidden).toBe(false);
    const input = host.querySelector("input")!;
    input.value = "zzz";
    input.dispatchEvent(new Event("input"));
    flushSync();
    expect(host.querySelector("#cmd-0")).toBeNull();

    props.open = false;
    flushSync();
    props.open = true;
    flushSync();
    expect(input.value).toBe("");
    expect(host.querySelectorAll('button[role="option"]').length).toBe(3);
  });
});
