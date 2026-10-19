// @vitest-environment happy-dom

// A lazy chunk can fail to load in the shipped app (UI bundle swap, app
// update in progress). The door retries, reports the final failure, and
// LazyDoor shows the failed line with Try again instead of leaving the
// loading frame up forever.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount, type Component } from "svelte";

import LazyDoor from "./LazyDoor.svelte";
import { createDoor } from "./lazy-doors.js";
import { setLazyLoadFailureReporter } from "../common/lazy-load-report.js";
import Body from "./LazyDoor.retry.fixture.svelte";

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  setLazyLoadFailureReporter(null);
  vi.restoreAllMocks();
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !check(); i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
}

const chunkError = () => new TypeError("Importing a module script failed.");

describe("lazy door chunk failures", () => {
  it("retries a failed import and loads without reporting", async () => {
    const reports: string[] = [];
    setLazyLoadFailureReporter((surface) => reports.push(surface));
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
    expect(reports).toEqual([]);
  });

  it("reports once after the retries, shows Try again, and Try again loads the body", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reports: Array<[string, unknown]> = [];
    setLazyLoadFailureReporter((surface, error) => reports.push([surface, error]));
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
    expect(reports).toHaveLength(1);
    expect(reports[0]![0]).toBe("TeamPage");
    expect(reports[0]![1]).toBeInstanceOf(TypeError);
    const failedText = host.querySelector('[data-testid="lazy-door-failed"]')?.textContent ?? "";
    expect(failedText).toContain("Try again");
    expect(failedText).not.toContain("Importing a module script failed");

    fail = false;
    host.querySelector<HTMLButtonElement>('[data-testid="lazy-door-retry"]')!.click();
    flushSync();
    await until(() => host.textContent?.includes("team body") ?? false);
    expect(host.textContent).toContain("team body");
    expect(host.querySelector('[data-testid="lazy-door-failed"]')).toBeNull();
    expect(reports).toHaveLength(1);
  });

  it("sends one report per surface when a caller keeps retrying", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reports: string[] = [];
    setLazyLoadFailureReporter((surface) => reports.push(surface));
    const door = createDoor("FirstRunImportStep", () => Promise.reject(chunkError()), [0]);
    await expect(door.load()).rejects.toBeInstanceOf(TypeError);
    await expect(door.load()).rejects.toBeInstanceOf(TypeError);
    expect(reports).toEqual(["FirstRunImportStep"]);
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
