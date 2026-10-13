// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import Harness from "./BriefHealthHarness.test-support.svelte";
import DailyBrief from "./DailyBrief.svelte";
import { octoberEleven } from "./brief-catalogue-fixtures.js";
import { generateBrief } from "./brief-generate.js";
import { LIST_CAP, capList, mainHealthLabel, mainHealthPeek, mainHealthSummary, moreWatchesPeek, riskPeek, watchTitle } from "./brief-peeks.js";
import type { BriefMainHealth, BriefOrigin, BriefRisk } from "./brief-types.js";

const NOW = "2026-10-11T14:54:00.000Z";
const INDIGO = "cmp_indigo";
const COMPANIES = [{ uid: INDIGO, slug: "indigo", label: "Indigo", iconUrl: null }];
const origin = (repo: string, product?: string): BriefOrigin => ({ companyUid: INDIGO, repo, ...(product ? { product } : {}) });
const SLUG = /\b[\w.-]+\/[\w.-]+\b/;
const PR_NUMBER = /#\d+/;

function watch(id: string, title: string, extra: Partial<BriefRisk> = {}): BriefRisk {
  return { id, title, summary: `${title}.`, severity: "watch", links: [], origin: origin("indigoai-us/hq-core", "HQ core"), ...extra };
}

/** Seven watch rows: the Oct 11 four, plus a red main, a PR-shaped title and a sample. */
function seven(): BriefRisk[] {
  return [
    watch("w1", "Staging can merge green and still break main", { summary: "Required checks can pass while a non-required check is red on main." }),
    watch("w2", "Three open changes of yours have sat for a day", { origin: origin("indigoai-us/hq-desktop-app") }),
    watch("w3", "The docs build warns on every run", { origin: origin("indigoai-us/indigo-docs", "Docs") }),
    watch("w4", "Sync retries climbed overnight", { origin: origin("indigoai-us/hq-cloud") }),
    watch("w5", "hq-desktop-app main CI is red", {
      origin: origin("indigoai-us/hq-desktop-app"),
      ci: { repo: "hq-desktop-app", workflow: "CI", job: null, since: null, ageHours: 3, note: null },
    }),
    watch("w6", "indigoai-us/hq-cli #77: fix(cli): retry the gate", { origin: origin("indigoai-us/hq-cli") }),
    watch("w7", "The trial page has no analytics yet", { sample: true, origin: origin("indigoai-us/indigo-marketing") }),
  ];
}

const HEALTH: BriefMainHealth[] = [
  { repo: "hq-core-staging", product: null, companyUid: INDIGO, workflows: 4, red: [] },
  { repo: "hq-desktop-app", product: null, companyUid: INDIGO, workflows: 3, red: [{ workflow: "CI", since: null, mergesOnTop: 2 }] },
  { repo: "hq-pro", product: null, companyUid: INDIGO, workflows: 2, red: [] },
  { repo: "hq-cloud", product: null, companyUid: INDIGO, workflows: 5, red: [] },
  { repo: "hq-pro-agents", product: "Fleet", companyUid: INDIGO, workflows: 2, red: [] },
  { repo: "hq-cli", product: null, companyUid: INDIGO, workflows: 1, red: [] },
  { repo: "hq-deploy", product: null, companyUid: INDIGO, workflows: 1, red: [] },
];

describe("watch helpers", () => {
  it("titles are plain: a red main names its product; slugs, PR numbers and prefixes go", () => {
    const rows = seven();
    expect(watchTitle(rows[4]!)).toBe("Desktop app main is red");
    expect(watchTitle(rows[5]!)).toBe("Retry the gate");
    expect(watchTitle(rows[0]!)).toBe("Staging can merge green and still break main");
    for (const r of rows) {
      expect(watchTitle(r)).not.toMatch(SLUG);
      expect(watchTitle(r)).not.toMatch(PR_NUMBER);
    }
  });

  it("caps a list at five and hands back the rest", () => {
    expect(LIST_CAP).toBe(5);
    const { shown, rest } = capList(seven());
    expect(shown.map((r) => r.id)).toEqual(["w1", "w2", "w3", "w4", "w5"]);
    expect(rest.map((r) => r.id)).toEqual(["w6", "w7"]);
    expect(capList([1, 2])).toEqual({ shown: [1, 2], rest: [] });
  });

  it("summarizes main health as products green of total and labels the footer", () => {
    expect(mainHealthSummary(null)).toBeNull();
    expect(mainHealthSummary([])).toBeNull();
    const s = mainHealthSummary(HEALTH)!;
    expect([s.total, s.green]).toEqual([7, 6]);
    expect(s.red.map((r) => r.repo)).toEqual(["hq-desktop-app"]);
    expect(mainHealthLabel(s)).toBe("Main health · 6 of 7 products green");
    expect(mainHealthLabel(mainHealthSummary([HEALTH[2]!])!)).toBe("Main health · 1 of 1 product green");
  });

  it("the main-health peek lists products red first, by product name, GREEN or RED", () => {
    const p = mainHealthPeek(HEALTH);
    expect(p.title).toBe("Main health");
    expect(p.status).toBe("6 of 7 products green · Desktop app red");
    const lines = p.sections[0]!.lines!;
    expect(lines).toHaveLength(7);
    expect(lines[0]).toMatchObject({ label: "Desktop app · CI", state: "RED", tone: "red" });
    expect(lines.slice(1).every((l) => l.state === "GREEN" && l.tone === "ok")).toBe(true);
    expect(lines.map((l) => l.label)).not.toContainEqual(expect.stringMatching(/hq-/));
    expect(lines.slice(1).map((l) => l.label)).toEqual(["Fleet", "HQ Cloud", "HQ command line", "HQ core", "HQ Pro", "Sharing and deploys"]);
  });

  it("the watch peek says Watch, carries the product chip and the prompt; the more peek marks red mains", () => {
    const p = riskPeek(seven()[0]!, "Look into it.", NOW);
    expect(p.eyebrow).toBe("Watch");
    expect(p.origin).toEqual({ companyUid: INDIGO, label: "HQ core" });
    expect(p.status).toBe("Required checks can pass while a non-required check is red on main.");
    expect(p.prompt!.text).toBe("Look into it.");
    const more = moreWatchesPeek(seven().slice(4));
    expect(more.title).toBe("3 more");
    expect(more.sections[0]!.lines!.map((l) => [l.label, l.state])).toEqual([
      ["Desktop app main is red", "RED"],
      ["Retry the gate", ""],
      ["The trial page has no analytics yet", ""],
    ]);
  });
});

describe("Watch card", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;

  function render(props: Record<string, unknown>) {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(Harness, { target, props: { card: "risk", now: NOW, companies: COMPANIES, ...props } });
    flushSync();
  }
  const q = (id: string) => target.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const qa = (id: string) => [...target.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  async function hover(el: Element): Promise<void> {
    el.dispatchEvent(new MouseEvent("mouseenter"));
    await new Promise((r) => setTimeout(r, 260));
    flushSync();
  }

  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target?.remove();
  });

  it("renders every watch row up to five, then a +N more row whose peek lists the rest", async () => {
    render({ risks: seven(), rows: 1, cols: 1 });
    expect(q("brief-risk-eyebrow")!.textContent).toBe("Watch · 7 · 1 red on main");
    const rows = qa("brief-risk-row");
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.querySelector('[data-testid="brief-logo"]'))).toBe(true);
    expect(qa("brief-risk-title").map((t) => t.textContent)).toEqual([
      "Staging can merge green and still break main",
      "Three open changes of yours have sat for a day",
      "The docs build warns on every run",
      "Sync retries climbed overnight",
      "Desktop app main is red",
    ]);
    expect(qa("brief-risk-red")).toHaveLength(1);
    expect(qa("brief-risk-why")).toHaveLength(0); // one-row size: titles only
    const more = q("brief-risk-more")!;
    expect(more.textContent!.trim()).toBe("+2 more");
    await hover(more);
    const peek = q("brief-peek")!;
    expect(peek.textContent).toContain("2 more");
    expect(peek.querySelectorAll('[data-testid="brief-peek-line"]')).toHaveLength(2);
    expect(peek.textContent).toContain("Retry the gate");
    expect(peek.textContent).not.toMatch(PR_NUMBER);
  });

  it("a two-row slot adds each row's muted why with the product name", () => {
    render({ risks: seven().slice(0, 2), rows: 2, cols: 2 });
    const whys = qa("brief-risk-why").map((w) => w.textContent);
    expect(whys[0]).toBe("HQ core · Required checks can pass while a non-required check is red on main.");
    expect(whys[1]).toBe("Desktop app · Three open changes of yours have sat for a day.");
    expect(q("brief-risk-eyebrow")!.textContent).toBe("Watch · 2");
    expect(q("brief-risk")!.textContent).not.toMatch(SLUG);
  });

  it("a row's peek carries the prompt from prompts, else the risk's own", async () => {
    const rows = seven().slice(0, 2);
    rows[1]!.prompt = "The row's own prompt.";
    render({ risks: rows, rows: 1, prompts: { w1: "From the plan." } });
    await hover(qa("brief-risk-row")[0]!);
    expect(q("brief-peek-prompt")!.textContent).toBe("From the plan.");
    expect(q("brief-peek-eyebrow")!.textContent).toBe("Watch");
    expect(q("brief-peek-origin")!.textContent).toContain("HQ core");
    await hover(qa("brief-risk-row")[1]!);
    expect(q("brief-peek-prompt")!.textContent).toBe("The row's own prompt.");
  });

  it("the footer reads main health and its peek lists products GREEN or RED, red first", async () => {
    render({ risks: seven().slice(0, 1), rows: 1, mainHealth: HEALTH });
    const foot = q("brief-risk-foot")!;
    expect(foot.textContent!.replace(/\s+/g, " ").trim()).toBe("Main health 6 of 7 products green");
    expect(q("brief-risk-health")!.classList.contains("bad")).toBe(true);
    await hover(foot);
    const peek = q("brief-peek")!;
    expect(peek.textContent).toContain("Main health");
    expect(peek.textContent).toContain("6 of 7 products green · Desktop app red");
    const lines = [...peek.querySelectorAll('[data-testid="brief-peek-line"]')];
    expect(lines).toHaveLength(5); // the peek itself shows five, then +N more
    expect(lines[0]!.textContent).toContain("Desktop app");
    expect(lines[0]!.textContent).toContain("RED");
    expect(peek.textContent).toContain("+2 more");
  });

  it("without main health there is no footer; without any row the card is empty but mounts", () => {
    render({ risks: seven().slice(0, 1), rows: 1 });
    expect(q("brief-risk-foot")).toBeNull();
    expect(q("brief-risk-more")).toBeNull();
    expect(q("brief-risk-eyebrow")!.textContent).toBe("Watch");
  });
});

describe("Watch card through DailyBrief", () => {
  // DailyBrief passes every watch the catalogue counted (`risks`) with the plan's prompts.
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;
  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target?.remove();
  });

  it("renders every watch row the picker counted, each with the plan's prompt in its peek", async () => {
    // The real Oct 11 Sunday: four watches, the catalogue places the Watch card at S.
    const input = octoberEleven();
    const plan = generateBrief(input);
    expect(plan.widgets.find((w) => w.kind === "risk")).toMatchObject({ size: "S" });
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(DailyBrief, { target, props: { input, companies: COMPANIES } });
    flushSync();
    const rows = [...target.querySelectorAll<HTMLElement>('[data-testid="brief-risk-row"]')];
    expect(rows).toHaveLength(4);
    expect(rows[0]!.textContent).toContain("Staging can merge green and still break main");
    expect(target.querySelector('[data-testid="brief-risk-more"]')).toBeNull();
    // No main health on this fixture, so no footer.
    expect(target.querySelector('[data-testid="brief-risk-foot"]')).toBeNull();
    rows[0]!.dispatchEvent(new MouseEvent("mouseenter"));
    await new Promise((r) => setTimeout(r, 260));
    flushSync();
    expect(target.querySelector('[data-testid="brief-peek-prompt"]')!.textContent).toBe(plan.prompts.w1);
  });
});
