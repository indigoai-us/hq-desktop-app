// @vitest-environment happy-dom
// BLANK-3: a cold past-meetings read shows the shared loader (waiting line,
// then Try again), never "Past meetings could not load" while it is pending.
import { mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import MeetingsSidepane from "./MeetingsSidepane.svelte";
import { EMPTY_MEETINGS_FILTER } from "./meetings-rail-model.js";
import { expectPendingRead } from "../common/read-loader.test-support.js";

let component: Record<string, unknown> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("MeetingsSidepane pending read (BLANK-3)", () => {
  it("a cold read keeps the loader with a waiting line and Try again", async () => {
    vi.useFakeTimers();
    const onretry = vi.fn();
    component = mount(MeetingsSidepane, {
      target: document.body,
      props: { sections: [], events: [], companyNamesByUid: new Map(), selectedId: null, filter: EMPTY_MEETINGS_FILTER, loading: true, onretry },
    });
    await expectPendingRead(document, "meetings-loader");
    expect(document.querySelector("[data-testid='meetings-sidepane-error']")).toBeNull();
    (document.querySelector("[data-testid='meetings-loader-retry']") as HTMLButtonElement).click();
    expect(onretry).toHaveBeenCalledTimes(1);
  });
});
