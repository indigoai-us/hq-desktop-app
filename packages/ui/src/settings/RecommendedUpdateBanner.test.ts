// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import RecommendedUpdateBanner from "./RecommendedUpdateBanner.svelte";

describe("recommended update banner", () => {
  let host: HTMLDivElement;
  let component: ReturnType<typeof mount> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    host?.remove();
  });

  it("shows a dismissible Update now action for a recommend result", () => {
    host = document.createElement("div");
    document.body.append(host);
    const onupdate = vi.fn();
    const ondismiss = vi.fn();
    component = mount(RecommendedUpdateBanner, {
      target: host,
      props: {
        version: "0.10.185",
        message: "Please update HQ.",
        onupdate,
        ondismiss,
      },
    });
    flushSync();
    expect(host.textContent).toContain("Please update HQ.");
    expect(host.textContent).toContain("Update now");
    host.querySelector<HTMLButtonElement>('[data-testid="recommended-update-now"]')!.click();
    expect(onupdate).toHaveBeenCalledTimes(1);
    host
      .querySelector<HTMLButtonElement>('[data-testid="recommended-update-dismiss"]')!
      .click();
    expect(ondismiss).toHaveBeenCalledTimes(1);
  });
});
