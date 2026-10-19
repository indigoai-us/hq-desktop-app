// @vitest-environment happy-dom
/**
 * US-019: the welcome edition draws its components from brief.json
 * `welcome` (brief-welcome-contract.ts). Nothing renders above the brief,
 * the welcome actions live in IF YOU DO ONE THING, the watch list and the
 * timeline, an absent field hides its component, and no empty-state line or
 * raw text reaches the page. The fixtures are Core's real welcome_block
 * output (hq-core-staging PR 1432).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import WelcomeRunsHarness from "./WelcomeReportRunsHarness.test-support.svelte";
import type { BriefSweepSource } from "./brief-data.js";
import core from "./fixtures/core-1432-welcome.json";
import { WELCOME_OPENABLE_HARNESSES } from "../chat/first-run/continue-in-tool.js";

const RUN = "brief-20261018-090000";
const CATCH_UP = "Catch me up on what I worked on recently and suggest what to do next.";
const index = JSON.stringify({
  run_id: RUN,
  created_at: "2026-10-18T16:00:00Z",
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

const brief = (welcome: unknown, extra: Record<string, unknown> = {}) => ({ items: { decisions: [] }, welcome, ...extra });

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
const button = (action: string) =>
  [...target.querySelectorAll<HTMLButtonElement>('[data-testid="welcome-edition-action"]')].find((b) => b.dataset.action === action) ?? null;
const watchTitles = () => [...(card("watch")?.querySelectorAll('[data-testid="welcome-edition-row"] h4') ?? [])].map((h) => h.textContent);
const sections = () =>
  [...target.querySelectorAll<HTMLElement>('[data-testid="welcome-edition-section"]')].map((el) => ({
    name: el.querySelector("h3")?.textContent?.trim(),
    lines: [...el.querySelectorAll("p")].flatMap((p) => p.innerHTML.replace(/<!---->/g, "").split("<br>").map((l) => l.trim())),
  }));
/** Every testid before the edition in document order, outside it. */
const beforeEdition = () => {
  const edition = id("welcome-edition")!;
  return [...target.querySelectorAll<HTMLElement>("[data-testid]")]
    .filter((el) => !el.contains(edition) && el.compareDocumentPosition(edition) & Node.DOCUMENT_POSITION_FOLLOWING)
    .map((el) => el.dataset.testid);
};

/** A host that can open Claude Code and Codex, like the desktop app. */
const host = (harnesses: string[] = ["claude-code", "codex"], result: string | null = null) => ({
  harnesses,
  open: vi.fn(async () => result),
});

async function renderWelcome(
  json: Record<string, unknown>,
  {
    report = {},
    page = {},
    companies = [],
    files: extra = {},
  }: { report?: Record<string, unknown>; page?: Record<string, unknown>; companies?: { uid: string; slug?: string; label: string }[]; files?: Record<string, string> } = {},
): Promise<void> {
  const files: Record<string, string> = {
    "workspace/brief/index.jsonl": index,
    [`workspace/brief/${RUN}/brief-data.json`]: "{}",
    [`workspace/brief/${RUN}/brief.json`]: JSON.stringify(json),
    ...extra,
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

function reset(): void {
  if (app) unmount(app);
  app = null;
  target?.remove();
}

afterEach(() => {
  reset();
  localStorage.clear();
});

describe("welcome edition components (US-019)", () => {
  it("renders Core's welcome inside the brief, with nothing above it", async () => {
    const onmeet = vi.fn();
    const onopen = vi.fn();
    await renderWelcome(brief(core.showcase_personal), {
      report: {
        madeBy: { name: "Atlas", onmeet },
        openTool: { label: "Open Claude Code", detail: "Claude Code is set up with HQ. Open it to keep working there.", busy: false, error: null, onopen },
        openHarness: host(),
      },
    });

    // Nothing above the brief: no plain welcome block, no made-by line, no connect card, no open-tool bar.
    expect(id("brief-welcome")).toBeNull();
    expect(id("welcome-report-made-by")).toBeNull();
    expect(id("brief-open-tool")).toBeNull();
    expect(id("connect-ai-apps-card")).toBeNull();
    expect(beforeEdition()).toEqual([]);
    expect(target.querySelectorAll('[data-testid="daily-brief"]')).toHaveLength(1);

    // The headline is the brief's own; the subtitle says what HQ knows.
    expect(id("welcome-edition-greeting")?.textContent).toBe("HQ found 196 past sessions across 38 projects on this Mac, most of them in Claude Code.");
    expect(flat(q('[data-testid="welcome-edition"] .hero .sub'))).toBe("What HQ knows about your work so far, and one place to start.");

    // IF YOU DO ONE THING: Core's primary action, with its reason.
    const lead = card("one-thing")!;
    expect(lead.querySelector(".pill")?.textContent).toBe("If you do one thing");
    expect(flat(lead.querySelector(".kicker"))).toBe("If you do one thing Your past work");
    expect(lead.querySelector("h3")?.textContent).toBe("196 past sessions on this Mac can add your plans, skills and history to HQ.");
    expect(flat(lead.querySelector('[data-testid="welcome-edition-action"]'))).toBe("Bring in your past work");

    // The watch list: the other four actions, in brief order, with Core's labels.
    expect(flat(card("watch")!.querySelector(".kicker"))).toBe("Watch · 4");
    expect(watchTitles()).toEqual(["Open HQ in Claude Code", "Connect your AI apps", "Create or join a company", "Look around your HQ"]);

    // The timeline: recent work, newest first, with project and harness.
    const timeline = card("timeline")!;
    expect(flat(timeline.querySelector(".kicker"))).toBe("Recent work");
    const rows = [...timeline.querySelectorAll('[data-testid="welcome-edition-row"]')];
    expect(rows.map((r) => r.querySelector("h4")?.textContent)).toEqual([
      "Fixed the coupon rounding at checkout",
      "Drafted the October field notes",
      "Moved the pricing table to the new layout",
      "Cleaned up the nightly backup script",
      "Added a shopping list to the recipe app",
    ]);
    expect(flat(rows[0]!.querySelector("p"))).toMatch(/^harbor-checkout · Claude Code · /);
    expect(flat(rows[2]!.querySelector("p"))).toMatch(/^pricing-site · Codex · /);

    // Projects, repos, the harness and the tree, as sections.
    expect(sections()).toEqual([
      { name: "Your projects", lines: ["harbor-checkout · 46 sessions", "field-notes · 31 sessions", "pricing-site · 24 sessions", "38 projects in all."] },
      { name: "Your repos", lines: ["harbor-checkout", "pricing-site", "ops-scripts"] },
      { name: "Where you work", lines: ["Claude Code · 180 sessions", "Codex · 16 sessions"] },
      { name: "Your HQ", lines: ["38 projects", "212 knowledge files"] },
    ]);
  });

  it("runs each welcome action through its own flow, and opens the harness the button names", async () => {
    const onopen = vi.fn();
    const onconnectcompany = vi.fn();
    const onlaunch = vi.fn(async () => null);
    const openHarness = host();
    await renderWelcome(brief(core.showcase_personal), {
      report: { openTool: { label: "Open Claude Code", detail: null, busy: false, error: null, onopen }, openHarness },
      page: { onconnectcompany, onlaunch },
    });

    // Connect your AI apps opens the 1670 connect flow inside the edition.
    expect(id("connect-ai-apps-card")).toBeNull();
    button("connect-ai-apps")!.click();
    await settle();
    const connect = id("connect-ai-apps-card");
    expect(connect).not.toBeNull();
    expect(id("welcome-edition")!.contains(connect)).toBe(true);

    // Open HQ in Claude Code opens Claude Code with Core's prompt, never the Continue tool or the brief's engine.
    button("open-hq-in-harness")!.click();
    await settle();
    expect(openHarness.open).toHaveBeenCalledWith("claude-code", CATCH_UP);
    expect(onopen).not.toHaveBeenCalled();
    expect(onlaunch).not.toHaveBeenCalled();

    button("connect-company")!.click();
    expect(onconnectcompany).toHaveBeenCalledTimes(1);

    button("import-history")!.click();
    await settle();
    expect(onlaunch).toHaveBeenCalledTimes(1);
    // The page's launch takes (engine, prompt); the prompt is Core's, sent as is.
    expect((onlaunch.mock.calls[0] as unknown[])[1]).toBe("/import-context");
    // Prompts are sent, never shown.
    expect(target.textContent).not.toContain("/import-context");
    expect(target.textContent).not.toContain(CATCH_UP);
  });

  it("opens Codex for a Codex-primary person, even when Claude Code was picked at Continue", async () => {
    const onopen = vi.fn();
    const onlaunch = vi.fn(async () => null);
    const openHarness = host();
    await renderWelcome(brief(core.codex_company), {
      report: { openTool: { label: "Open Claude Code", detail: null, busy: false, error: null, onopen }, openHarness },
      page: { onlaunch },
      companies: [{ uid: "co-north", slug: "northstar", label: "Northstar" }],
    });
    const lead = card("one-thing")!;
    expect(flat(lead.querySelector(".kicker"))).toBe("If you do one thing Codex");
    expect(flat(lead.querySelector('[data-testid="welcome-edition-action"]'))).toBe("Open HQ in Codex");
    button("open-hq-in-harness")!.click();
    await settle();
    expect(openHarness.open).toHaveBeenCalledTimes(1);
    expect(openHarness.open).toHaveBeenCalledWith("codex", CATCH_UP);
    expect(onopen).not.toHaveBeenCalled();
    expect(onlaunch).not.toHaveBeenCalled();
    expect(watchTitles()).toEqual(["Connect your AI apps", "Connect GitHub", "Look around your HQ"]);
  });

  it("gives a Cursor-primary person an open path: the desktop app opens HQ in Cursor", async () => {
    const onopen = vi.fn();
    const openHarness = host([...WELCOME_OPENABLE_HARNESSES]);
    await renderWelcome(brief(core.cursor_person), {
      report: { openTool: { label: "Open Claude Code", detail: null, busy: false, error: null, onopen }, openHarness },
    });
    expect(watchTitles()).toContain("Open HQ in Cursor");
    button("open-hq-in-harness")!.click();
    await settle();
    expect(openHarness.open).toHaveBeenCalledWith("cursor", CATCH_UP);
    expect(onopen).not.toHaveBeenCalled();
    expect(id("brief-open-tool")).toBeNull();
    expect(sections().find((s) => s.name === "Where you work")).toEqual({ name: "Where you work", lines: ["Cursor · 14 sessions", "Claude Code · 4 sessions"] });
  });

  it("keeps the report's open bar and drops the dead row when the host cannot open the named harness", async () => {
    const onopen = vi.fn();
    const claudeOnly = host();
    await renderWelcome(brief(core.cursor_person), {
      report: { openTool: { label: "Open Claude Code", detail: null, busy: false, error: null, onopen }, openHarness: claudeOnly },
      page: { onlaunch: vi.fn(async () => null) },
    });
    // No row that names an action the person cannot take.
    expect(watchTitles()).not.toContain("Open HQ in Cursor");
    expect(button("open-hq-in-harness")).toBeNull();
    // The person still has a way to open a tool: the report's own bar, after the brief.
    const bar = id("brief-open-tool");
    expect(bar).not.toBeNull();
    expect(beforeEdition()).not.toContain("brief-open-tool");
    expect(claudeOnly.open).not.toHaveBeenCalled();
  });

  it("never shows a lead card without an action", async () => {
    for (const json of [core.cursor_person, core.codex_company, core.claude_person, core.showcase_personal, core.showcase_company]) {
      for (const harnesses of [[...WELCOME_OPENABLE_HARNESSES], ["claude-code"]]) {
        await renderWelcome(brief(json), { report: { openHarness: host(harnesses) }, page: { onlaunch: vi.fn(async () => null) } });
        for (const lead of target.querySelectorAll<HTMLElement>('[data-testid="welcome-edition-card"].lead')) {
          expect(lead.querySelector('[data-testid="welcome-edition-action"], [data-testid="welcome-edition-note"]')).not.toBeNull();
        }
        reset();
      }
    }
  });

  it("shows the plain line when the harness could not open", async () => {
    await renderWelcome(brief(core.codex_company), { report: { openHarness: host(undefined, "Codex could not open.") } });
    button("open-hq-in-harness")!.click();
    await settle();
    expect(id("welcome-edition-error")?.textContent).toBe("Codex could not open.");
    expect(button("open-hq-in-harness")?.disabled).toBe(false);
  });

  it("drops an action whose label is raw text", async () => {
    await renderWelcome(
      brief({
        first_run: true,
        actions: [
          { id: "raw", kind: "open_tree", label: "run `hq sync`", reason: "Look around.", launch_prompt: "tour", primary: true },
          { id: "tree", kind: "open_tree", label: "Look around your HQ", reason: "2 projects so far.", launch_prompt: "tour", primary: false },
        ],
      }),
    );
    expect(target.textContent).not.toContain("hq sync");
    expect(flat(card("one-thing")!.querySelector('[data-testid="welcome-edition-action"]'))).toBe("Look around your HQ");
    expect(card("watch")).toBeNull();
  });

  it("puts nothing above the brief when a company is left out or failed", async () => {
    const companies = [
      { uid: "co-north", slug: "northstar", label: "Northstar" },
      { uid: "co-field", slug: "fieldwork", label: "Fieldwork" },
    ];
    await renderWelcome(
      brief(core.showcase_company, {
        not_included: [{ company: "co-field", reason: "locked" }],
        companies: { "co-north": { error: "timeout", label: "Northstar" } },
      }),
      { companies },
    );
    expect(id("brief-exclusions")).toBeNull();
    expect(id("brief-company-failures")).toBeNull();
    expect(target.textContent).not.toContain("is not included");
    expect(target.textContent).not.toContain("could not be included");
    expect(beforeEdition()).toEqual([]);
  });

  it("never shows the open-tool bar while the welcome brief loads", async () => {
    const inserted: string[] = [];
    const watch = new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n instanceof HTMLElement) {
            if (n.dataset.testid === "brief-open-tool") inserted.push("brief-open-tool");
            if (n.querySelector('[data-testid="brief-open-tool"]')) inserted.push("brief-open-tool");
          }
    });
    watch.observe(document.body, { childList: true, subtree: true });
    try {
      await renderWelcome(brief(core.showcase_personal), {
        report: { openTool: { label: "Open Claude Code", detail: null, busy: false, error: null, onopen: vi.fn() }, openHarness: host() },
      });
    } finally {
      watch.disconnect();
    }
    expect(inserted).toEqual([]);
    expect(id("brief-open-tool")).toBeNull();
  });

  it("gives a connect action a button even when the report has no connect inputs", async () => {
    const onlaunch = vi.fn(async () => null);
    await renderWelcome(
      brief({
        first_run: true,
        actions: [
          {
            id: "connect-ai-apps",
            kind: "connect_ai_apps",
            label: "Connect your AI apps",
            reason: "Connect Claude Code, Codex or Cursor so HQ can start learning how you work.",
            launch_prompt: "Help me connect Claude Code, Codex and Cursor to HQ.",
            primary: true,
          },
        ],
      }),
      { report: { aiApps: null }, page: { onlaunch } },
    );
    const b = button("connect-ai-apps");
    expect(b?.textContent?.trim()).toBe("Connect your AI apps");
    b!.click();
    await settle();
    expect(onlaunch).toHaveBeenCalledTimes(1);
    expect((onlaunch.mock.calls[0] as unknown[])[1]).toBe("Help me connect Claude Code, Codex and Cursor to HQ.");
  });

  it("renders the 16.0.30 shape without an empty-state line", async () => {
    // A host that can open Claude Code, like the desktop app; without one the open row is dropped.
    await renderWelcome(brief(LEGACY), { report: { openHarness: host() }, page: { onconnectcompany: vi.fn() } });
    const text = flat(target);
    expect(text).not.toMatch(/nothing owed/i);
    expect(text).not.toMatch(/no sessions/i);
    expect(text).not.toMatch(/nothing needs a call from you today/i);
    expect(text).not.toMatch(/nothing needs you right now/i);
    expect(text).not.toMatch(/nothing new for you today/i);
    expect(id("brief-welcome")).toBeNull();

    // next_steps become the actions with Core's labels, the session counts become the harness.
    expect(card("one-thing")?.querySelector("h3")?.textContent).toBe("Share your projects with your team.");
    expect(flat(card("one-thing")?.querySelector('[data-testid="welcome-edition-action"]'))).toBe("Create or join a company");
    expect(watchTitles()).toEqual(["Bring in your past work", "Open HQ in Claude Code"]);
    expect(flat(card("timeline")?.querySelector("h3"))).toBe("31 sessions over 6 days");
    expect(sections()).toEqual([{ name: "Where you work", lines: ["Claude Code · 29 sessions", "Codex · 2 sessions"] }]);
  });

  it("hides the component of every absent field, with no placeholder", async () => {
    await renderWelcome(
      brief({
        first_run: true,
        actions: [{ id: "connect-ai-apps", kind: "connect_ai_apps", label: "Connect your AI apps", reason: "", launch_prompt: "", primary: true }],
        tree: { companies: 0, projects: 0, knowledge_files: 0 },
      }),
    );
    expect([...target.querySelectorAll<HTMLElement>('[data-testid="welcome-edition-card"]')].map((c) => c.dataset.card)).toEqual(["one-thing"]);
    // No reason: no heading, and the button still reads the label.
    expect(card("one-thing")?.querySelector("h3")).toBeNull();
    expect(flat(card("one-thing")?.querySelector('[data-testid="welcome-edition-action"]'))).toBe("Connect your AI apps");
    expect(sections()).toEqual([]);
    reset();

    await renderWelcome(brief({ recent_work: [{ title: "Fixed the coupon rounding at checkout", project: null, at: "2026-10-07T21:10:00Z", harness: null }] }));
    expect([...target.querySelectorAll<HTMLElement>('[data-testid="welcome-edition-card"]')].map((c) => c.dataset.card)).toEqual(["timeline"]);
    expect(flat(card("timeline")!.querySelector('[data-testid="welcome-edition-row"] p'))).not.toMatch(/·\s*·|^·/);
    expect(sections()).toEqual([]);
    expect(id("welcome-edition-greeting")?.textContent).toMatch(/^Good (morning|afternoon|evening)\.$/);
  });

  it("never renders raw text: paths, tracebacks, error codes or prompts", async () => {
    await renderWelcome(
      brief({
        first_run: true,
        note: "Traceback (most recent call last): KeyError 'token' after gh auth status",
        headline: "/Users/sam/hq/companies/indigo/projects",
        actions: [
          { id: "a1", kind: "import_history", label: "Bring in your past work", reason: "skill_not_found: import-claude", launch_prompt: "RAW PROMPT TEXT", primary: true },
        ],
        recent_work: [
          { title: "packages/ui/src/brief/DailyBrief.svelte", project: "Harbor", at: "2026-10-07T21:10:00Z", harness: "claude-code" },
          { title: "Fixed the coupon rounding", project: "/Users/sam/code/harbor", at: "2026-10-07T20:10:00Z", harness: "claude_code" },
        ],
        top_projects: [{ name: "Harbor", path: "/Users/sam/code/harbor", sessions: 3, last_active_at: null, harness: null }],
      }),
    );
    const text = target.textContent ?? "";
    for (const raw of ["Traceback", "KeyError", "gh auth", "skill_not_found", "RAW PROMPT TEXT", "/Users/", "DailyBrief.svelte", "packages/ui", "claude_code"]) {
      expect(text).not.toContain(raw);
    }
    expect(id("welcome-edition-run")?.textContent).toBe("Some of your welcome details could not be loaded this time.");
    expect(id("welcome-edition-greeting")?.textContent).toMatch(/^Good (morning|afternoon|evening)\.$/);
    // The reason failed the filter: no heading, the button keeps the label.
    expect(card("one-thing")?.querySelector("h3")).toBeNull();
    expect(flat(card("one-thing")?.querySelector('[data-testid="welcome-edition-action"]'))).toBe("Bring in your past work");
    const rows = [...card("timeline")!.querySelectorAll('[data-testid="welcome-edition-row"]')];
    expect(rows.map((r) => r.querySelector("h4")?.textContent)).toEqual(["Fixed the coupon rounding"]);
    expect(flat(rows[0]!.querySelector("p"))).toMatch(/^Claude Code · /);
  });
});
