// @vitest-environment happy-dom
/**
 * The first view inside the welcome report: DailyBrief draws Core's
 * brief.json `welcome` (brief-welcome-contract.ts) into its own grid, in the
 * sunrise, connect, oneThing, focus and risk slots. Nothing renders above
 * the brief, Connect opens the existing settings, a harness found on this
 * Mac shows Open or Connected (never Connect), an absent field hides its
 * slot, and no empty-state line or raw text reaches the page. The fixtures
 * are Core's real welcome_block output (hq-core-staging PR 1432).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import WelcomeRunsHarness from "./WelcomeReportRunsHarness.test-support.svelte";
import type { BriefSweepSource } from "./brief-data.js";
import core from "./fixtures/core-1432-welcome.json";
import importFixture from "./fixtures/import-report-desktop.json";
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
const qa = (sel: string) => [...target.querySelectorAll<HTMLElement>(sel)];
const id = (testid: string) => q(`[data-testid="${testid}"]`);
/** A project row as read: name, count and unit, spaced. */
const prow = (el: Element) => [...el.children].map((c) => c.textContent?.trim()).join(" ");
const flat = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
/** The first view's slots, in grid order. */
const slots = () => qa('[data-testid="first-view-grid"] > [data-widget]').map((el) => el.dataset.widget);
const oneThing = () => id("first-view-one-thing");
const oneThingButton = () => oneThing()?.querySelector<HTMLButtonElement>("button.fv-btn") ?? null;
const whereOpen = () => q('[data-testid="first-view-where-open"]') as HTMLButtonElement | null;
const connectRow = (harness: string) => q(`[data-testid="first-view-connect-row"][data-harness="${harness}"]`);
const integrationRow = (slug: string) => q(`[data-testid="first-view-connect-row"][data-integration="${slug}"]`);
const rowButton = (row: HTMLElement | null) => row?.querySelector<HTMLButtonElement>("button") ?? null;
const watchLabels = () => qa('[data-testid="first-view-watch-row"] b').map((b) => b.textContent);
const whereRows = () => qa('[data-testid="first-view-where-row"]').map((r) => flat(r));
/** Every testid before the first view's greeting in document order, outside the brief. */
const beforeBrief = () => {
  const daily = id("daily-brief")!;
  return qa("[data-testid]")
    .filter((el) => !el.contains(daily) && el.compareDocumentPosition(daily) & Node.DOCUMENT_POSITION_FOLLOWING)
    .map((el) => el.dataset.testid);
};
const EMPTY_STATE = [/nothing owed/i, /no sessions/i, /nothing needs a call from you today/i, /nothing needs you right now/i, /nothing new for you today/i];

/** The launch scan the suggested integrations come from: GitHub Desktop, Linear and Slack on this Mac. */
const WORK_SCAN = {
  platform: "macos" as const,
  scannedAtMs: 1,
  apps: [
    { bundleId: "com.github.GitHubClient", name: "GitHub Desktop" },
    { bundleId: "com.linear", name: "Linear" },
    { bundleId: "com.tinyspeck.slackmacgap", name: "Slack" },
    { bundleId: "com.anthropic.claudefordesktop", name: "Claude" },
  ],
  mcpServers: [],
  sources: [],
  truncated: false,
};
/** The "Your apps" host the Settings integrations page and the connect section share. */
function appsHost(connections: { id: string; domain: string | null; provider: string }[] = []) {
  return {
    detect: vi.fn(async () => WORK_SCAN),
    load: vi.fn(async () => ({
      catalog: {
        "github.com": { entryId: "e-github", name: "GitHub", authClass: "oauth" },
        "linear.app": { entryId: "e-linear", name: "Linear", authClass: "oauth" },
        "slack.com": { entryId: "e-slack", name: "Slack", authClass: "oauth" },
      },
      connections,
      installations: {},
      canManage: true,
      problem: null,
    })),
    autoConnect: vi.fn(async () => ({ ok: false, reason: "", retry: false })),
    connect: vi.fn(() => new Promise(() => undefined)),
    setup: vi.fn(() => new Promise(() => undefined)),
    undo: vi.fn(async () => ({ ok: true, connectionId: null, installationId: null })),
  };
}
/** Core offers "Connect your AI apps" and nothing else: no session history for any harness. */
const CONNECT_AI_ONLY = {
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
};

/** A host that can open Claude Code and Codex, like the desktop app. */
const host = (harnesses: string[] = ["claude-code", "codex"], result: string | null = null) => ({
  harnesses,
  open: vi.fn(async (_h: string, _p: string) => result),
});

async function renderWelcome(
  json: Record<string, unknown>,
  {
    report = {},
    page = {},
    companies = [],
    files: extra = {},
    adapter = {},
  }: {
    report?: Record<string, unknown>;
    page?: Record<string, unknown>;
    companies?: { uid: string; slug?: string; label: string }[];
    files?: Record<string, string>;
    adapter?: Record<string, unknown>;
  } = {},
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
      adapter,
    },
  });
  await vi.waitFor(() => expect(id("first-view-grid")).not.toBeNull(), { timeout: 5_000 });
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

describe("the first view inside the welcome report", () => {
  it("renders Core's welcome in the brief's own grid, with nothing above it", async () => {
    const onmeet = vi.fn();
    const onopen = vi.fn();
    await renderWelcome(brief(core.showcase_personal), {
      report: {
        aiApps: { detect: async () => null, cli: { claudeCode: true, codex: false }, onopenaiapps: vi.fn() },
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
    expect(id("welcome-edition")).toBeNull();
    expect(beforeBrief()).toEqual([]);
    expect(qa('[data-testid="daily-brief"]')).toHaveLength(1);

    // The brief's own greeting, once, and the count line under it.
    expect(id("brief-greeting")?.textContent).toMatch(/^Good (morning|afternoon|evening)\.$/);
    expect(id("first-view-hint")?.textContent).toBe("Your first brief");
    expect(id("first-view-count-line")?.textContent).toMatch(/^196 sessions over \d+ days? in Claude Code and Codex\./);

    // The grid: the sunrise and Connect on top, One thing, your recent work and the watch list.
    expect(slots()).toEqual(["sunrise", "connect", "oneThing", "focus", "risk"]);

    // Where you work: one row per harness, and the primary harness's open.
    expect(whereRows()).toEqual(["Claude Code 180", "Codex 16"]);
    expect(whereOpen()?.textContent).toBe("Open HQ in Claude Code");

    // Connect: Claude Code was found and this host opens it; Cursor was not found.
    expect(connectRow("claude-code")?.dataset.found).toBe("true");
    expect(flat(rowButton(connectRow("claude-code")))).toBe("Open");
    expect(connectRow("cursor")?.dataset.found).toBe("false");
    expect(flat(rowButton(connectRow("cursor")))).toBe("Connect");

    // IF YOU DO ONE THING: the primary harness's open, with its own button.
    expect(oneThing()?.dataset.kind).toBe("open_harness");
    expect(id("first-view-one-thing-quote")?.textContent).toBe("Open HQ in Claude Code.");
    expect(flat(oneThingButton())).toBe("Open");

    // Your recent work: newest first, with project and harness, and the most active projects.
    const recent = qa('[data-testid="first-view-recent-row"]');
    expect(recent.map((r) => r.querySelector("b")?.textContent)).toEqual([
      "Fixed the coupon rounding at checkout",
      "Drafted the October field notes",
      "Moved the pricing table to the new layout",
      "Cleaned up the nightly backup script",
      "Added a shopping list to the recipe app",
    ]);
    expect(flat(recent[0]!.querySelector(".fv-rt > span"))).toBe("harbor-checkout · Claude Code");
    expect(flat(recent[2]!.querySelector(".fv-rt > span"))).toBe("pricing-site · Codex");
    expect(qa('[data-testid="first-view-projects"] .fv-prow').map(prow)).toEqual([
      "harbor-checkout 46 sessions",
      "field-notes 31 sessions",
      "pricing-site 24 sessions",
    ]);

    // The watch list: the actions left after the other cards, with Core's labels. "Create or join a
    // company" needs the host's company setup, which this render does not pass, so it is left out.
    expect(watchLabels()).toEqual(["Look around your HQ"]);

    // No empty-state line anywhere.
    for (const re of EMPTY_STATE) expect(flat(target)).not.toMatch(re);
  });

  it("runs each action through its own flow: Connect opens settings, Open opens the harness it names", async () => {
    const onopen = vi.fn();
    const onopenaiapps = vi.fn();
    const onopenintegrations = vi.fn();
    const onlaunch = vi.fn(async () => null);
    const openHarness = host();
    await renderWelcome(brief(core.showcase_company), {
      report: {
        aiApps: { detect: async () => null, cli: { claudeCode: true, codex: false }, onopenaiapps },
        connect: { host: { ...appsHost(), detect: async () => null }, company: { uid: "cmp_a", name: "A" }, onopenintegrations },
        openTool: { label: "Open Claude Code", detail: null, busy: false, error: null, onopen },
        openHarness,
      },
      page: { onlaunch },
      companies: [{ uid: "cmp_a", slug: "a", label: "A" }],
    });

    // AI-app Connect opens the AI-apps settings; nothing expands inside the brief.
    rowButton(connectRow("cursor"))!.click();
    await settle();
    expect(onopenaiapps).toHaveBeenCalledTimes(1);
    expect(id("connect-ai-apps-card")).toBeNull();

    // Integration Connect opens the company's Integrations page.
    const github = integrationRow("github");
    expect(flat(github?.querySelector("b"))).toBe("GitHub");
    rowButton(github)!.click();
    await settle();
    expect(onopenintegrations).toHaveBeenCalledWith("cmp_a");

    // The open opens the harness with Core's prompt, never the Continue tool or the brief's engine.
    const open = oneThing()?.dataset.kind === "open_harness" ? oneThingButton()! : whereOpen()!;
    open.click();
    await settle();
    expect(openHarness.open).toHaveBeenCalledTimes(1);
    expect(openHarness.open.mock.calls[0]![1]).toBe(CATCH_UP);
    expect(onopen).not.toHaveBeenCalled();
    expect(onlaunch).not.toHaveBeenCalled();

    // A found harness's Open opens it with no prompt.
    rowButton(connectRow("claude-code"))!.click();
    await settle();
    expect(openHarness.open).toHaveBeenLastCalledWith("claude-code", "");

    // Prompts are sent, never shown.
    expect(target.textContent).not.toContain(CATCH_UP);
  });

  it("sets up a company through the page's own flow", async () => {
    const onconnectcompany = vi.fn();
    await renderWelcome(brief(LEGACY), { report: { openHarness: host() }, page: { onconnectcompany } });
    expect(oneThing()?.dataset.kind).toBe("connect_company");
    expect(flat(oneThingButton())).toBe("Set up");
    oneThingButton()!.click();
    expect(onconnectcompany).toHaveBeenCalledTimes(1);
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
    expect(whereOpen()?.textContent).toBe("Open HQ in Codex");
    whereOpen()!.click();
    await settle();
    expect(openHarness.open).toHaveBeenCalledTimes(1);
    expect(openHarness.open).toHaveBeenCalledWith("codex", CATCH_UP);
    expect(onopen).not.toHaveBeenCalled();
    expect(onlaunch).not.toHaveBeenCalled();
    expect(id("brief-open-tool")).toBeNull();
  });

  it("gives a Cursor-primary person an open path: the desktop app opens HQ in Cursor", async () => {
    const onopen = vi.fn();
    const openHarness = host([...WELCOME_OPENABLE_HARNESSES]);
    await renderWelcome(brief(core.cursor_person), {
      report: { openTool: { label: "Open Claude Code", detail: null, busy: false, error: null, onopen }, openHarness },
    });
    expect(id("first-view-one-thing-quote")?.textContent).toBe("Open HQ in Cursor.");
    expect(whereOpen()?.textContent).toBe("Open HQ in Cursor");
    oneThingButton()!.click();
    await settle();
    expect(openHarness.open).toHaveBeenCalledWith("cursor", CATCH_UP);
    expect(onopen).not.toHaveBeenCalled();
    expect(id("brief-open-tool")).toBeNull();
    expect(id("first-view-count-line")?.textContent).toBe("18 sessions over 3 days in Cursor and Claude Code. Top threads: web-app, billing-api.");
    expect(whereRows()).toEqual(["Cursor 14", "Claude Code 4"]);
  });

  it("keeps the report's open bar and shows no dead open when the host cannot open the named harness", async () => {
    const onopen = vi.fn();
    const openHarness = host();
    await renderWelcome(brief(core.cursor_person), {
      report: {
        aiApps: { detect: async () => null, cli: { claudeCode: true, codex: false }, onopenaiapps: vi.fn() },
        openTool: { label: "Open Claude Code", detail: null, busy: false, error: null, onopen },
        openHarness,
      },
      page: { onlaunch: vi.fn(async () => null) },
    });
    // No button that names an action the person cannot take.
    expect(whereOpen()).toBeNull();
    expect(flat(target)).not.toContain("Open HQ in Cursor");
    // A found harness this host cannot open shows Connected; one it can open shows Open; never Connect.
    expect(connectRow("cursor")?.dataset.found).toBe("true");
    expect(rowButton(connectRow("cursor"))).toBeNull();
    expect(connectRow("cursor")?.querySelector('[data-testid="first-view-connected"]')?.textContent).toBe("Connected");
    expect(connectRow("claude-code")?.dataset.found).toBe("true");
    expect(flat(rowButton(connectRow("claude-code")))).toBe("Open");
    for (const row of qa('[data-testid="first-view-connect-row"][data-found="true"]')) expect(flat(rowButton(row))).not.toBe("Connect");
    // The person still has a way to open a tool: the report's own bar, after the brief.
    expect(id("brief-open-tool")).not.toBeNull();
    expect(beforeBrief()).not.toContain("brief-open-tool");
    expect(openHarness.open).not.toHaveBeenCalled();
  });

  it("never shows One thing without a way to start it", async () => {
    for (const json of [core.cursor_person, core.codex_company, core.claude_person, core.showcase_personal, core.showcase_company]) {
      for (const harnesses of [[...WELCOME_OPENABLE_HARNESSES], ["claude-code"]]) {
        await renderWelcome(brief(json), {
          report: { aiApps: { detect: async () => null, cli: { claudeCode: true, codex: false }, onopenaiapps: vi.fn() }, openHarness: host(harnesses) },
          page: { onlaunch: vi.fn(async () => null), onconnectcompany: vi.fn() },
        });
        const lead = oneThing();
        if (lead) expect(lead.querySelector('button.fv-btn, [data-testid="brief-launch"]')).not.toBeNull();
        reset();
      }
    }
  });

  it("shows the plain line when the harness could not open", async () => {
    await renderWelcome(brief(core.codex_company), { report: { openHarness: host(undefined, "Codex could not open.") } });
    whereOpen()!.click();
    await settle();
    // The host's own line, word for word, then Try again.
    const line = id("first-view-error")!;
    expect(line.firstChild?.textContent?.trim()).toBe("Codex could not open.");
    expect(flat(id("first-view-retry"))).toBe("Try again");
    expect(line.getAttribute("role")).toBe("alert");
    expect(whereOpen()?.disabled).toBe(false);
  });

  it("opens one session when the open is clicked twice while it is in flight", async () => {
    let finish: (v: string | null) => void = () => undefined;
    const openHarness = { harnesses: ["claude-code", "codex"], open: vi.fn(() => new Promise<string | null>((r) => (finish = r))) };
    await renderWelcome(brief(core.codex_company), { report: { openHarness } });
    whereOpen()!.click();
    whereOpen()!.click();
    await settle();
    expect(openHarness.open).toHaveBeenCalledTimes(1);
    expect(whereOpen()?.disabled).toBe(true);
    finish(null);
    await settle();
    expect(whereOpen()?.disabled).toBe(false);
    whereOpen()!.click();
    await settle();
    expect(openHarness.open).toHaveBeenCalledTimes(2);
  });

  it("drops an action whose label is raw text", async () => {
    await renderWelcome(
      brief({
        first_run: true,
        actions: [
          { id: "raw", kind: "open_tree", label: "Open ~/hq and run hq sync", reason: "Look around.", launch_prompt: "tour", primary: true },
          { id: "tree", kind: "open_tree", label: "Look around your HQ", reason: "2 projects so far.", launch_prompt: "tour", primary: false },
        ],
      }),
      { page: { onlaunch: vi.fn(async () => null) } },
    );
    expect(target.textContent).not.toContain("hq sync");
    expect(id("first-view-one-thing-quote")?.textContent).toBe("Look around your HQ.");
    expect(id("first-view-watch")).toBeNull();
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
    expect(beforeBrief()).toEqual([]);
  });

  it("never shows the open-tool bar while the first view loads", async () => {
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

  it("shows no Connect for AI apps when the report has no way to connect them", async () => {
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
    // Without the AI-apps settings the action cannot run, so it is not offered: no dead button, no prompt shown.
    expect(qa("button").map((b) => flat(b))).not.toContain("Connect");
    expect(oneThing()).toBeNull();
    expect(target.textContent).not.toContain("Help me connect Claude Code, Codex and Cursor to HQ.");
    expect(onlaunch).not.toHaveBeenCalled();
  });

  it("renders the 16.0.30 shape without an empty-state line", async () => {
    await renderWelcome(brief(LEGACY), { report: { openHarness: host() }, page: { onconnectcompany: vi.fn() } });
    const text = flat(target);
    for (const re of EMPTY_STATE) expect(text).not.toMatch(re);
    expect(id("brief-welcome")).toBeNull();

    // next_steps become the actions with Core's labels, the session counts become where you work.
    expect(id("first-view-one-thing-quote")?.textContent).toBe("Create or join a company.");
    expect(flat(oneThing()?.querySelector(".because"))).toBe("Share your projects with your team.");
    expect(id("first-view-count-line")?.textContent).toBe("31 sessions over 6 days in Claude Code and Codex.");
    expect(whereRows()).toEqual(["Claude Code 29", "Codex 2"]);
    expect(whereOpen()?.textContent).toBe("Open HQ in Claude Code");
    expect(id("first-view-connect-empty")).not.toBeNull();
    expect(slots()).toEqual(["sunrise", "connect", "oneThing"]);
  });

  it("counts the sessions from the import report on disk, not Core's HQ-only count", async () => {
    // Core 16.0.30 counts only the sessions tied to HQ: one.
    const welcome = { ...LEGACY, sessions: { total: 1, claude: 1, codex: 0, days_seen: 1 } };
    // The report the desktop wrote at workspace/imports/<stamp>/report.json, read through the host.
    const latest = vi.fn(async () => ({ ok: true, value: importFixture.report }));
    await renderWelcome(brief(welcome), {
      report: { openHarness: host(), aiApps: { detect: async () => null, cli: { claudeCode: true, codex: true } } },
      page: { onconnectcompany: vi.fn() },
      adapter: { importReport: { latest } },
    });
    expect(latest).toHaveBeenCalled();
    expect(id("first-view-count-line")?.textContent).toBe("402 sessions over 37 days in Claude Code and Codex. Top threads: hq, hq-desktop-app, billing-api.");
    // The import is done, so the first view never offers to bring in past work.
    expect(flat(target)).not.toMatch(/bring in your past work/i);
  });

  // Rows go GitHub, Linear, Slack (frame 1), whatever order the suggestion source gives.
  it("lists GitHub, Linear and Slack from the suggested-integrations source, with no Core connect actions", async () => {
    const apps = appsHost();
    const onopenintegrations = vi.fn();
    await renderWelcome(brief(LEGACY), {
      report: {
        aiApps: { detect: apps.detect, cli: { claudeCode: true, codex: false } },
        connect: { host: apps, company: { uid: "cmp_acme", name: "Acme" }, onopenintegrations },
        openHarness: host(),
      },
      page: { onconnectcompany: vi.fn() },
    });
    await vi.waitFor(() => expect(integrationRow("slack.com")).not.toBeNull());
    expect(LEGACY.next_steps.some((a) => a.kind === "connect_integration")).toBe(false);
    expect(qa('[data-testid="first-view-connect-row"][data-integration]').map((r) => r.dataset.integration)).toEqual(["github.com", "linear.app", "slack.com"]);
    for (const [slug, name] of [["github.com", "GitHub"], ["linear.app", "Linear"], ["slack.com", "Slack"]] as const) {
      expect(flat(integrationRow(slug)?.querySelector("b"))).toBe(name);
      expect(rowButton(integrationRow(slug))?.getAttribute("aria-label")).toBe(`Connect ${name}`);
    }
    // The AI apps the scan found (Claude) are not integrations.
    expect(integrationRow("claude.ai")).toBeNull();
    rowButton(integrationRow("github.com"))!.click();
    await settle();
    expect(onopenintegrations).toHaveBeenCalledWith("cmp_acme");
  });

  it("leaves out a suggested integration the company already connected", async () => {
    const apps = appsHost([{ id: "conn_slack", domain: null, provider: "slack" }]);
    await renderWelcome(brief(LEGACY), {
      report: {
        aiApps: { detect: apps.detect, cli: { claudeCode: true, codex: false } },
        connect: { host: apps, company: { uid: "cmp_acme", name: "Acme" }, onopenintegrations: vi.fn() },
      },
      page: { onconnectcompany: vi.fn() },
    });
    await vi.waitFor(() => expect(integrationRow("linear.app")).not.toBeNull());
    expect(apps.load).toHaveBeenCalled();
    expect(integrationRow("github.com")).not.toBeNull();
    expect(integrationRow("slack.com")).toBeNull();
  });

  it("shows an AI app connected in Settings as Connected, never Connect, with no sessions", async () => {
    await renderWelcome(brief(CONNECT_AI_ONLY), {
      report: {
        aiApps: { detect: async () => null, cli: { claudeCode: false, codex: false }, anywhereOnId: "codex", onopenaiapps: vi.fn() },
        openHarness: host(),
      },
    });
    const codex = connectRow("codex");
    expect(codex?.dataset.connected).toBe("true");
    expect(codex?.querySelector('[data-testid="first-view-connected"]')?.textContent).toBe("Connected");
    expect(rowButton(codex)).toBeNull();
    expect(flat(codex)).not.toMatch(/not connected/i);
    // "Connected" shows once: the chip, with no "Connected to HQ" note beside it (round 4 m2).
    expect(flat(codex)).toBe("C Codex Connected");
    expect(flat(codex).match(/connected/gi)).toHaveLength(1);
    // The others are not connected and have no history: Connect, named per row.
    expect(rowButton(connectRow("cursor"))?.getAttribute("aria-label")).toBe("Connect Cursor");
    expect(rowButton(connectRow("claude-code"))?.getAttribute("aria-label")).toBe("Connect Claude Code");
  });

  it("counts a harness whose CLI is installed as found, with no history: Open, never Connect", async () => {
    const openHarness = host();
    await renderWelcome(brief(CONNECT_AI_ONLY), {
      report: { aiApps: { detect: async () => null, cli: { claudeCode: true, codex: false }, onopenaiapps: vi.fn() }, openHarness },
    });
    const claude = connectRow("claude-code");
    expect(claude?.dataset.found).toBe("true");
    expect(flat(rowButton(claude))).toBe("Open");
    expect(rowButton(claude)?.getAttribute("aria-label")).toBe("Open Claude Code");
    expect(connectRow("codex")?.dataset.found).toBe("false");
    rowButton(claude)!.click();
    await settle();
    expect(openHarness.open).toHaveBeenCalledWith("claude-code", "");
  });

  it("shows a plain line with Try again when the open throws", async () => {
    const openHarness = { harnesses: ["claude-code", "codex"], open: vi.fn(async (_harness: string, _cwd: string): Promise<null> => { throw new Error("spawn ENOENT /usr/local/bin/codex"); }) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await renderWelcome(brief(core.codex_company), { report: { openHarness } });
    whereOpen()!.click();
    await settle();
    const line = id("first-view-error");
    expect(line?.getAttribute("role")).toBe("alert");
    expect(flat(line)).toBe("Codex could not open. Open your HQ folder in Codex to keep going. Try again");
    expect(flat(line)).not.toMatch(/ENOENT|spawn|usr/);
    expect(whereOpen()?.disabled).toBe(false);
    openHarness.open.mockResolvedValueOnce(null);
    id("first-view-retry")!.click();
    await settle();
    expect(openHarness.open).toHaveBeenCalledTimes(2);
    expect(openHarness.open.mock.calls[1]![0]).toBe("codex");
    expect(id("first-view-error")).toBeNull();
    warn.mockRestore();
  });

  it("hides the slot of every absent field, with no placeholder", async () => {
    await renderWelcome(
      brief({
        first_run: true,
        actions: [{ id: "connect-ai-apps", kind: "connect_ai_apps", label: "Connect your AI apps", reason: "", launch_prompt: "", primary: true }],
        tree: { companies: 0, projects: 0, knowledge_files: 0 },
      }),
      { report: { aiApps: { detect: async () => null, cli: { claudeCode: true, codex: false }, onopenaiapps: vi.fn() } } },
    );
    expect(slots()).toEqual(["sunrise", "connect", "oneThing"]);
    // No reason: no line under the quote, and the button still runs the action.
    expect(id("first-view-one-thing-quote")?.textContent).toBe("Connect your AI apps.");
    expect(oneThing()?.querySelector(".because")).toBeNull();
    expect(flat(oneThingButton())).toBe("Connect");
    // No history anywhere; the Claude Code CLI is installed, so only it is found.
    expect(qa('[data-testid="first-view-connect-row"]').map((r) => r.dataset.found)).toEqual(["true", "false", "false"]);
    expect(id("first-view-count-line")).toBeNull();
    expect(id("brief-next")).toBeNull();
    reset();

    await renderWelcome(brief({ recent_work: [{ title: "Fixed the coupon rounding at checkout", project: null, at: "2026-10-07T21:10:00Z", harness: null }] }));
    expect(slots()).toEqual(["sunrise", "connect", "focus"]);
    const rows = qa('[data-testid="first-view-recent-row"]');
    expect(rows.map((r) => r.querySelector("b")?.textContent)).toEqual(["Fixed the coupon rounding at checkout"]);
    expect(flat(rows[0]!.querySelector(".fv-rt > span"))).not.toMatch(/·/);
    expect(id("first-view-projects")).toBeNull();
    expect(id("brief-greeting")?.textContent).toMatch(/^Good (morning|afternoon|evening)\.$/);
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
          { title: "/Users/sam/hq/packages/ui/src/brief/DailyBrief.svelte", project: "Harbor", at: "2026-10-07T21:10:00Z", harness: "claude-code" },
          { title: "Fixed the coupon rounding", project: "/Users/sam/code/harbor", at: "2026-10-07T20:10:00Z", harness: "claude_code" },
        ],
        top_projects: [{ name: "Harbor", path: "/Users/sam/code/harbor", sessions: 3, last_active_at: null, harness: null }],
      }),
      { page: { onlaunch: vi.fn(async () => null) } },
    );
    const text = target.textContent ?? "";
    for (const raw of ["Traceback", "KeyError", "gh auth", "skill_not_found", "RAW PROMPT TEXT", "/Users/", "DailyBrief.svelte", "packages/ui", "claude_code"]) {
      expect(text).not.toContain(raw);
    }
    expect(id("brief-greeting")?.textContent).toMatch(/^Good (morning|afternoon|evening)\.$/);
    // The reason failed the filter: no line under the quote, and the prompt starts from the brief's launch.
    expect(id("first-view-one-thing-quote")?.textContent).toBe("Bring in your past work.");
    expect(oneThing()?.querySelector(".because")).toBeNull();
    expect(oneThing()?.querySelector('[data-testid="brief-launch"]')).not.toBeNull();
    const rows = qa('[data-testid="first-view-recent-row"]');
    expect(rows.map((r) => r.querySelector("b")?.textContent)).toEqual(["Fixed the coupon rounding"]);
    expect(flat(rows[0]!.querySelector(".fv-rt > span"))).toBe("Claude Code");
    expect(qa('[data-testid="first-view-projects"] .fv-prow').map(prow)).toEqual(["Harbor 3 sessions"]);
  });

  it("shows the full catalogue in review mode (Shift+A), and the first view again after it", async () => {
    await renderWelcome(brief(core.showcase_personal), { report: { openHarness: host() } });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true }));
    flushSync();
    await settle();
    expect(id("brief-review")).not.toBeNull();
    expect(id("first-view-grid")).toBeNull();
    expect(id("first-view-hint")).toBeNull();
    expect(qa('[data-testid="brief-review-group"]').length).toBeGreaterThan(0);
    // The catalogue's cards, none of them a first-view slot.
    expect(qa("[data-widget]").length).toBeGreaterThan(0);
    expect(qa(".fv-slot")).toHaveLength(0);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true }));
    flushSync();
    await settle();
    expect(id("brief-review")).toBeNull();
    expect(id("first-view-grid")).not.toBeNull();
  });
});
