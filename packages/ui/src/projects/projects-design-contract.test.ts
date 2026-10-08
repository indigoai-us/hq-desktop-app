import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { filesErrorReason } from "./project-files.js";

// Projects pages follow the Messages type scale: 20px for the one page or
// task title, 13px everywhere else, weight capped at 500, no tracked caps.
const here = dirname(fileURLToPath(import.meta.url));
const FILES = [
  "CompanyProjectsPage.svelte",
  "StoryKanban.svelte",
  "ProjectRow.svelte",
  "ProjectRepoChips.svelte",
  "ProjectsHome.svelte",
  "ProjectDetailView.svelte",
  "StoryDetailPanel.svelte",
  "ProjectFilesBody.svelte",
  "ProjectFilesHost.svelte",
  "NewProjectSheet.svelte",
  "CompanyGoalsPage.svelte",
  "TaskViewPane.svelte",
  "BoardFaces.svelte",
  "TaskViewDoor.svelte",
  "StoryCard.svelte",
  "StoryList.svelte",
  "../home/StoryPanel.svelte",
];

function styleOf(file: string): string {
  const src = readFileSync(join(here, file), "utf8");
  const start = src.indexOf("<style");
  return start < 0 ? "" : src.slice(start);
}

describe("projects pages follow the Messages type scale", () => {
  for (const file of FILES) {
    it(`${file}: text is 13px or a 20px title, weight <= 500, no caps`, () => {
      const css = styleOf(file);
      const sizes = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1].trim());
      // 8px/9px/10px only survive inside avatar initials, never as text sizes.
      // OWNER-008: the board task card sets every non-title text at 11px.
      // OWNER-007: labelled buttons (the status trigger) use a 12px label.
      const allowed = [
        "13px", "20px", "8px", "9px", "10px",
        ...(file === "StoryCard.svelte" ? ["11px"] : []),
        ...(file === "ProjectDetailView.svelte" ? ["12px"] : []),
      ];
      const bad = sizes.filter((s) => !allowed.includes(s.replace(/\s*!important/, "")));
      expect(bad).toEqual([]);
      expect(css).not.toMatch(/font-weight:\s*(600|650|700|bold)/);
      expect(css).not.toMatch(/text-transform:\s*uppercase/);
      expect(css).not.toMatch(/backdrop-filter:\s*var\(/);
    });
  }

  it("no 24px or 22px bold titles anywhere in the projects pages", () => {
    for (const file of FILES) {
      expect(styleOf(file)).not.toMatch(/font-size:\s*(2[1-9]|[3-9]\d)px/);
    }
  });
});

describe("board task card (OWNER-008)", () => {
  const css = styleOf("StoryCard.svelte");
  const rule = (sel: string) => css.match(new RegExp(`\\n  ${sel.replace(/[.]/g, "\\.")} \\{[^}]*\\}`))?.[0] ?? "";

  it("card is 12px padded, 8px radius, panel border, no accent edge", () => {
    const card = rule(".story-card");
    expect(card).toContain("padding: 12px;");
    expect(card).toContain("border-radius: 8px;");
    expect(card).toContain("border: 1px solid var(--panel-border");
    expect(css).not.toMatch(/border-left/);
    expect(readFileSync(join(here, "StoryCard.svelte"), "utf8")).toContain("data-board-card");
  });

  it("title clamps to two lines; id, pills, chips, assignee and count are 11px", () => {
    expect(rule(".story-title")).toContain("-webkit-line-clamp: 2;");
    for (const sel of [".story-id", ".label-overflow", ".assignee-name", ".ac-count"]) {
      expect(rule(sel)).toContain("font-size: 11px;");
    }
    expect(css).toMatch(/\.priority-badge \{[^}]*border-radius: 999px;[^}]*font-size: 11px;/);
    expect(css).toMatch(/:global\(\.label-chip\) \{[^}]*padding: 2px 6px;[^}]*border-radius: 999px;[^}]*font-size: 11px;/);
    expect(rule(".progress-track")).toContain("height: 3px;");
  });
});

describe("project detail", () => {
  const src = readFileSync(join(here, "ProjectDetailView.svelte"), "utf8");

  it("Activity and Files do not keep the Overview stats strip", () => {
    expect(src).toContain(
      '{#if hasPrd && kpi.total > 0 && (tab === "overview" || tab === "tasks")}',
    );
  });

  it("progress bar is neutral, not a green accent", () => {
    const fill = styleOf("ProjectDetailView.svelte").match(/\.kpi-bar-fill \{[^}]*\}/)?.[0] ?? "";
    expect(fill).not.toContain("--v4-ok");
  });

  it("task rail rows are Messages row height with a background-only selection", () => {
    const css = styleOf("ProjectDetailView.svelte");
    const row = css.match(/\.task-rail-row \{[^}]*\}/)?.[0] ?? "";
    expect(row).toContain("height: 31px;");
    const sel = css.match(/\.task-rail-row\.is-selected \{[^}]*\}/)?.[0] ?? "";
    expect(sel).toContain("box-shadow: none;");
    expect(sel).toContain("background: var(--v4-active-row);");
  });
});

describe("task pane", () => {
  const css = styleOf("../home/StoryPanel.svelte");

  it("priority is plain neutral text, never red", () => {
    const p1 = css.match(/\.priority\[data-priority="P1"\] \{[^}]*\}/)?.[0] ?? "";
    expect(p1).not.toContain("--v4-error");
  });

  it("To do / Done is a content-width segmented control", () => {
    const control = css.match(/\.status-control \{[^}]*\}/)?.[0] ?? "";
    expect(control).toContain("display: inline-flex;");
    expect(control).not.toContain("1fr 1fr");
  });
});

describe("filesErrorReason (QA-007)", () => {
  it("names a plain reason and never echoes transport text", () => {
    expect(filesErrorReason(new Error("HTTP 403 Forbidden: Caller lacks read permission"))).toBe(
      "You don't have access to this folder in the vault.",
    );
    expect(filesErrorReason(new Error("404 Not Found"))).toMatch(/isn't in the vault yet/);
    expect(filesErrorReason(new Error("401 token expired"))).toMatch(/sign-in expired/);
    expect(filesErrorReason(new Error("fetch failed: ECONNRESET"))).toMatch(/Couldn't reach the vault/);
    const fallback = filesErrorReason(new Error('{"code":"X_9"}'));
    expect(fallback).not.toContain("X_9");
  });
});

describe("project board at narrow widths (QA-029)", () => {
  const css = styleOf("CompanyProjectsPage.svelte");

  it("sizes columns from the board's own width, not the page", () => {
    const main = css.match(/\.projects-main \{[^}]*\}/)?.[0] ?? "";
    expect(main).toContain("container: projects-board / inline-size;");
    expect(css).toContain("@container projects-board (max-width: 620px)");
    expect(css).toContain("@container projects-board (max-width: 320px)");
  });

  it("never scrolls the board sideways or pins columns to a minimum width", () => {
    expect(css).not.toMatch(/repeat\(4, minmax\(\d+px/);
    const boards = [...css.matchAll(/\.kanban-board \{[^}]*\}/g)].map((m) => m[0]).join("\n");
    expect(boards).not.toContain("overflow-x: auto");
  });
});
