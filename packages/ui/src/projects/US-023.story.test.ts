// @vitest-environment happy-dom

// US-023: Active cards show a live chip (phase · elapsed), stacked faces
// (humans circle, bots rounded square), and the scaleX progress bar; the
// New project sheet carries name, company, location, owner, LinkPicker, and
// start-from.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import ProjectRow from "./ProjectRow.svelte";
import NewProjectSheet from "./NewProjectSheet.svelte";
import { projectLiveRunView, type Project } from "./projects-model.js";
import type { Objective } from "./local-projects.js";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

function render(Comp: unknown, props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(Comp as Parameters<typeof mount>[0], { target: host, props });
  flushSync();
  return host;
}

const project = {
  id: "console-rail",
  name: "console-rail",
  title: "Console rail + Atlas",
  description: "",
  company: "indigo",
  prdPath: "/hq/companies/indigo/projects/console-rail/prd.json",
  status: "active",
  storiesComplete: 1,
  storiesTotal: 11,
  provenance: { owner: "Corey Epstein" },
} as unknown as Project;

describe("US-023 Active card", () => {
  it("shows the live chip and the bot face for a project with a live bot", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    const liveRun = projectLiveRunView(
      project,
      [
        {
          project: "console-rail",
          company: "indigo",
          cwd: "",
          status: "running",
          startedAt: "2026-10-01T09:46:00Z",
          lastActivityAt: "2026-10-01T11:59:50Z",
          agent: "deacon",
        },
      ],
      now,
    );
    expect(liveRun?.bots).toEqual(["deacon"]);
    const el = render(ProjectRow, { project, liveRun, now, showCompany: false });

    const chip = el.querySelector('[data-testid="project-live-run"]');
    expect(chip?.textContent).toContain("Running");
    expect(chip?.textContent).toContain(liveRun?.elapsed ?? "x");

    const faces = [...el.querySelectorAll('[data-testid="board-faces"] .mini')];
    expect(faces.map((f) => f.getAttribute("data-kind"))).toEqual(["human", "bot"]);
    expect(faces[1].classList.contains("sq")).toBe(true);
    expect(faces[0].classList.contains("sq")).toBe(false);
    expect(el.textContent).toContain("Corey + deacon");

    const fill = el.querySelector<HTMLElement>(".progress-fill");
    expect(fill?.getAttribute("style")).toContain("--fill: 0.0");
  });

  it("non-live cards keep the calm footer with no live chip", () => {
    const el = render(ProjectRow, { project, showCompany: false });
    expect(el.querySelector('[data-testid="project-live-run"]')).toBeNull();
    expect(el.querySelector('[data-testid="board-faces"]')).toBeNull();
  });
});

describe("US-023 New project sheet", () => {
  const goals: Objective[] = [
    {
      id: "desktop",
      title: "Desktop Experience",
      description: "",
      status: "active",
      timeframe: "Q4",
      keyResults: [{ id: "kr1", title: "Ship the Console rail" }],
      initiativeIds: [],
    },
  ];

  it("collects every field and hands the draft to oncreate", async () => {
    const oncreate = vi.fn(async () => {});
    const onclose = vi.fn();
    const el = render(NewProjectSheet, {
      company: "indigo",
      companies: ["indigo", "personal"],
      owners: ["Corey"],
      objectives: goals,
      oncreate,
      onclose,
    });
    const name = el.querySelector<HTMLInputElement>('[data-testid="new-project-name"]')!;
    name.value = "HQ Desktop Widget";
    name.dispatchEvent(new Event("input"));
    flushSync();
    expect(el.textContent).toContain("hq-desktop-widget");

    el.querySelector<HTMLButtonElement>('[data-testid="new-project-repo"]')!.click();
    flushSync();
    el.querySelector<HTMLButtonElement>('[data-testid="link-picker-field"]')!.click();
    flushSync();
    const options = el.querySelectorAll<HTMLButtonElement>('[data-testid="link-picker-option"]');
    expect(options.length).toBe(2);
    options[1].click();
    flushSync();
    const tabs = [...el.querySelectorAll<HTMLButtonElement>('[data-testid="new-project-start"] .tab')];
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(["Blank", "Brainstorm", "PRD"]);
    tabs[2].click();
    flushSync();

    el.querySelector<HTMLButtonElement>('[data-testid="new-project-create"]')!.click();
    await Promise.resolve();
    expect(oncreate).toHaveBeenCalledTimes(1);
    const draft = (oncreate.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(draft).toMatchObject({
      name: "HQ Desktop Widget",
      company: "indigo",
      location: "repo",
      start: "prd",
    });
    expect((draft.link as { id: string }).id).toBe("desktop#kr1");
  });
});
