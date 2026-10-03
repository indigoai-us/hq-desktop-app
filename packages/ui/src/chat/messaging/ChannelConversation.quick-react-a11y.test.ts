// @vitest-environment happy-dom
/**
 * Keyboard reachability of the message quick-react toolbar.
 *
 * The rest state must stay opacity 0 (the buttons stay in the tab order) and
 * drop the resting shadow. `visibility: hidden` would remove those buttons
 * from the tab order, so a plain-text row could never reach :focus-within.
 * happy-dom does not compute scoped styles, so this reads the stylesheet the
 * mounted conversation injects.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

async function injected(): Promise<string> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: {
      messages: [],
      mentionCandidates: [],
      allowHereMention: false,
      onsend: () => {},
    },
  });
  await tick();
  return [...document.querySelectorAll("style")]
    .map((node) => node.textContent ?? "")
    .filter((css) => css.includes("dm-quick-react"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function blocks(css: string): string[] {
  return [...css.matchAll(/\.dm-quick-react[^{]*\{([^}]*)\}/g)].map((match) => match[1]);
}

describe("quick-react toolbar keyboard reachability", () => {
  it("does not remove the resting toolbar from the tab order", async () => {
    const rest = blocks(await injected()).find(
      (body) => /opacity:\s*0/.test(body) && /box-shadow:\s*none/.test(body),
    );
    expect(rest, "resting .dm-quick-react rule").toBeDefined();
    expect(rest).not.toMatch(/visibility:\s*(hidden|collapse)/);
  });

  it("avoids the resting shadow raster with box-shadow instead", async () => {
    const found = blocks(await injected());
    const rest = found.find(
      (body) => /opacity:\s*0/.test(body) && /box-shadow:\s*none/.test(body),
    );
    const reveal = found.find(
      (body) => /opacity:\s*1/.test(body) && /box-shadow:\s*var\(/.test(body),
    );
    expect(rest).toBeDefined();
    expect(reveal, "hover or focus rule must restore the shadow").toBeDefined();
  });
});
