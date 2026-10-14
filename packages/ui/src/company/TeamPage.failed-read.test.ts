// @vitest-environment happy-dom
// BLANK-2: a team read that fails with nothing loaded shows only the failed
// line and Try again. "No people yet", section counts and the seat chip wait
// for a read that succeeded, so a failed company never looks empty.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./team-bots-pages.js", async (orig) => ({
  ...(await orig<typeof import("./team-bots-pages.js")>()),
  readCompanyTeam: vi.fn(() => Promise.reject(new Error("HTTP 503 upstream"))),
  readTeamCache: vi.fn(() => null),
}));

import TeamPage from "./TeamPage.svelte";

let component: Record<string, unknown> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("TeamPage failed read (BLANK-2)", () => {
  it("shows the failed line and Try again, and no empty copy or zero counts", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    component = mount(TeamPage, { target: document.body, props: { slug: "blank-2-team", company: {} } as never });
    await vi.waitFor(() => expect(document.querySelector("[data-testid='team-load-error']")).toBeTruthy());
    flushSync();
    const text = document.body.textContent ?? "";
    expect(document.querySelector("[data-testid='team-retry']")).toBeTruthy();
    expect(text).not.toContain("No people yet");
    expect(text).not.toContain("No bots yet");
    expect(text).not.toContain("No pending invites");
    expect(document.querySelector("[data-testid='team-section-label']")).toBeNull();
    expect(document.querySelector("[data-testid='team-seat-chip']")).toBeNull();
    expect(document.querySelector("[data-testid='team-live-chip']")).toBeNull();
    expect(text).not.toContain("HTTP 503");
  });
});
