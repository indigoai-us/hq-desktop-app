// @vitest-environment happy-dom
// OWNER-R11: the Skills Usage tab shows team runs beside your own; a failed
// team read keeps your runs on screen with a plain line, and the reverse.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failure, ok } from "@hq/platform";
import BrainPage from "./BrainPage.svelte";
import { COMPANY, ME } from "./skill-usage.fixtures";

const skill = (name: string) => ({ name, description: "", scope: "company", company: "acme", path: "skills/" + name + "/SKILL.md", allowedTools: [] });
const library = { getCompany: vi.fn(async () => ok({ workers: [], skills: ["handoff", "design-review", "run-project"].map(skill) })) };

describe("OWNER-R11 Skills team usage", () => {
  let component: Record<string, unknown> | null = null;
  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.innerHTML = "";
    localStorage.clear();
  });

  function mountPage(usage: Record<string, unknown>) {
    component = mount(BrainPage, {
      target: document.body,
      props: { page: "skills", slug: "acme", files: null, library: library as never, shell: null, settings: null, usage: usage as never },
    });
  }
  async function openUsage(usage: Record<string, unknown>) {
    mountPage(usage);
    await vi.waitFor(() => expect(document.querySelector("[data-testid='skill-row']")).toBeTruthy());
    [...document.querySelectorAll<HTMLButtonElement>("button[role='tab']")].find((b) => b.textContent === "Usage")!.click();
    flushSync();
  }
  const rows = () =>
    [...document.querySelectorAll("[data-testid='skills-usage-row']")].map((r) => [...r.querySelectorAll("span")].map((s) => s.textContent));

  it("lists team runs, your runs, people and last run, sorted by team runs", async () => {
    const team = vi.fn(async () => ok(COMPANY));
    await openUsage({ team, mine: vi.fn(async () => ok(ME)) });
    await vi.waitFor(() => expect(rows()[0]?.[1]).toBe("7"));
    expect(team).toHaveBeenCalledWith("acme", expect.objectContaining({ from: expect.any(String), to: expect.any(String) }));
    expect([...document.querySelectorAll("[data-testid='skills-usage'] .head span")].map((s) => s.textContent)).toEqual([
      "Skill", "Team runs", "Your runs (all companies)", "People", "Last run (date)",
    ]);
    expect(rows()).toEqual([
      ["run-project", "7", "3", "2", "Oct 1"],
      ["design-review", "1", "—", "1", "Oct 2"],
      ["handoff", "—", "1", "—", "—"],
    ]);
  });

  it("keeps your runs when the team read fails, with a plain line and Try again", async () => {
    const team = vi.fn(async (): Promise<unknown> => failure("forbidden", "HTTP 403 Forbidden"));
    await openUsage({ team, mine: vi.fn(async () => ok(ME)) });
    await vi.waitFor(() => expect(document.querySelector("[data-testid='skills-usage-team-failed']")).toBeTruthy());
    expect(document.body.textContent).not.toContain("403");
    await vi.waitFor(() => expect(rows().find((r) => r[0] === "run-project")).toEqual(["run-project", "—", "3", "—", "—"]));
    team.mockImplementation(async () => ok(COMPANY));
    document.querySelector<HTMLButtonElement>("[data-testid='skills-usage-team-failed'] button")!.click();
    await vi.waitFor(() => expect(rows()[0]?.[1]).toBe("7"));
  });

  it("keeps team runs when your read fails", async () => {
    await openUsage({ team: vi.fn(async () => ok(COMPANY)), mine: vi.fn(async () => failure("network", "boom")) });
    await vi.waitFor(() => expect(document.querySelector("[data-testid='skills-usage-mine-failed']")).toBeTruthy());
    await vi.waitFor(() => expect(rows()[0]).toEqual(["run-project", "7", "—", "2", "Oct 1"]));
  });

  it("shows a usage block in the skill detail", async () => {
    mountPage({ team: async () => ok(COMPANY), mine: async () => ok(ME) });
    await vi.waitFor(() => expect(document.querySelector("[data-testid='skill-row']")).toBeTruthy());
    [...document.querySelectorAll<HTMLButtonElement>("[data-testid='skill-row']")].find((b) => b.textContent?.includes("run-project"))!.click();
    await vi.waitFor(() => expect(document.querySelector("[data-testid='skill-usage-block']")?.textContent).toContain("7"));
    expect(document.querySelector("[data-testid='skill-usage-block']")?.textContent).toContain("Oct 1");
  });
});
