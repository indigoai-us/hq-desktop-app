// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import ActivityView from "./ActivityView.svelte";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  localStorage.clear();
});

describe("ActivityView without a telemetry read", () => {
  it("opens on the team list with the range control and no view switch", () => {
    host = document.createElement("div");
    document.body.append(host);
    component = mount(ActivityView, {
      target: host,
      props: { slug: "indigo", companyLabel: "Indigo" },
    });
    flushSync();
    expect(host.querySelector("[aria-label='Activity views']")).toBeNull();
    expect(host.querySelector("[aria-label='Range']")).not.toBeNull();
    expect(host.querySelector("[data-testid='activity-empty']")?.textContent).toContain(
      "No team activity in this range yet.",
    );
  });
});
