// @vitest-environment happy-dom

/**
 * The guided tour holds the titlebar Launch menu open on its last step
 * (`launchMenuForcedOpen`). While held, a click on the tour card (outside the
 * menu's wrapper), Escape and the pill itself must not close it; releasing
 * the prop closes it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import V4TitleBar from "./V4TitleBar.svelte";

const ok = <T,>(value: T) => ({ ok: true as const, value });

function makeAdapter() {
  return {
    kind: "desktop" as const,
    capabilities: { hasWindowControls: true, localFiles: true },
    isAvailable: () => false,
    shell: {
      detectAiTools: vi.fn(async () => ok({})),
    },
    files: {
      revealInFinder: vi.fn(async () => ok(undefined)),
      revealHqRoot: vi.fn(async () => ok(undefined)),
    },
    settings: {
      getSetupStatus: vi.fn(async () => ok({ hqFolderPath: "/tmp/HQ" })),
    },
  };
}

let host: HTMLDivElement;
let tourCard: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  tourCard?.remove();
});

const menu = () => host.querySelector('[data-testid="titlebar-launch-menu"]');

describe("V4TitleBar launchMenuForcedOpen", () => {
  it("holds the menu open through tour clicks, Escape and the pill, then closes on release", async () => {
    const props = $state({
      adapter: makeAdapter(),
      version: "0.0.0-test",
      syncState: "idle",
      watchedCount: 0,
      launchMenuForcedOpen: false,
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    tourCard = document.createElement("div");
    tourCard.setAttribute("data-hq-tour", "");
    const next = document.createElement("button");
    tourCard.appendChild(next);
    document.body.appendChild(tourCard);
    component = mount(V4TitleBar, { target: host, props: props as never });
    await tick();
    expect(menu()).toBeNull();

    props.launchMenuForcedOpen = true;
    flushSync();
    expect(menu()).toBeTruthy();

    next.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    host.querySelector<HTMLButtonElement>('[data-testid="titlebar-launch"]')?.click();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    flushSync();
    expect(menu()).toBeTruthy();

    props.launchMenuForcedOpen = false;
    flushSync();
    expect(menu()).toBeNull();
  });

  it("a click on the tour card does not close a menu the person opened", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    tourCard = document.createElement("div");
    tourCard.setAttribute("data-hq-tour", "");
    document.body.appendChild(tourCard);
    component = mount(V4TitleBar, {
      target: host,
      props: {
        adapter: makeAdapter(),
        version: "0.0.0-test",
        syncState: "idle",
        watchedCount: 0,
      } as never,
    });
    await tick();
    host.querySelector<HTMLButtonElement>('[data-testid="titlebar-launch"]')?.click();
    flushSync();
    expect(menu()).toBeTruthy();
    tourCard.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    flushSync();
    expect(menu()).toBeTruthy();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    flushSync();
    expect(menu()).toBeNull();
  });
});
