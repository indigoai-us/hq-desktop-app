// @vitest-environment happy-dom
// OWNER-R4: the Atlas People & agents list reads company telemetry (the web
// Atlas people read) only after the map has painted, lists people and agents
// by tokens without ids, lights up the skills a person ran, and fails on its
// own without touching the map.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import AtlasView from "./AtlasView.svelte";
import { createAtlasCache } from "./atlas-cache.js";
import { smokeAtlasGraph } from "./atlas-model.js";
import { atlasPeopleFromTelemetry } from "./atlas-people.js";

const NOW = Date.UTC(2026, 8, 30, 12);
const skillNode = smokeAtlasGraph().nodes.find((n) => n.type === "skill")!;
const tokens = (n: number) => [{ model: "claude", input: n, output: 0, cacheCreation: 0, cacheRead: 0 }];
const BODY = {
  perMember: [
    {
      personUid: "prs_a",
      email: "ada@example.com",
      label: "Ada",
      totals: { tokensByModel: tokens(1_200_000), skills: { total: 3, bySkill: [{ skill: `/${skillNode.label}`, count: 3 }] }, distinctSessions: 7 },
      outcomes: { byType: { storyCompleted: 2 } },
      trend: [1, 4, 2],
    },
    { personUid: "agt_x", label: "", totals: { tokensByModel: tokens(5_000), skills: { total: 0, bySkill: [] }, distinctSessions: 2 } },
    { personUid: "prs_idle", label: "Idle", totals: { tokensByModel: [], skills: { total: 0, bySkill: [] }, distinctSessions: 0 } },
  ],
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function mountView(loadPeople: () => Promise<unknown>, fetcher = async () => smokeAtlasGraph()) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(AtlasView, {
    target: host,
    props: { companyUid: "cmp_acme", companyName: "Acme", cache: createAtlasCache({ fetcher }), nowMs: NOW, presence: [], loadPeople },
  });
}

describe("OWNER-R4 Atlas People & agents", () => {
  it("parses people and agents by tokens, never showing ids, and drops idle members", () => {
    expect(atlasPeopleFromTelemetry(BODY).map((p) => [p.name, p.bot, p.tokens, p.sessions, p.stories])).toEqual([
      ["Ada", false, 1_200_000, 7, 2],
      ["Unknown bot", true, 5_000, 2, 0],
    ]);
    expect(() => atlasPeopleFromTelemetry({})).toThrow();
  });

  it("paints the map before the people read, then lists people and agents", async () => {
    let release: (v: unknown) => void = () => {};
    let mapPaintedAtCall = false;
    const loadPeople = vi.fn(() => {
      mapPaintedAtCall = host.querySelectorAll("[data-atlas-node]").length > 0;
      return new Promise((r) => (release = r));
    });
    mountView(loadPeople);
    await vi.waitFor(() => expect(loadPeople).toHaveBeenCalledTimes(1));
    expect(mapPaintedAtCall).toBe(true);
    flushSync();
    expect(host.querySelector("[data-testid='atlas-people-loading']")).toBeTruthy();
    release(BODY);
    await vi.waitFor(() => expect(host.querySelectorAll("[data-testid='atlas-person']")).toHaveLength(2));
    const rows = [...host.querySelectorAll("[data-testid='atlas-person']")].map((r) => r.textContent ?? "");
    expect(rows[0]).toContain("Ada");
    expect(rows[0]).toContain("1.2M");
    expect(rows[0]).toContain("7 sess · 2 stories");
    expect(rows[1]).toContain("Unknown bot");
    expect(rows[1]).toContain("agent");
    expect(host.textContent).not.toMatch(/\b(prs|agt)_/);
  });

  it("lights up the skills a person ran when the person is picked", async () => {
    mountView(async () => BODY);
    await vi.waitFor(() => expect(host.querySelectorAll("[data-testid='atlas-person']").length).toBeGreaterThan(0));
    host.querySelector<HTMLButtonElement>("[data-testid='atlas-person']")!.click();
    flushSync();
    const lit = host.querySelector(`[data-atlas-node="${skillNode.id}"]`)!;
    expect(lit.classList.contains("dim")).toBe(false);
    const other = [...host.querySelectorAll("[data-atlas-node]")].find((n) => n.getAttribute("data-atlas-node") !== skillNode.id)!;
    expect(other.classList.contains("dim")).toBe(true);
    expect(host.querySelector("[data-testid='atlas-person-matches']")?.textContent).toBe("1 of their skills on the map.");
  });

  it("dims nothing when none of the person's skills are on the map", async () => {
    mountView(async () => ({ perMember: [{ ...BODY.perMember[0], totals: { ...BODY.perMember[0]!.totals, skills: { total: 1, bySkill: [{ skill: "not-on-map", count: 1 }] } } }] }));
    await vi.waitFor(() => expect(host.querySelectorAll("[data-testid='atlas-person']").length).toBe(1));
    host.querySelector<HTMLButtonElement>("[data-testid='atlas-person']")!.click();
    flushSync();
    expect(host.querySelectorAll("[data-atlas-node].dim")).toHaveLength(0);
    expect(host.querySelector("[data-testid='atlas-person-matches']")?.textContent).toBe("None of the skills they ran are on this map.");
  });

  it("keeps the map when the people read fails, with a plain line and Try again", async () => {
    const loadPeople = vi.fn(async (): Promise<unknown> => {
      throw new Error("HTTP 502 Bad Gateway");
    });
    mountView(loadPeople);
    await vi.waitFor(() => expect(host.querySelector("[data-testid='atlas-people-failed']")).toBeTruthy());
    expect(host.querySelectorAll("[data-atlas-node]").length).toBeGreaterThan(0);
    expect(host.textContent).not.toContain("502");
    loadPeople.mockImplementation(async () => BODY);
    host.querySelector<HTMLButtonElement>("[data-testid='atlas-people-failed'] button")!.click();
    await vi.waitFor(() => expect(host.querySelectorAll("[data-testid='atlas-person']")).toHaveLength(2));
  });

  it("tells a member plainly that only owners and admins see team activity", async () => {
    mountView(async () => {
      throw Object.assign(new Error("Forbidden"), { code: "forbidden" });
    });
    await vi.waitFor(() =>
      expect(host.querySelector("[data-testid='atlas-people-failed']")?.textContent).toContain("Only owners and admins can see team activity."),
    );
  });
});
