// @vitest-environment happy-dom

// A lazy chunk can fail to load in the shipped app (UI bundle swap, app
// update in progress). The door retries, logs the final failure, and
// LazyDoor shows the failed line with Try again instead of leaving the
// loading frame up forever.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount, type Component } from "svelte";

import LazyDoor from "./LazyDoor.svelte";
import { LAZY_DOOR_RETRY_DELAYS_MS, createDoor } from "./lazy-doors.js";
import Body from "./LazyDoor.retry.fixture.svelte";

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !check(); i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
}

const chunkError = () => new TypeError("Importing a module script failed.");

/** console.error calls that are the door's final-failure log. */
function finalFailureLogs(spy: { mock: { calls: unknown[][] } }): unknown[][] {
  return spy.mock.calls.filter((args: unknown[]) => args[0] === "[lazy-door] load failed after retries");
}

describe("lazy door chunk failures", () => {
  it("retries twice, after 250 ms and then 1 s", () => {
    expect(LAZY_DOOR_RETRY_DELAYS_MS).toEqual([250, 1000]);
  });

  it("retries a failed import and loads without logging a failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let calls = 0;
    const door = createDoor(
      "Flaky",
      () => {
        calls++;
        return calls < 3
          ? Promise.reject(chunkError())
          : Promise.resolve({ default: Body as unknown as Component<any> });
      },
      [0, 0],
    );
    await expect(door.load()).resolves.toBe(Body);
    expect(calls).toBe(3);
    expect(finalFailureLogs(error)).toEqual([]);
  });

  it("logs once after the retries, shows Try again, and Try again loads the body", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let fail = true;
    let calls = 0;
    const door = createDoor(
      "TeamPage",
      () => {
        calls++;
        return fail
          ? Promise.reject(chunkError())
          : Promise.resolve({ default: Body as unknown as Component<any> });
      },
      [0, 0],
    );

    const host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(LazyDoor, { target: host, props: { door, props: { label: "team body" } } });
    flushSync();
    await until(() => host.querySelector('[data-testid="lazy-door-failed"]') !== null);

    expect(calls).toBe(3);
    const logs = finalFailureLogs(error);
    expect(logs).toHaveLength(1);
    expect(logs[0]![1]).toBe("TeamPage");
    expect(logs[0]![2]).toBeInstanceOf(TypeError);
    const failedText = host.querySelector('[data-testid="lazy-door-failed"]')?.textContent ?? "";
    expect(failedText).toContain("This didn’t load. Try again in a moment.");
    expect(failedText).not.toContain("Importing a module script failed");
    expect(host.querySelector('[data-testid="lazy-door-retry"]')?.textContent).toContain("Try again");

    fail = false;
    host.querySelector<HTMLButtonElement>('[data-testid="lazy-door-retry"]')!.click();
    flushSync();
    await until(() => host.textContent?.includes("team body") ?? false);
    expect(host.textContent).toContain("team body");
    expect(host.querySelector('[data-testid="lazy-door-failed"]')).toBeNull();
    expect(finalFailureLogs(error)).toHaveLength(1);
  });

  it("keeps the caller's loading frame when the caller handles the failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const door = createDoor("FirstRunImportStep", () => Promise.reject(chunkError()), [0]);
    let failedOnce = false;
    door.load().catch(() => (failedOnce = true));
    const host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(LazyDoor, {
      target: host,
      props: { door, props: {}, keepLoadingOnFailure: true },
    });
    flushSync();
    await until(() => failedOnce);
    await until(() => false);
    expect(host.querySelector('[data-testid="lazy-door-failed"]')).toBeNull();
  });
});
