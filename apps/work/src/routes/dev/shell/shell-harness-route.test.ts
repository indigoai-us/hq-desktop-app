// @vitest-environment happy-dom
/**
 * The /dev/shell design harness mounts the real DesktopApp against fixtures.
 * It must render nothing — and touch nothing global — outside a dev build, and
 * inside one it must stage the shell the way the desktop window does.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ dev: false }));
const desktopAppProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

vi.mock("$app/environment", () => ({
  get dev() {
    return env.dev;
  },
  browser: true,
  building: false,
  version: "test",
}));

vi.mock("svelte", async () => {
  // @ts-expect-error happy-dom tests need Svelte's client runtime.
  return await import("../../../../node_modules/svelte/src/index-client.js");
});

vi.mock("@hq/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hq/ui")>();
  return {
    ...actual,
    DesktopApp: (_anchor: Node, props: Record<string, unknown>) => {
      desktopAppProps.current = props;
    },
  };
});

import { flushSync, mount, tick, unmount } from "svelte";
import Page from "./+page.svelte";

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

describe("/dev/shell harness", () => {
  let component: ReturnType<typeof mount> | null = null;

  afterEach(() => {
    if (component) unmount(component);
    component = null;
    desktopAppProps.current = null;
    document.body.innerHTML = "";
    const root = document.documentElement;
    delete root.dataset.windowTransparency;
    delete root.dataset.forceTheme;
    root.removeAttribute("style");
    localStorage.clear();
  });

  it("renders nothing but a notice outside a dev build", async () => {
    env.dev = false;
    const target = document.createElement("div");
    document.body.append(target);
    component = mount(Page, { target });
    await settle();

    expect(target.querySelector('[data-testid="shell-harness-dev-only"]')).not.toBeNull();
    expect(target.querySelector('[data-testid="shell-harness-stage"]')).toBeNull();
    expect(desktopAppProps.current).toBeNull();
    // No appearance host claimed <html>, so production tokens are untouched.
    expect(document.documentElement.dataset.windowTransparency).toBeUndefined();
  });

  it("stages the desktop shell, with window controls, in a dev build", async () => {
    env.dev = true;
    const target = document.createElement("div");
    document.body.append(target);
    component = mount(Page, { target });
    await settle();

    expect(target.querySelector('[data-testid="shell-harness-stage"]')).not.toBeNull();
    const lights = target.querySelector<HTMLElement>(
      '[data-testid="harness-traffic-lights"]',
    );
    expect(lights?.style.left).toBe("20px");
    expect(lights?.style.height).toBe("48px");

    const props = desktopAppProps.current as {
      adapter: { capabilities: { hasWindowControls: boolean }; kind: string };
    } | null;
    expect(props).not.toBeNull();
    // hasWindowControls is what makes the titlebar reserve the light gutter.
    expect(props?.adapter.capabilities.hasWindowControls).toBe(true);
    expect(props?.adapter.kind).toBe("tauri");
    // The appearance host is installed, on the reference material.
    expect(document.documentElement.dataset.windowTransparency).toBe("65");
  });

  it("answers synchronous subscriptions with an unsubscribe function", async () => {
    // The fallback slice answers unknown methods with a promise; the shell's
    // flag subscriptions call the return value on teardown and threw
    // "unsubscribe is not a function" whenever the harness unmounted.
    env.dev = true;
    const target = document.createElement("div");
    document.body.append(target);
    component = mount(Page, { target });
    await settle();

    const adapter = (desktopAppProps.current as {
      adapter: { identity: { subscribeFeature: (f: string, cb: () => void) => unknown } };
    }).adapter;
    const unsubscribe = adapter.identity.subscribeFeature("any-flag", () => {});
    expect(typeof unsubscribe).toBe("function");
    expect(() => (unsubscribe as () => void)()).not.toThrow();
  });
});
