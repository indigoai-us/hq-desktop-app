// @vitest-environment happy-dom
/**
 * A reaction you added reads as a selected control in the shell's ice tint,
 * count included (owner, #772). It was a neutral fill one shade off the
 * resting pill. happy-dom does not compute scoped styles, so this reads the
 * stylesheet the mounted bar injects.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ReactionBar from "./ReactionBar.svelte";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

describe("ReactionBar, your own reaction", () => {
  it("is tinted ice, count included", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ReactionBar, {
      target: host,
      props: {
        messageId: "m1",
        reactions: [{ emoji: "👍", count: 2, reactedByMe: true }],
        ontoggle: () => {},
      },
    });
    await tick();
    expect(host.querySelector(".reaction-pill.reacted")).not.toBeNull();
    const css = [...document.querySelectorAll("style")]
      .map((node) => node.textContent ?? "")
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const pill = css.match(/\.reaction-pill\.reacted(?:\.[\w-]+)?\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(pill).toMatch(/background: var\(--ice-tile\)/);
    const count = css.match(/\.reaction-pill\.reacted(?:\.[\w-]+)? \.reaction-count(?:\.[\w-]+|:where\([^)]*\))?\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(count).toMatch(/color: var\(--ice-ink\)/);
  });

  it("adds a reaction from a smiley icon, not typed characters", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ReactionBar, {
      target: host,
      props: {
        messageId: "m1",
        reactions: [{ emoji: "👍", count: 1, reactedByMe: false }],
        ontoggle: () => {},
      },
    });
    await tick();
    const add = host.querySelector(".reaction-add")!;
    expect(add.querySelector("svg")).not.toBeNull();
    expect(add.textContent?.trim()).toBe("");
  });
});
