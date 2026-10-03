// @vitest-environment happy-dom
// BLANK-1: a team read that never answers must not hold the shimmer forever;
// after the shared read deadline the page shows plain copy and Try again.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { READ_DEADLINE_MS } from "../common/read-deadline.js";

vi.mock("./team-bots-pages.js", async (orig) => ({
  ...(await orig<typeof import("./team-bots-pages.js")>()),
  readCompanyTeam: vi.fn(() => new Promise(() => {})),
  readTeamCache: vi.fn(() => null),
}));

import TeamPage from "./TeamPage.svelte";

let component: Record<string, unknown> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TeamPage read deadline (BLANK-1)", () => {
  it("a team read that never answers ends in the failed-read state", async () => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    component = mount(TeamPage, { target: document.body, props: { slug: "blank-1-team", company: {} } as never });
    flushSync();
    expect(document.querySelector("[data-testid='team-shimmer']")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS + 10);
    flushSync();
    expect(document.querySelector("[data-testid='team-shimmer']")).toBeNull();
    expect(document.querySelector("[data-testid='team-load-error']")?.textContent).toContain("Could not read the team.");
    expect(document.querySelector("[data-testid='team-retry']")).toBeTruthy();
    expect(logged).toHaveBeenCalled();
  });
});
