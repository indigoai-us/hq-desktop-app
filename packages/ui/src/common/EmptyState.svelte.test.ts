// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import EmptyState from "./EmptyState.svelte";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function render(props: Record<string, unknown>): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(EmptyState, { target: host, props: props as never });
  flushSync();
  return host;
}

// iOS #44: a symbol disc, a readable measure, and Try again when a load
// failed.
describe("EmptyState", () => {
  it("draws the icon disc and offers Try again", () => {
    const onretry = vi.fn();
    const el = render({ title: "Couldn’t load files", icon: "file", onretry });
    expect(el.querySelector('.empty-state-disc [data-rail-icon="file"]')).not.toBeNull();
    el.querySelector<HTMLButtonElement>('[data-testid="empty-state-retry"]')!.click();
    expect(onretry).toHaveBeenCalledTimes(1);
  });

  it("is just the copy when given neither", () => {
    const el = render({ title: "No data" });
    expect(el.querySelector(".empty-state-disc")).toBeNull();
    expect(el.querySelector('[data-testid="empty-state-retry"]')).toBeNull();
  });
});
