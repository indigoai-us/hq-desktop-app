// @vitest-environment happy-dom
/**
 * Keyboard reachability of the message quick-react toolbar.
 *
 * The rest state must stay opacity 0 (the buttons stay in the tab order) and
 * drop the resting shadow. `visibility: hidden` would remove those buttons
 * from the tab order, so a plain-text row could never take keyboard focus
 * (`:has(:focus-visible)`).
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

// Rules outside the touch-only fallback, which shows the toolbar at all times.
function desktopRules(css: string): { selector: string; body: string }[] {
  const desktop = css.replace(/@media\s*\(hover:\s*none\)\s*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, "");
  return [...desktop.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((match) => ({
    selector: match[1].trim(),
    body: match[2],
  }));
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
    const css = await injected();
    const rest = blocks(css).find(
      (body) => /opacity:\s*0/.test(body) && /box-shadow:\s*none/.test(body),
    );
    const reveal = desktopRules(css).find(
      ({ selector, body }) =>
        /\.dm-msg[^,]*:has\(:focus-visible\)[^,]*\.dm-quick-react/.test(selector) &&
        /opacity:\s*1/.test(body) &&
        /box-shadow:\s*var\(/.test(body),
    );
    expect(rest).toBeDefined();
    expect(reveal, "keyboard focus rule must reveal the toolbar and restore the shadow").toBeDefined();
  });
});
