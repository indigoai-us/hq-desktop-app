import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Lists never silently truncate. Console-rail pages and panes may not cap a
 * list with a fixed `.slice(0, N)` unless the same file renders a way to see
 * the rest (ShowMoreRow / pageRows, or an existing Show more control). Sites
 * that slice for another reason are listed below with that reason.
 */
const ROOT = join(__dirname, "..");
const SCANNED_DIRS = [
  "company",
  "personal",
  "outpost",
  "telemetry",
  "meetings",
  "atlas",
  "projects",
  "library",
  "inbox",
];
const SCANNED_FILES = [
  "shell/CompanySidepane.svelte",
  "shell/MoreCompaniesPopover.svelte",
  "shell/more-companies.ts",
  "shell/palette-rows.ts",
  "shell/sidepane-models.ts",
];

/** file → reason the fixed slice is not a hidden list cap. */
const ALLOWED: Record<string, string> = {
  "company/team-telemetry.ts": "top-5 skills ranking per member, labelled as top skills",
  "meetings/meetings-rail-model.ts": "Past rows end in the Earlier › row that opens the full history",
  "meetings/meeting-details.ts": "agenda and attendee caps on one meeting's detail card",
  "meetings/meetings-view-model.ts": "agenda windows; the full list opens from Meetings",
  "meetings/meeting-link.ts": "upcoming-meeting chip shows the next few only",
  "atlas/atlas-build.ts":
    "map node budget: the 80 most recent loose files per continent and 16 PRD knowledge links are a recency-ranked node budget for the map, not a paged list",
  "projects/board-faces.ts": "avatar stack with a +N overflow face",
  "projects/new-project.ts": "slug length",
  "library/library-overlay-model.ts": "slug length",
  "company/brain/brain-model.ts": "slug length",
  "shell/more-companies.ts": "recent-company shortcuts; Show all companies lists the rest",
  "shell/palette-rows.ts": "id preview string length",
  "telemetry/telemetry-me.ts":
    "By-model rows past the cap fold into the Other row, whose note names every hidden model",
};

// Caps of 1–3 are initials, avatar stacks, and label chips; 4+ or a named
// constant is a list cap.
const CAP = /\.slice\(\s*0\s*,\s*([4-9]|\d{2,}|[A-Z][A-Z0-9_]*)\s*\)/g;
const AFFORDANCE = /ShowMoreRow|pageRows|progressiveWindow|Show \{?[^<]*more|Load more|Show all/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(svelte|ts)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path);
  }
}

function sources(): string[] {
  const files: string[] = [];
  for (const dir of SCANNED_DIRS) walk(join(ROOT, dir), files);
  for (const file of SCANNED_FILES) files.push(join(ROOT, file));
  return files;
}

describe("console-rail lists never silently truncate", () => {
  it("has no fixed list cap without a show-more affordance", () => {
    const offenders: string[] = [];
    for (const path of sources()) {
      const rel = relative(ROOT, path);
      if (ALLOWED[rel]) continue;
      const text = readFileSync(path, "utf8");
      const caps = [...text.matchAll(CAP)].map((m) => m[0]);
      if (caps.length > 0 && !AFFORDANCE.test(text)) offenders.push(`${rel}: ${caps.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("pages company, Brain, personal, and Telemetry session lists with ShowMoreRow", () => {
    for (const rel of [
      "company/files-connect/FilesConnectPage.svelte",
      "company/brain/BrainPage.svelte",
      "personal/PersonalRailPage.svelte",
    ]) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      expect(text, rel).toContain("ShowMoreRow");
      expect(text, rel).toContain("pageRows(");
      expect(text, rel).not.toMatch(CAP);
    }
    // OWNER-R27: Telemetry's sessions are paged by the native list command,
    // so Show more asks for the next offset instead of slicing in memory.
    const telemetry = readFileSync(join(ROOT, "telemetry/TelemetryView.svelte"), "utf8");
    expect(telemetry).toContain("ShowMoreRow");
    expect(telemetry).toContain("offset: shown");
    expect(telemetry).not.toMatch(CAP);
  });

  it("keeps every allowlisted file in the scan", () => {
    const scanned = new Set(sources().map((p) => relative(ROOT, p)));
    for (const rel of Object.keys(ALLOWED)) expect(scanned.has(rel), rel).toBe(true);
  });
});
