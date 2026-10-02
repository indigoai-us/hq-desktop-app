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
  "BoardCard.svelte",
  "StoryKanban.svelte",
  "ProjectListView.svelte",
  "ProjectRow.svelte",
  "ProjectsHome.svelte",
  "ProjectDetailView.svelte",
  "StoryDetailPanel.svelte",
  "ProjectFilesBody.svelte",
  "ProjectFilesHost.svelte",
  "NewProjectSheet.svelte",
  "CompanyGoalsPage.svelte",
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
      // 9px/10px only survive inside avatar initials, never as text sizes.
      const bad = sizes.filter((s) => !["13px", "20px", "9px", "10px"].includes(s.replace(/\s*!important/, "")));
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
