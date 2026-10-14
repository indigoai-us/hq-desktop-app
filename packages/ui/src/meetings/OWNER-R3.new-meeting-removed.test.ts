// @vitest-environment happy-dom
/**
 * OWNER-R3: the New meeting window is gone. No header button, empty-canvas
 * button, or paste-box option opens it, and nothing says meetings are saved
 * on this Mac.
 */
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import MeetingsSidepane from "./MeetingsSidepane.svelte";
import MeetingsStatesBody from "./MeetingsStatesBody.svelte";
import { meetingsRailState } from "./meetings-rail-state.svelte";
import { EMPTY_MEETINGS_FILTER } from "./meetings-rail-model";

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(async () => {
  while (mounted.length) await unmount(mounted.pop()!);
  document.body.innerHTML = "";
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function render(component: any, props: Record<string, unknown>): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  mounted.push(mount(component, { target, props }));
  flushSync();
  return target;
}

describe("OWNER-R3 New meeting window removed", () => {
  it("the Meetings header has no New meeting button", () => {
    const el = render(MeetingsSidepane, {
      sections: [],
      events: [],
      companyNamesByUid: new Map(),
      selectedId: null,
      filter: EMPTY_MEETINGS_FILTER,
    });
    expect(el.querySelector('[aria-label="New meeting"]')).toBeNull();
    expect(el.querySelector('[data-testid="meetings-new-button"]')).toBeNull();
  });

  it("the empty canvas offers no New meeting and no on-this-Mac sheet", () => {
    const el = render(MeetingsStatesBody, { mode: "empty", sections: [], now: new Date(2026, 9, 3, 9) });
    const text = el.textContent ?? "";
    expect(text).not.toContain("New meeting");
    expect(text).not.toContain("Create meeting");
    expect(text).not.toContain("Saved on this Mac");
    expect(el.querySelector('[data-testid="new-meeting-sheet"]')).toBeNull();
    expect(el.querySelector('[data-testid="empty-new-meeting"]')).toBeNull();
  });

  it("the rail state keeps no local draft meetings", () => {
    const state = meetingsRailState as unknown as Record<string, unknown>;
    expect(state.openSheet).toBeUndefined();
    expect(state.addLocalMeeting).toBeUndefined();
    expect(state.localMeetings).toBeUndefined();
  });
});
