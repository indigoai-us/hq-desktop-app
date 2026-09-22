// @vitest-environment happy-dom

/**
 * "Opening Claude Code sign-in…" and then nothing — the owner's screenshot.
 *
 * The host call that opens the browser can hang (it spawns a CLI that is not
 * there) or fail. Neither may leave this component on a line that never
 * changes, so it carries its own deadline and surfaces the host's own words
 * when there are any.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import RuntimeSignIn, { type RuntimeSignInState } from "./RuntimeSignIn.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.useRealTimers();
});

async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function render(api: {
  loginStart: (runtime: string) => Promise<RuntimeSignInState>;
  loginStatus?: (runtime: string) => Promise<RuntimeSignInState>;
}): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(RuntimeSignIn, {
    target: host,
    props: {
      runtime: "claude",
      api: {
        loginStatus: async () => ({ state: "disconnected" }) as RuntimeSignInState,
        ...api,
      },
      onconnected: () => undefined,
      pollMs: 5,
      openTimeoutMs: 50,
    },
  });
}

function text(): string {
  return host.querySelector('[data-testid="runtime-signin"]')?.textContent ?? "";
}

describe("a sign-in that never opens", () => {
  it("stops saying “Opening…” and says what happened", async () => {
    // A start that never settles: exactly the hang behind the screenshot.
    render({ loginStart: () => new Promise<RuntimeSignInState>(() => {}) });
    await settle();
    expect(text()).toContain("Opening Claude Code sign-in…");

    await new Promise((resolve) => setTimeout(resolve, 80));
    await settle();

    expect(text()).not.toContain("Opening Claude Code sign-in…");
    expect(text()).toContain("didn’t open its sign-in");
    expect(host.querySelector('[data-testid="runtime-signin"]')?.getAttribute("data-state")).toBe("error");
    // And the way out is right there.
    expect(host.querySelector('[data-testid="runtime-signin-retry"]')).toBeTruthy();
  });
});

describe("a sign-in that fails outright", () => {
  it("surfaces the host's own reason for a thrown failure", async () => {
    render({
      loginStart: async () => {
        throw new Error("claude: No such file or directory (os error 2)");
      },
    });
    await settle();

    expect(text()).toContain("Could not open Claude Code sign-in");
    expect(text()).toContain("No such file or directory");
  });

  it("surfaces a reported error state's message", async () => {
    render({
      loginStart: async () => ({ state: "error", message: "Sign-in exited with status 1." }),
    });
    await settle();

    expect(text()).toContain("Sign-in exited with status 1.");
    expect(host.querySelector('[data-testid="runtime-signin-retry"]')).toBeTruthy();
  });
});

describe("a sign-in that works", () => {
  it("never fires the deadline once the browser flow is waiting", async () => {
    render({
      loginStart: async () => ({ state: "waiting", message: "Complete sign-in in your browser." }),
      loginStatus: async () => ({ state: "waiting", message: "Complete sign-in in your browser." }),
    });
    await settle();
    expect(host.querySelector('[data-testid="runtime-signin"]')?.getAttribute("data-state")).toBe("waiting");

    await new Promise((resolve) => setTimeout(resolve, 80));
    await settle();

    expect(text()).not.toContain("didn’t open its sign-in");
    expect(text()).toContain("Finish signing in to Claude Code");
  });
});
