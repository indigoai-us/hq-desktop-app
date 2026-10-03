// @vitest-environment happy-dom
// BLANK-3: a slow team read is never reported as failed. While it is pending
// the page shows the loader; a slow answer (20 s) still renders; only a read
// that really fails shows "Could not read the team." with Try again.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectPendingRead } from "../common/read-loader.test-support.js";

vi.mock("./team-bots-pages.js", async (orig) => ({
  ...(await orig<typeof import("./team-bots-pages.js")>()),
  readCompanyTeam: vi.fn(() => new Promise(() => {})),
  readTeamCache: vi.fn(() => null),
}));

import TeamPage from "./TeamPage.svelte";
import { readCompanyTeam } from "./team-bots-pages.js";

const ADA = { id: "prs_ada", displayName: "Ada Lovelace", kind: "human" as const, topSkills: [], activeProjects: [] };
const VIEW = { members: [ADA], humans: [ADA], agents: [], error: null, empty: false };

let component: Record<string, unknown> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TeamPage pending read (BLANK-3)", () => {
  it("a team read that never answers keeps loading with a waiting line and Try again, never a failed state", async () => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    component = mount(TeamPage, { target: document.body, props: { slug: "blank-1-team", company: {} } as never });
    flushSync();
    expect(document.querySelector("[data-testid='team-shimmer']")).toBeTruthy();
    await expectPendingRead(document, "team-loader");
  });

  it("a team read that answers after 20 s shows the team", async () => {
    vi.useFakeTimers();
    vi.mocked(readCompanyTeam).mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ view: VIEW, invites: [], error: null }), 20_000)) as never,
    );
    component = mount(TeamPage, { target: document.body, props: { slug: "blank-3-slow", company: {} } as never });
    flushSync();
    await vi.advanceTimersByTimeAsync(19_000);
    flushSync();
    expect(document.querySelector("[data-testid='team-loader']")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Could not read the team.");
    await vi.advanceTimersByTimeAsync(1_100);
    flushSync();
    expect(document.querySelector("[data-testid='team-loader']")).toBeNull();
    expect(document.body.textContent).toContain("Ada Lovelace");
    expect(document.body.textContent).not.toContain("Could not read the team.");
  });

  it("a team read that rejects shows the failed state with Try again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(readCompanyTeam).mockImplementationOnce(() => Promise.reject(new Error("network down")));
    component = mount(TeamPage, { target: document.body, props: { slug: "blank-3-fail", company: {} } as never });
    await vi.waitFor(() => expect(document.querySelector("[data-testid='team-load-error']")).toBeTruthy());
    expect(document.querySelector("[data-testid='team-load-error']")?.textContent).toContain("Could not read the team.");
    expect(document.querySelector("[data-testid='team-retry']")).toBeTruthy();
    expect(document.querySelector("[data-testid='team-loader']")).toBeNull();
  });
});
