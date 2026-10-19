import { describe, expect, it } from "vitest";
import { parseWelcomeFields, type WelcomeBriefFields } from "./brief-welcome-contract.js";
import { plainWelcomeText, welcomeEdition, welcomeName } from "./brief-welcome-edition.js";
import { welcomeRiseBriefInput } from "./welcome-rise-run.js";

/** Real single-line names and titles the welcome edition must show (owner ask: show that we know about them). */
const SHOWN = ["EOD: ship X", "ETL: backfill", "HTTP 404 page redesign", "sk-learn-notes", "MONKEY: business", "usage: docs"];

// Built at run time so no secret-shaped literal sits in the source.
const v = "A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6S7t8U9v0";
const jwt = `ey${"J"}hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${v}`;

/** Text the welcome filter hides: multi-line, stack traces, home paths and high-confidence credential tokens. */
const HIDDEN = [
  "Fix the login page\nand the signup page",
  "Ship it\r\nnow",
  "Traceback (most recent call last):",
  'File "/app/main.py", line 12, in run',
  "at Object.<anonymous> (index.js:10:5)",
  "TypeError: undefined is not a function",
  "Session in /Users/sam/code/harbor",
  "/home/sam/notes",
  "Notes on /Volumes/Data/hq",
  "file:///tmp/report",
  "~/code/harbor-checkout",
  `Rotate gh${"p"}_${v}`,
  `gh${"o"}_${v}`,
  `github${"_pat"}_11AB${v}`,
  `s${"k"}-${v}`,
  `s${"k"}-proj-${v}`,
  `xox${"b"}-1234-5678-${v}`,
  `AKI${"A"}${"Z".repeat(16)}`,
  jwt,
  `Authorization: Bearer ${v}`,
];

describe("welcomeName (US-019 round 5)", () => {
  it("shows real single-line names and titles that the brief's plainLine would hide", () => {
    for (const name of SHOWN) {
      expect(welcomeName(name), name).toBe(name);
      // The activity filter still hides them; the welcome edition no longer runs names through it.
      expect(plainWelcomeText(name), name).toBeNull();
    }
  });

  it("keeps ordinary names and short relative paths", () => {
    for (const name of ["Harbor checkout", "my_project", "src/brief", "Read the sk-learn notes", "Bearer of good news", "API KEY rotation plan"]) {
      expect(welcomeName(name), name).toBe(name);
    }
  });

  it("hides multi-line text, stack traces, home paths and credential tokens", () => {
    for (const raw of [...HIDDEN, "", "   ", null, undefined]) expect(welcomeName(raw), String(raw)).toBeNull();
  });

  it("hides a name longer than the limit", () => {
    expect(welcomeName("x".repeat(141))).toBeNull();
    expect(welcomeName("x".repeat(140))).toBe("x".repeat(140));
  });
});

function fieldsFor(names: string[]): Record<string, unknown> {
  return {
    headline: names[0],
    top_projects: names.map((name, i) => ({ name, sessions: 0, path: `~/code/p${i}` })),
    top_repos: names.map((name) => ({ name })),
    recent_work: names.map((title, i) => ({ title, project: names[i], at: "2026-10-18T12:00:00Z" })),
    actions: names.map((label, i) => ({ id: `a${i}`, kind: "open_tree", label, primary: i === 0 })),
  };
}

function editionText(fields: WelcomeBriefFields) {
  const e = welcomeEdition(welcomeRiseBriefInput(), {}, new Map(), { fields });
  const lead = e.cards.find((c) => c.id === "one-thing");
  const watch = e.cards.find((c) => c.id === "watch")?.rows ?? [];
  const work = e.cards.find((c) => c.id === "timeline")?.rows ?? [];
  const section = (name: string) => e.sections.find((s) => s.name === name)?.lines ?? [];
  return {
    headline: e.headline,
    labels: [lead?.label, ...watch.map((r) => r.title)].filter(Boolean),
    work: work.map((r) => r.title),
    workProjects: work.map((r) => r.detail),
    projects: section("Your projects"),
    repos: section("Your repos"),
  };
}

describe("welcome edition names and titles (US-019 round 5)", () => {
  // Raw brief.json through the parser, and fields handed straight to the edition.
  const inputs: [string, (names: string[]) => WelcomeBriefFields][] = [
    ["brief.json", (names) => parseWelcomeFields(fieldsFor(names))],
    ["parsed fields", (names) => fieldsFor(names) as unknown as WelcomeBriefFields],
  ];

  for (const [kind, build] of inputs) {
    it(`shows each real title in the headline, projects, repos, recent work and action labels (${kind})`, () => {
      for (const name of SHOWN) {
        const t = editionText(build([name]));
        expect(t.headline, name).toBe(name);
        expect(t.labels, name).toEqual([name]);
        expect(t.work, name).toEqual([name]);
        expect(t.workProjects[0], name).toContain(name);
        expect(t.projects, name).toEqual([name]);
        expect(t.repos, name).toEqual([name]);
      }
    });

    it(`hides raw text in every name and title field, and keeps the real ones beside it (${kind})`, () => {
      for (const raw of HIDDEN) {
        const t = editionText(build([raw, "Harbor checkout"]));
        expect(t.headline, raw).not.toBe(raw);
        expect(t.labels, raw).toEqual(["Harbor checkout"]);
        expect(t.work, raw).toEqual(["Harbor checkout"]);
        expect(t.projects, raw).toEqual(["Harbor checkout"]);
        expect(t.repos, raw).toEqual(["Harbor checkout"]);
        expect(JSON.stringify(t), raw).not.toContain(raw.replace(/\s+/g, " ").trim());
      }
    });
  }
});
