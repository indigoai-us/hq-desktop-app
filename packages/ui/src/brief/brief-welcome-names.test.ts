import { describe, expect, it } from "vitest";
import { parseWelcomeFields, type WelcomeBriefFields } from "./brief-welcome-contract.js";
import { plainWelcomeText, welcomeEdition, welcomeName } from "./brief-welcome-edition.js";
import { welcomeRiseBriefInput } from "./welcome-rise-run.js";

/** Real single-line names and titles the welcome edition must show (owner ask: show that we know about them). */
const SHOWN = [
  "EOD: ship X",
  "ETL: backfill",
  "HTTP 404 page redesign",
  "sk-learn-notes",
  "MONKEY: business",
  "usage: docs",
];
/** Round 6: plain words that name a secret but carry no value; round 7: titles with a slash or a dot. plainLine shows these too. */
const SHOWN_WORDS = ["Token budget review", "API key rotation plan", "Q3/Q4 plan", "Node.js upgrade"];

// Built at run time so no secret-shaped literal sits in the source.
const v = "A1b2C3d4E5f6G7h8J9k0L1m2N3p4Q5r6S7t8U9v0";
const jwt = `ey${"J"}hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${v}`;
// An Anthropic-format key body whose short first segment holds "_" and "-" (round 6, M2), and a bare 40-character
// AWS secret-key shape that mixes upper, lower, digits and "/".
const antBody = `a_${v.slice(0, 6)}-x_${v}-${v}`;
const awsSecret = `${v.slice(0, 18)}/${v.slice(18, 38)}+`;

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
  // Round 6, M1: Windows home and user paths.
  "Session in C:\\Users\\sam\\code\\harbor",
  "C:/Users/sam/code/harbor",
  "Notes in d:\\users\\sam",
  "e:/Users/sam",
  "\\\\fileserver\\share\\sam",
  "Open \\\\nas\\home",
  "/mnt/c/Users/sam/code",
  "Notes on /mnt/D/Users/sam",
  // Round 6, M2: sk- keys with "_" or "-" early, and any sk-ant- or sk-proj- prefix.
  `s${"k"}-ant-api03-${antBody}`,
  `s${"k"}-${antBody}`,
  `s${"k"}-ant-short`,
  `s${"k"}-proj-short`,
  // Round 6 minors.
  `Bearer:${v}`,
  `Authorization: Bearer "${v}"`,
  `Authorization: Bearer '${v}'`,
  `tok${"en"}: ${v.slice(0, 16)}`,
  `pass${"word"}=${v.slice(0, 20)}`,
  `api_${"key"}: "${v}"`,
  `API-${"KEY"}=${v}`,
  `Sec${"ret"}: ${v.slice(0, 24)}`,
  `GITHUB_${"TOKEN"}=abc123`,
  `OPENAI_API_${"KEY"}=x`,
  `MY_${"SECRET"} = shh`,
  `https://sam:${"hunter2"}@example.com/repo`,
  `Clone https://x-access-token:${v}@github.com/o/r`,
  `ASI${"A"}${"Q".repeat(16)}`,
  `Rotate ${awsSecret}`,
  // Round 7, C1: home paths after another path segment, a relative "../", or Windows' Documents and Settings.
  "Fix build in /var/home/sam/projects/web-app",
  "Notes in /usr/home/sam/hq",
  "Open ../Users/sam/hq",
  "Copy D:\\Documents and Settings\\Sam\\hq",
  // A line or paragraph separator also makes the text multi-line (round 6, m4).
  "Fix the login page\u2028and the signup page",
  "Ship it\u2029now",
  "Ship it\u0085now",
];

describe("welcomeName (US-019 round 5)", () => {
  it("shows real single-line names and titles that the brief's plainLine would hide", () => {
    for (const name of SHOWN) {
      expect(welcomeName(name), name).toBe(name);
      // The activity filter still hides them; the welcome edition no longer runs names through it.
      expect(plainWelcomeText(name), name).toBeNull();
    }
    for (const name of SHOWN_WORDS) expect(welcomeName(name), name).toBe(name);
  });

  it("keeps ordinary names and short relative paths", () => {
    for (const name of [
      "Harbor checkout",
      "my_project",
      "src/brief",
      "Read the sk-learn notes",
      `s${"k"}-learn-notes-for-the-q4-planning-meeting`,
      "Bearer of good news",
      "API KEY rotation plan",
      "Password reset flow",
      "Token: budget review",
      "Secret santa list",
      "C: drive cleanup",
      "Users guide",
      "/mnt/data backup",
      "MONKEY_KEY rotation",
      `${"a".repeat(40)} notes`,
      "AWS rotation 2026",
    ]) {
      expect(welcomeName(name), name).toBe(name);
    }
  });

  it("hides multi-line text, stack traces, home paths and credential tokens", () => {
    for (const raw of [...HIDDEN, "", "   ", null, undefined]) expect.soft(welcomeName(raw), String(raw)).toBeNull();
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
      for (const name of [...SHOWN, ...SHOWN_WORDS]) {
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
