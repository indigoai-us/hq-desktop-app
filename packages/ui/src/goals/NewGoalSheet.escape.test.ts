// @vitest-environment happy-dom

// QA-030: the New objective sheet closes on Escape through the shared
// dismissable behaviour.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import NewGoalSheet from "./NewGoalSheet.svelte";

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
});

describe("New objective sheet (QA-030)", () => {
  it("closes on Escape", () => {
    const onclose = vi.fn();
    component = mount(NewGoalSheet, {
      target: document.body,
      props: { projects: [], onclose, oncreate: vi.fn() },
    });
    flushSync();
    const sheet = document.querySelector('[role="dialog"][aria-label="New objective"]');
    expect(sheet).not.toBeNull();
    const target = (document.activeElement as HTMLElement | null) ?? sheet!;
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});
