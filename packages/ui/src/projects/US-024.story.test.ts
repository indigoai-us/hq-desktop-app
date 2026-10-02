// @vitest-environment happy-dom

// US-024: clicking a board card opens a 360 px task view pane — who is on it
// now, the task list with done / open / live marks, and the selected task with
// acceptance criteria, owner, bot, dependencies, branch, and actions. Mark
// done shows an undo toast.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import TaskViewPane from "./TaskViewPane.svelte";
import ToastStack from "../shell/ToastStack.svelte";
import { pushToast, toastItems, dismissToast } from "../shell/toast-stack.svelte.js";
import { defaultTaskId, doneSummary, taskBot, taskMark, taskOwner } from "./task-view.js";
import { projectLiveRunView, type Project, type Story } from "./projects-model.js";
import type { PortfolioSessionRef } from "../chat/portfolio-session.js";

const mounted: Array<{ c: ReturnType<typeof mount>; host: HTMLElement }> = [];

afterEach(async () => {
  for (const { c, host } of mounted.splice(0)) {
    await unmount(c);
    host.remove();
  }
  for (const t of toastItems()) dismissToast(t.id);
});

function render(Comp: unknown, props: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const c = mount(Comp as Parameters<typeof mount>[0], { target: host, props });
  mounted.push({ c, host });
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
  storiesTotal: 3,
  provenance: { owner: "Corey Epstein" },
} as unknown as Project;

function story(id: string, title: string, extra: Partial<Story> = {}): Story {
  return {
    id,
    title,
    description: `${title} description`,
    acceptanceCriteria: [`${id} criterion one`, `${id} criterion two`],
    passes: false,
    labels: [],
    dependsOn: [],
    ...extra,
  };
}

const stories: Story[] = [
  story("US-001", "Rail shell", { passes: true }),
  story("US-002", "Pinned companies"),
  story("US-014", "Atlas route", {
    dependsOn: ["US-004"],
    provenance: { owner: "Corey Epstein", assignee: null, creator: null, origin: null },
  }),
];

const now = Date.parse("2026-10-01T12:00:00Z");
const sessions: PortfolioSessionRef[] = [
  {
    project: "console-rail",
    company: "indigo",
    cwd: "/hq",
    status: "running",
    startedAt: "2026-10-01T11:46:00Z",
    serverSessionId: "s1",
    taskId: "US-014",
    agent: "deacon",
  },
];

describe("US-024 task view model", () => {
  it("marks done, live, and open tasks and selects the live one first", () => {
    expect(stories.map((s) => taskMark(s, sessions))).toEqual(["done", "open", "live"]);
    expect(defaultTaskId(stories, sessions)).toBe("US-014");
    expect(defaultTaskId(stories, [])).toBe("US-002");
    expect(doneSummary(stories)).toBe("Tasks · 1 of 3 done");
    expect(taskOwner(stories[2])).toBe("Corey Epstein");
    expect(taskBot(stories[2], sessions)).toBe("deacon");
    expect(taskBot(stories[1], sessions)).toBeNull();
  });
});

describe("US-024 task view pane", () => {
  function pane(extra: Record<string, unknown> = {}) {
    return render(TaskViewPane, {
      project,
      stories,
      sessions,
      branch: "feat/console-rail",
      liveRun: projectLiveRunView(project, sessions, now),
      lead: "Corey Epstein",
      onclose: vi.fn(),
      onopenproject: vi.fn(),
      onmarkdone: vi.fn(),
      ...extra,
    });
  }

  it("opens with the selected task's acceptance criteria", () => {
    const host = pane();
    const detail = host.querySelector('[data-testid="task-view-detail"]')!;
    expect(detail.textContent).toContain("US-014 · Atlas route");
    const ac = host.querySelector('[data-testid="task-view-acceptance"]')!;
    expect(ac.textContent).toContain("US-014 criterion one");
    expect(detail.textContent).toContain("Corey Epstein");
    expect(detail.textContent).toContain("deacon");
    expect(detail.textContent).toContain("US-004");
    expect(detail.textContent).toContain("feat/console-rail");
    expect(host.querySelector('[data-testid="task-view-now"]')).not.toBeNull();
  });

  it("leads with a live Now row: faces, phase, and elapsed", () => {
    const host = pane();
    const row = host.querySelector<HTMLElement>('[data-testid="task-view-now"]')!;
    expect(row.classList.contains("is-live")).toBe(true);
    expect(row.querySelector(".ldot")).not.toBeNull();
    const pb = host.querySelector(".pb")!;
    expect(pb.firstElementChild?.textContent).toBe("Now");
  });

  it("keeps a quiet Now row with no green when nothing is running", () => {
    const host = pane({ liveRun: null });
    const row = host.querySelector<HTMLElement>('[data-testid="task-view-now"]')!;
    expect(row.classList.contains("is-live")).toBe(false);
    expect(row.querySelector(".ldot")).toBeNull();
    expect(row.textContent).toContain("Corey Epstein · Nothing running");
  });

  it("shows done, open, and live marks and selects with background only", () => {
    const host = pane();
    const items = [...host.querySelectorAll<HTMLElement>('[data-testid="task-view-item"]')];
    expect(items.map((i) => i.dataset.mark)).toEqual(["done", "open", "live"]);
    items[1].click();
    flushSync();
    expect(items[1].getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('[data-testid="task-view-acceptance"]')!.textContent).toContain(
      "US-002 criterion one",
    );
  });

  it("paints a skeleton, never a blank pane, while the first read loads", () => {
    const host = pane({ stories: [], loading: true });
    expect(host.querySelector('[data-testid="task-view-skeleton"]')).not.toBeNull();
  });

  it("hands Mark done and Open project to the board", () => {
    const onmarkdone = vi.fn();
    const onopenproject = vi.fn();
    const host = pane({ onmarkdone, onopenproject });
    host.querySelector<HTMLElement>('[data-testid="task-view-mark-done"]')!.click();
    expect(onmarkdone).toHaveBeenCalledWith(expect.objectContaining({ id: "US-014" }));
    host.querySelector<HTMLElement>('[data-testid="task-view-open-project"]')!.click();
    expect(onopenproject).toHaveBeenCalledWith("US-014");
  });
});

describe("US-024 undo toast", () => {
  it("runs the undo action and dismisses the toast", () => {
    const undo = vi.fn();
    render(ToastStack, {});
    pushToast({ title: "Marked done", detail: "US-014", tone: "ok", actionLabel: "Undo", onAction: undo });
    flushSync();
    // OWNER-003: the shared toast layer portals to <body>.
    const action = document.querySelector<HTMLElement>('[data-testid="toast-action"]')!;
    expect(action.textContent).toBe("Undo");
    action.click();
    flushSync();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="toast"]')).toBeNull();
  });
});
