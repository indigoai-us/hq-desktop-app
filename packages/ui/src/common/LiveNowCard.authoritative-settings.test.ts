// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import LiveNowCard from "./LiveNowCard.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("LiveNowCard authoritative detected-meeting behavior", () => {
  it("renders a detected meeting as a visible, recordable live row", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(LiveNowCard, {
      target: host,
      props: {
        meeting: {
          windowId: "zoom-window-1",
          meetingUrl: "recall-window:zoom-window-1",
          platform: "zoom",
          detectedAt: new Date().toISOString(),
          state: "detected",
          companyUid: null,
          summary: "Customer call",
        },
        onstart: () => {},
        onstop: () => {},
      },
    });

    await tick();

    expect(host.querySelector('[data-testid="meetings-live-now"]')?.textContent).toContain(
      "Customer call",
    );
    expect(host.textContent).toContain("Zoom · Detected");
    expect(host.querySelector("button.primary")?.textContent).toContain("Start recording");
  });
});
