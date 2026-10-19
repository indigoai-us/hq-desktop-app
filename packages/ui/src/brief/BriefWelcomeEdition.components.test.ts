// @vitest-environment happy-dom
/**
 * US-019: the welcome edition draws its components from brief.json
 * `welcome` (brief-welcome-contract.ts). Nothing renders above the brief,
 * the four welcome actions live in IF YOU DO ONE THING, the watch list and
 * the timeline, an absent field hides its component, and no empty-state
 * line or raw text reaches the page.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import WelcomeRunsHarness from "./WelcomeReportRunsHarness.test-support.svelte";
import type { BriefSweepSource } from "./brief-data.js";
import seeded from "./fixtures/welcome-38-projects.json";

const RUN = "brief-20261008-090000";
const index = JSON.stringify({
  run_id: RUN,
  created_at: "2026-10-08T16:00:00Z",
  state: "ready",
  catch_up: false,
  lead: "decisions",
  counts: { decisions: 0, shipped: 0, incidents: 0 },
  headline: "Your first brief",
});

/** The 16.0.30 skill's welcome: no contract keys. */
const LEGACY = {
  first_run: true,
  import: { conversations: 0, skills: 0 },
  sessions: { total: 31, claude: 29, codex: 2, days_seen: 6 },
  repos: [],
  apps: [],
  next_steps: [
    { id: "connect-company", kind: "connect_company", reason: "Share your projects with your team." },
    { id: "import", kind: "import", reason: "Bring your past sessions into HQ." },
  ],
  getting_started: "Start or join a company when you have work to share.",
};

let app: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    await tick();
  }
  flushSync();
}

const q = (sel: string) => target.querySelector<HTMLElement>(sel);
const id = (testid: string) => q(`[data-testid="${testid}"]`);
const card = (name: string) => q(`[data-testid="welcome-edition-card"][data-card="${name}"]`);
const flat = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const sections = () =>
  [...target.querySelectorAll<HTMLElement>('[data-testid="welcome-edition-section"]')].map((el) => ({
    name: el.querySelector("h3")?.textContent?.trim(),
    lines: [...el.querySelectorAll("p")].flatMap((p) => p.innerHTML.replace(/<!---->/g, "").split("<br>").map((l) => l.trim())),
  }));

async function renderWelcome(
  brief: Record<string, unknown>,
  { report = {}, page = {}, companies = [] }: { report?: Record<string, unknown>; page?: Record<string, unknown>; companies?: { uid: string; slug?: string; label: string }[] } = {},
): Promise<void> {
  const files: Record<string, string> = {
    "workspace/brief/index.jsonl": index,
    [`workspace/brief/${RUN}/brief-data.json`]: "{}",
    [`workspace/brief/${RUN}/brief.json`]: JSON.stringify(brief),
  };
  const source: BriefSweepSource = { readHqFile: async (p) => files[p] ?? null };
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(WelcomeRunsHarness, {
    target,
    props: {
      source,
      companies,
      report: { aiApps: { detect: async () => null, cli: { claudeCode: true, codex: false } }, ...report },
      page,
    },
  });
  await vi.waitFor(() => expect(id("welcome-edition")).not.toBeNull(), { timeout: 5_000 });
  await settle();
}

afterEach(() => {
  if (app) unmount(app);
  app = null;
  target?.remove();
  localStorage.clear();
});

describe("welcome edition components (US-019)", () => {
  it("renders the seeded welcome inside the brief, with nothing above it", async () => {
    const onmeet = vi.fn();
    const onopen = vi.fn();
    await renderWelcome(seeded, {
      report: {
        madeBy: { name: "Atlas", onmeet },
        openTool: { label: "Open Claude Code", detail: "Claude Code is set up with HQ. Open it to keep working there.", busy: false, error: null, onopen },
      },
    });
    const edition = id("welcome-edition")!;

    // Nothing above the brief: no plain welcome block, no made-by line, no connect card, no open-tool bar.
    expect(id("brief-welcome")).toBeNull();
    expect(id("welcome-report-made-by")).toBeNull();
    expect(id("brief-open-tool")).toBeNull();
    expect(id("connect-ai-apps-card")).toBeNull();
    const before = [...target.querySelectorAll<HTMLElement>("[data-testid]")].filter(
      (el) => !el.contains(edition) && el.compareDocumentPosition(edition) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(before.map((el) => el.dataset.testid)).toEqual([]);
    expect(target.querySelectorAll('[data-testid="daily-brief"]')).toHaveLength(1);

    // The headline is the brief's own.
    expect(id("welcome-edition-greeting")?.textContent).toBe("38 projects, most of them in Claude Code.");

    // IF YOU DO ONE THING: the primary action.
    const lead = card("one-thing")!;
    expect(lead.querySelector(".pill")?.textContent).toBe("If you do one thing");
    expect(lead.querySelector("h3")?.textContent).toBe("Your brief gets richer with your Claude and ChatGPT work in it.");
    expect(flat(lead.querySelector('[data-testid="welcome-edition-action"]'))).toBe("Connect your AI apps");

    // The watch list: the other three actions, in brief order.
    const watch = card("watch")!;
    expect(flat(watch.querySelector(".kicker"))).toBe("Watch · 3");
    expect([...watch.querySelectorAll('[data-testid="welcome-edition-row"] h4')].map((h) => h.textContent)).toEqual([
      "Open HQ in Claude Code",
      "Start or join a company",
      "Import your past work",
    ]);

    // The timeline: recent work, newest first, with project and harness.
    const timeline = card("timeline")!;
    expect(flat(timeline.querySelector(".kicker"))).toBe("Recent work");
    const rows = [...timeline.querySelectorAll('[data-testid="welcome-edition-row"]')];
    expect(rows.map((r) => r.querySelector("h4")?.textContent)).toEqual([
      "Fixed the coupon rounding at checkout",
      "Drafted the October field notes",
      "Moved the pricing table to the new layout",
    ]);
    expect(flat(rows[0]!.querySelector("p"))).toMatch(/^Harbor checkout · Claude Code · /);
    expect(flat(rows[2]!.querySelector("p"))).toMatch(/^Pricing site · Codex · /);

    // Projects, repos, the harness and the tree, as sections.
    expect(sections()).toEqual([
      { name: "Your projects", lines: ["Harbor checkout · 46 sessions", "Field notes · 31 sessions", "Pricing site · 24 sessions", "38 projects in all."] },
      { name: "Your repos", lines: ["harbor-checkout", "field-notes", "pricing-site"] },
      { name: "Claude Code", lines: ["198 sessions", "Codex · 16 sessions"] },
      { name: "Your HQ", lines: ["38 projects", "212 knowledge files"] },
    ]);
  });

  it("runs each welcome action through its own flow", async () => {
    const onopen = vi.fn();
    const onconnectcompany = vi.fn();
    const onlaunch = vi.fn(async () => null);
    await renderWelcome(seeded, {
      report: { openTool: { label: "Open Claude Code", detail: null, busy: false, error: null, onopen } },
      page: { onconnectcompany, onlaunch },
    });
    const button = (row: string) =>
      [...target.querySelectorAll<HTMLButtonElement>('[data-testid="welcome-edition-action"]')].find((b) => b.dataset.action === row)!;

    // Connect your AI apps opens the 1670 connect flow inside the edition.
    expect(id("connect-ai-apps-card")).toBeNull();
    button("connect-ai-apps").click();
    await settle();
    const connect = id("connect-ai-apps-card");
    expect(connect).not.toBeNull();
    expect(id("welcome-edition")!.contains(connect)).toBe(true);

    // Open HQ in Claude Code uses the report's prepared tool.
    button("open-hq-in-harness").click();
    expect(onopen).toHaveBeenCalledTimes(1);
    expect(onlaunch).not.toHaveBeenCalled();

    button("connect-company").click();
    expect(onconnectcompany).toHaveBeenCalledTimes(1);

    button("import-history").click();
    await settle();
    expect(onlaunch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onlaunch.mock.calls[0])).toContain("Import my past Claude Code and Codex sessions into HQ.");
    // The prompt is sent, never shown.
    expect(target.textContent).not.toContain("Import my past Claude Code and Codex sessions into HQ.");
  });

  it("renders the 16.0.30 shape without an empty-state line", async () => {
    await renderWelcome({ items: { decisions: [] }, welcome: LEGACY }, { page: { onconnectcompany: vi.fn() } });
    const text = flat(target);
    expect(text).not.toMatch(/nothing owed/i);
    expect(text).not.toMatch(/no sessions/i);
    expect(text).not.toMatch(/nothing needs a call from you today/i);
    expect(text).not.toMatch(/nothing needs you right now/i);
    expect(text).not.toMatch(/nothing new for you today/i);
    expect(id("brief-welcome")).toBeNull();

    // next_steps become the actions, the session counts become the harness.
    expect(card("one-thing")?.querySelector("h3")?.textContent).toBe("Share your projects with your team.");
    expect(flat(card("one-thing")?.querySelector('[data-testid="welcome-edition-action"]'))).toBe("Start or join a company");
    expect([...card("watch")!.querySelectorAll('[data-testid="welcome-edition-row"] h4')].map((h) => h.textContent)).toEqual([
      "Import your past work",
      "Open HQ in Claude Code",
    ]);
    expect(flat(card("timeline")?.querySelector("h3"))).toBe("31 sessions over 6 days");
    expect(sections()).toEqual([{ name: "Claude Code", lines: ["29 sessions", "Codex · 2 sessions"] }]);
  });

  it("hides the component of every absent field, with no placeholder", async () => {
    await renderWelcome({
      items: { decisions: [] },
      welcome: {
        first_run: true,
        actions: [{ id: "connect-ai-apps", kind: "connect_ai_apps", label: "Connect your AI apps", reason: "", launch_prompt: "", primary: true }],
      },
    });
    expect([...target.querySelectorAll<HTMLElement>('[data-testid="welcome-edition-card"]')].map((c) => c.dataset.card)).toEqual(["one-thing"]);
    // No reason: the label is the title, and the button still reads the label.
    expect(card("one-thing")?.querySelector("h3")?.textContent).toBe("Connect your AI apps");
    expect(sections()).toEqual([]);
    unmount(app!);
    app = null;
    target.remove();

    await renderWelcome({
      items: { decisions: [] },
      welcome: { recent_work: [{ title: "Fixed the coupon rounding at checkout", project: null, at: "2026-10-07T21:10:00Z", harness: null }] },
    });
    expect([...target.querySelectorAll<HTMLElement>('[data-testid="welcome-edition-card"]')].map((c) => c.dataset.card)).toEqual(["timeline"]);
    expect(flat(card("timeline")!.querySelector('[data-testid="welcome-edition-row"] p'))).not.toMatch(/·\s*·|^·/);
    expect(sections()).toEqual([]);
    expect(id("welcome-edition-greeting")?.textContent).toMatch(/^Good (morning|afternoon|evening)\.$/);
  });

  it("never renders raw text: paths, tracebacks, error codes or prompts", async () => {
    await renderWelcome({
      items: { decisions: [] },
      welcome: {
        first_run: true,
        note: "Traceback (most recent call last): KeyError 'token' after gh auth status",
        headline: "/Users/sam/hq/companies/indigo/projects",
        actions: [
          { id: "a1", kind: "import_history", label: "Import your past work", reason: "skill_not_found: import-claude", launch_prompt: "RAW PROMPT TEXT", primary: true },
        ],
        recent_work: [
          { title: "packages/ui/src/brief/DailyBrief.svelte", project: "Harbor", at: "2026-10-07T21:10:00Z", harness: "claude-code" },
          { title: "Fixed the coupon rounding", project: "/Users/sam/code/harbor", at: "2026-10-07T20:10:00Z", harness: "claude-code" },
        ],
        top_projects: [{ name: "Harbor", path: "/Users/sam/code/harbor", sessions: 3, last_active_at: null, harness: null }],
      },
    });
    const text = target.textContent ?? "";
    for (const raw of ["Traceback", "KeyError", "gh auth", "skill_not_found", "RAW PROMPT TEXT", "/Users/", "DailyBrief.svelte", "packages/ui"]) {
      expect(text).not.toContain(raw);
    }
    expect(id("welcome-edition-run")?.textContent).toBe("Some of your welcome details could not be loaded this time.");
    expect(id("welcome-edition-greeting")?.textContent).toMatch(/^Good (morning|afternoon|evening)\.$/);
    expect(card("one-thing")?.querySelector("h3")?.textContent).toBe("Import your past work");
    expect([...card("timeline")!.querySelectorAll('[data-testid="welcome-edition-row"] h4')].map((h) => h.textContent)).toEqual(["Fixed the coupon rounding"]);
  });
});
