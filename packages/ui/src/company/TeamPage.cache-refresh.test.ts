// @vitest-environment happy-dom
// BLANK-3: a team already read this session paints from the cache at once and
// refreshes quietly. A slow refresh shows "Refreshing…", never the loader or a
// failure; a failed refresh keeps the saved team with a quiet Try again.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import TeamPage from "./TeamPage.svelte";
import { writeTeamCache } from "./team-bots-pages.js";

let component: Record<string, unknown> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const ADA = { id: "prs_ada", displayName: "Ada Lovelace", kind: "human" as const, topSkills: [], activeProjects: [] };

function seed(slug: string): void {
  writeTeamCache(slug, { view: { members: [ADA], humans: [ADA], agents: [], error: null, empty: false }, invites: [] });
}

function mountTeam(slug: string, telemetry: () => Promise<unknown>, contacts: () => Promise<unknown>) {
  const company = { getTeamTelemetry: vi.fn(telemetry), listMembers: vi.fn(async () => ({ ok: true, value: [] })) };
  const messaging = { listContacts: vi.fn(contacts) };
  component = mount(TeamPage, { target: document.body, props: { slug, companyUid: `cmp_${slug}`, company, messaging } as never });
}

describe("TeamPage cache while refreshing (BLANK-3)", () => {
  it("shows the saved team with a quiet Refreshing while a slow read runs", () => {
    seed("cache-slow");
    mountTeam("cache-slow", () => new Promise(() => {}), () => new Promise(() => {}));
    flushSync();
    expect(document.body.textContent).toContain("Ada Lovelace");
    expect(document.querySelector("[data-testid='team-refreshing']")?.textContent).toBe("Refreshing…");
    expect(document.querySelector("[data-testid='team-loader']")).toBeNull();
    expect(document.querySelector("[data-testid='team-load-error']")).toBeNull();
  });

  it("keeps the saved team when the refresh fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    seed("cache-fail");
    mountTeam(
      "cache-fail",
      async () => ({ ok: false, reason: "network", message: "down" }),
      async () => ({ ok: false, reason: "network", message: "down" }),
    );
    await vi.waitFor(() => expect(document.querySelector("[data-testid='team-refresh-failed']")).toBeTruthy());
    expect(document.body.textContent).toContain("Ada Lovelace");
    expect(document.querySelector("[data-testid='team-load-error']")).toBeNull();
  });
});
