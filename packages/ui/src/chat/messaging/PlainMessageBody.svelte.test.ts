// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import PlainMessageBody from "./PlainMessageBody.svelte";
import { MESSAGE_PLAIN_DISPLAY_CHARS } from "../../common/messageMarkdown.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function render(body: string): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(PlainMessageBody, { target: host, props: { body } });
  return host;
}

describe("PlainMessageBody", () => {
  it("shows a short body in full with no toggle", () => {
    const el = render("just a short line\nsecond line");
    expect(el.querySelector('[data-testid="plain-body-toggle"]')).toBeNull();
    const pre = el.querySelector("pre");
    expect(pre?.textContent).toContain("second line");
    // Newlines are preserved verbatim (pre-wrap).
    expect(pre?.textContent).toContain("\n");
  });

  it("clips a long body and offers an accessible expander", async () => {
    const long = "x".repeat(MESSAGE_PLAIN_DISPLAY_CHARS + 3000);
    const el = render(long);
    const pre = el.querySelector("pre") as HTMLPreElement;
    // Collapsed: preview is clipped well under the full length.
    expect(pre.textContent!.length).toBeLessThan(long.length);
    expect(pre.textContent).toContain("…");

    const toggle = el.querySelector(
      '[data-testid="plain-body-toggle"]',
    ) as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent?.trim()).toBe("Show more");
  });

  it("expands to the full body and collapses again via the toggle", async () => {
    const long = "y".repeat(MESSAGE_PLAIN_DISPLAY_CHARS + 2000);
    const el = render(long);
    const toggle = el.querySelector(
      '[data-testid="plain-body-toggle"]',
    ) as HTMLButtonElement;

    toggle.click();
    await tick();
    let pre = el.querySelector("pre") as HTMLPreElement;
    expect(pre.textContent).toBe(long);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent?.trim()).toBe("Show less");

    toggle.click();
    await tick();
    pre = el.querySelector("pre") as HTMLPreElement;
    expect(pre.textContent!.length).toBeLessThan(long.length);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});
