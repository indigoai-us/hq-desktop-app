// @vitest-environment happy-dom

/**
 * First view, "Your recent work": the latest threads found, each with its
 * project and tool and how long ago, and up to three most active projects
 * beside them. With no projects the list stands alone; with nothing at all
 * the card holds no stray text.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import FirstViewRecent from "./FirstViewRecent.svelte";
import type { FirstViewProject, FirstViewWork } from "./brief-first-view.js";

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const NOW = new Date("2026-10-18T16:00:00Z");
const RECENT: FirstViewWork[] = [
  { title: "Billing refactor", project: "billing", harness: "claude-code", tool: "Claude Code", at: "2026-10-18T15:48:00Z" },
  { title: "Fix flaky test", project: null, harness: "codex", tool: "Codex", at: "2026-10-18T13:00:00Z" },
  { title: "Draft launch notes", project: "marketing", harness: null, tool: null, at: "2026-10-17T14:00:00Z" },
];
const PROJECTS: FirstViewProject[] = [
  { name: "billing", sessions: 40 },
  { name: "", sessions: 9 },
  { name: "marketing", sessions: null },
  { name: "infra", sessions: 7 },
  { name: "docs", sessions: 3 },
];

async function render(props: Record<string, unknown>): Promise<void> {
  target = document.createElement("div");
  document.body.appendChild(target);
  component = mount(FirstViewRecent, { target, props: props as never });
  await tick();
}
const text = (el: Element): string => el.textContent!.replace(/\s+/g, " ").trim();
// Each part is its own element, laid out by CSS, so read the parts one by one.
const parts = (el: Element): string[] =>
  [...el.querySelectorAll(":scope > span:not(.fv-rt), :scope > b, .fv-rt > b, .fv-rt > span")]
    .map((e) => e.textContent!.trim())
    .filter(Boolean);

afterEach(() => {
  if (component) unmount(component);
  component = null;
  target?.remove();
});

describe("FirstViewRecent", () => {
  it("lists each recent thread with its project, tool and age", async () => {
    await render({ recent: RECENT, projects: [], now: NOW });
    const rows = [...target.querySelectorAll('[data-testid="first-view-recent-row"]')].map(parts);
    expect(rows).toEqual([
      ["Billing refactor", "billing · Claude Code", "12 min ago"],
      ["Fix flaky test", "Codex", "3 h ago"],
      ["Draft launch notes", "marketing", "Yesterday"],
    ]);
  });

  it("shows the three most active named projects, with sessions only when counted", async () => {
    await render({ recent: RECENT, projects: PROJECTS, now: NOW });
    const proj = target.querySelector('[data-testid="first-view-projects"]')!;
    expect(proj.querySelector(".fv-sub")!.textContent).toBe("Most active projects");
    expect([...proj.querySelectorAll(".fv-prow")].map(parts)).toEqual([["billing", "40", "sessions"], ["marketing"], ["infra", "7", "sessions"]]);
    expect(target.querySelector(".fv-focus")!.classList.contains("solo")).toBe(false);
  });

  it("a project with one session says 1 session (round 5)", async () => {
    await render({ recent: [], projects: [{ name: "billing", sessions: 1 }, { name: "infra", sessions: 2 }], now: NOW });
    const proj = target.querySelector('[data-testid="first-view-projects"]')!;
    expect([...proj.querySelectorAll(".fv-prow")].map(parts)).toEqual([["billing", "1", "session"], ["infra", "2", "sessions"]]);
  });

  it("with no named projects the list stands alone and no projects heading shows", async () => {
    await render({ recent: RECENT, projects: [{ name: "", sessions: 5 }], now: NOW });
    expect(target.querySelector('[data-testid="first-view-projects"]')).toBeNull();
    expect(target.textContent).not.toContain("Most active projects");
    expect(target.querySelector(".fv-focus")!.classList.contains("solo")).toBe(true);
  });

  it("with nothing to show the card has no rows and no stray text", async () => {
    await render({ recent: [], projects: [], now: NOW });
    expect(target.querySelectorAll('[data-testid="first-view-recent-row"]')).toHaveLength(0);
    expect(text(target)).toBe("");
  });

  it("a thread with an unreadable time shows no age rather than NaN", async () => {
    await render({ recent: [{ title: "Odd", project: null, harness: null, tool: null, at: "not a date" }], projects: [], now: NOW });
    expect(parts(target.querySelector('[data-testid="first-view-recent-row"]')!)).toEqual(["Odd"]);
    expect(target.textContent).not.toMatch(/NaN|undefined|null/);
  });
});
