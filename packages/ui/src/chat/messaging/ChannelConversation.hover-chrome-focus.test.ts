// @vitest-environment happy-dom
/**
 * The message hover chrome (row wash, timestamps, quick-react bar) used to be
 * revealed by `:focus-within`, which also matches the focus a mouse click
 * leaves on a button inside the row. After clicking React or Reply the bar
 * stayed pinned over the message until you clicked somewhere else. It must
 * show on hover and on keyboard focus (`:has(:focus-visible)`) only.
 *
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

async function rules(): Promise<{ selector: string; body: string }[]> {
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
  const css = [...document.querySelectorAll("style")]
    .map((node) => node.textContent ?? "")
    .filter((text) => text.includes("dm-quick-react"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Drop the touch-only fallback, which shows the bar at all times.
    .replace(/@media\s*\(hover:\s*none\)\s*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, "");
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((match) => ({
    selector: match[1].trim(),
    body: match[2],
  }));
}

/** Svelte's scoping (`.svelte-x`, `:where(.svelte-x)`) removed. */
function unscoped(selector: string): string {
  return selector
    .replace(/:where\(\.svelte-[a-z0-9]+\)/g, "")
    .replace(/\.svelte-[a-z0-9]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Selectors, split on commas, unscoped. */
function selectors(list: { selector: string }[]): string[] {
  return list.flatMap(({ selector }) => selector.split(",")).map(unscoped);
}

describe("message hover chrome after a mouse click", () => {
  it("never reveals the hover bar, row wash or timestamps on :focus-within", async () => {
    const all = selectors(await rules());
    const pinned = all.filter(
      (s) =>
        /:focus-within/.test(s) &&
        /\.dm-msg\b|\.dm-quick-react\b|\.dm-msg-gutter-time|\.dm-msg-header-time/.test(s),
    );
    expect(pinned).toEqual([]);
  });

  it("still reveals each piece for keyboard focus via :has(:focus-visible)", async () => {
    const list = await rules();
    const reveal = (target: RegExp, prop: RegExp) =>
      list.some(
        ({ selector, body }) =>
          selector
            .split(",")
            // Raw `:has(:focus-visible)` (not `:has(:where(.svelte-x):focus-visible)`):
            // a scoped inner selector would ignore focus on buttons rendered by
            // child components inside the row (emoji picker, reactions).
            .filter((s) => s.includes(":has(:focus-visible)"))
            .map(unscoped)
            .some((s) => /^\.dm-msg:has\(:focus-visible\)/.test(s) && target.test(s)) &&
          prop.test(body),
      );

    expect(reveal(/\.dm-quick-react$/, /opacity:\s*1/), "quick-react bar").toBe(true);
    expect(reveal(/\.dm-msg-gutter-time$/, /opacity:\s*1/), "gutter time").toBe(true);
    expect(reveal(/\.dm-msg-header-time$/, /opacity:\s*1/), "header time").toBe(true);
    expect(reveal(/^\.dm-msg:has\(:focus-visible\)$/, /background:/), "row wash").toBe(true);
  });
});
