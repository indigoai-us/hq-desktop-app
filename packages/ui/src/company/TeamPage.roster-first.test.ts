// @vitest-environment happy-dom
// BLANK-3: the Team roster read answers in about 0.3 s, the telemetry route in
// 3-4 s for a 58-person company (more under load). People must show as soon
// as the roster answers; a slow or failed telemetry read never holds or fails
// the roster.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import TeamPage from "./TeamPage.svelte";

let component: Record<string, unknown> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const ROSTER = [
  { personUid: "prs_ada", displayName: "Ada Lovelace" },
  { personUid: "prs_grace", displayName: "Grace Hopper" },
];

function mountTeam(slug: string, getTeamTelemetry: () => Promise<unknown>) {
  const company = {
    getTeamTelemetry: vi.fn(getTeamTelemetry),
    listMembers: vi.fn(async () => ({ ok: true, value: [] })),
  };
  const messaging = { listContacts: vi.fn(async () => ({ ok: true, value: ROSTER })) };
  component = mount(TeamPage, {
    target: document.body,
    props: { slug, companyUid: `cmp_${slug}`, company, messaging } as never,
  });
  return company;
}

describe("TeamPage roster first (BLANK-3)", () => {
  it("shows people while the telemetry read is still pending", async () => {
    mountTeam("roster-first-pending", () => new Promise(() => {}));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Ada Lovelace"));
    flushSync();
    expect(document.body.textContent).toContain("Grace Hopper");
    expect(document.querySelector("[data-testid='team-loader']")).toBeNull();
    expect(document.querySelector("[data-testid='team-load-error']")).toBeNull();
  });

  it("keeps the roster when the telemetry read rejects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mountTeam("roster-first-reject", () => Promise.reject(new Error("network down")));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Ada Lovelace"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    flushSync();
    expect(document.body.textContent).toContain("Ada Lovelace");
    expect(document.querySelector("[data-testid='team-load-error']")).toBeNull();
  });
});
