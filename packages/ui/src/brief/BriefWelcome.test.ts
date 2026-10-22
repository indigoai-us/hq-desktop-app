// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import BriefRunsPage from "./BriefRunsPage.svelte";
import { returningWelcomeLine } from "./brief-welcome.js";
let app: ReturnType<typeof mount>;
let target: HTMLElement;
afterEach(() => { if (app) unmount(app); target?.remove(); localStorage.clear(); });
it("renders a zero-company first run and its quiet company action without a missing-company error", async () => {
  const run = "brief-20261017-090000";
  const onconnectcompany = vi.fn();
  const files: Record<string, string> = {
    "workspace/brief/index.jsonl": JSON.stringify({run_id: run, created_at: "2026-10-17T16:00:00Z", state: "ready", counts: {}}),
    [`workspace/brief/${run}/brief.json`]: JSON.stringify({mode: "personal", company: null, items: {}, welcome: {first_run: true, sessions: {total: 31}, import: {skills: 4, conversations: 12}, apps: ["Codex"], next_steps: [{kind: "connect_company"}]}}),
    [`workspace/brief/${run}/brief-data.json`]: "{}",
  };
  target = document.createElement("div"); document.body.appendChild(target);
  app = mount(BriefRunsPage, {target, props: {adapter: {}, companies: [], onconnectcompany, source: {readHqFile: async p => files[p] ?? null}}});
  await vi.waitFor(async () => { await tick(); expect(target.querySelector('[data-testid="brief-welcome"]')).not.toBeNull(); });
  expect(target.textContent).toContain("Welcome to your Daily Brief");
  expect(target.textContent).toContain("31");
  expect(target.textContent).toContain("Imported skills");
  expect(target.querySelector('[data-testid="brief-failed"]')).toBeNull();
  const action = [...target.querySelectorAll("button")].find(b => b.textContent === "Start or join a company");
  action!.click(); expect(onconnectcompany).toHaveBeenCalledOnce();
});

it("keeps all company sections inside one page scroll container", async () => {
  const companies = ["alpha", "beta", "gamma"].map(slug => ({uid: `cmp_${slug}`, slug, label: slug}));
  target = document.createElement("div"); document.body.appendChild(target);
  app = mount(BriefRunsPage, {target, props: {adapter: {}, companies, source: {readHqFile: async () => null}}});
  await vi.waitFor(async () => { await tick(); expect(target.querySelectorAll("[data-company]")).toHaveLength(4); });
  const scroller = target.querySelector<HTMLElement>('[data-testid="brief-content"]');
  expect(scroller).not.toBeNull();
  expect(scroller!.querySelectorAll("[data-company]")).toHaveLength(4);
  expect(getComputedStyle(scroller!).overflow).toBe("auto");
  for (const brief of scroller!.querySelectorAll<HTMLElement>(".daily-brief")) {
    expect(getComputedStyle(brief).height).toBe("auto");
    expect(getComputedStyle(brief).overflow).toBe("visible");
  }
});

it("greets a returning account with its companies and drops the start-a-company prompts (US-023)", async () => {
  const run = "brief-20261019-090000";
  const onconnectcompany = vi.fn();
  const files: Record<string, string> = {
    "workspace/brief/index.jsonl": JSON.stringify({run_id: run, created_at: "2026-10-19T16:00:00Z", state: "ready", counts: {}}),
    [`workspace/brief/${run}/brief.json`]: JSON.stringify({mode: "personal", company: null, items: {}, welcome: {first_run: true, getting_started: "Start or join a company to see its work here.", sessions: {total: 3}, import: {skills: 1, conversations: 2}, apps: [], next_steps: [{kind: "connect_company", reason: "Connect a company"}, {kind: "connect_apps", reason: "Connect your calendar"}]}}),
    [`workspace/brief/${run}/brief-data.json`]: "{}",
  };
  const companies = [{uid: "cmp_acme", slug: "acme", label: "Acme"}, {uid: "cmp_beta", slug: "beta", label: "Beta"}];
  target = document.createElement("div"); document.body.appendChild(target);
  app = mount(BriefRunsPage, {target, props: {adapter: {}, companies, onconnectcompany, firstView: {returning: true}, source: {readHqFile: async p => files[p] ?? null}}});
  await vi.waitFor(async () => { await tick(); expect(target.querySelector('[data-testid="brief-welcome"]')).not.toBeNull(); });
  const welcome = target.querySelector<HTMLElement>('[data-testid="brief-welcome"]')!;
  expect(welcome.dataset.returning).toBe("true");
  expect(welcome.querySelector("h2")?.textContent).toBe("Welcome back");
  expect(welcome.querySelector('[data-testid="brief-welcome-companies"]')?.textContent).toBe("Here is today's brief for Acme and Beta.");
  expect(welcome.textContent).not.toContain("Welcome to your Daily Brief");
  expect(welcome.textContent).not.toContain("Start or join a company");
  expect(welcome.textContent).not.toContain("Connect a company");
  expect(welcome.textContent).toContain("Connect your calendar");
  expect([...welcome.querySelectorAll("button")].some(b => b.textContent === "Start or join a company")).toBe(false);
});

it("keeps the new-person welcome when the first view is not returning", async () => {
  const run = "brief-20261019-091000";
  const files: Record<string, string> = {
    "workspace/brief/index.jsonl": JSON.stringify({run_id: run, created_at: "2026-10-19T16:10:00Z", state: "ready", counts: {}}),
    [`workspace/brief/${run}/brief.json`]: JSON.stringify({mode: "personal", company: null, items: {}, welcome: {first_run: true, next_steps: [{kind: "connect_company", reason: "Connect a company"}]}}),
    [`workspace/brief/${run}/brief-data.json`]: "{}",
  };
  target = document.createElement("div"); document.body.appendChild(target);
  app = mount(BriefRunsPage, {target, props: {adapter: {}, companies: [], onconnectcompany: vi.fn(), firstView: {returning: false}, source: {readHqFile: async p => files[p] ?? null}}});
  await vi.waitFor(async () => { await tick(); expect(target.querySelector('[data-testid="brief-welcome"]')).not.toBeNull(); });
  expect(target.textContent).toContain("Welcome to your Daily Brief");
  expect(target.textContent).toContain("Connect a company");
  expect([...target.querySelectorAll("button")].some(b => b.textContent === "Start or join a company")).toBe(true);
});

it("names one, two and three returning companies in a plain list", () => {
  expect(returningWelcomeLine(["Acme"])).toBe("Here is today's brief for Acme.");
  expect(returningWelcomeLine(["Acme", "Beta"])).toBe("Here is today's brief for Acme and Beta.");
  expect(returningWelcomeLine(["Acme", "Beta", "Gamma"])).toBe("Here is today's brief for Acme, Beta and Gamma.");
});

for (const [kind, raw] of [
  ["gh", "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, popula"],
  ["traceback", 'Traceback (most recent call last):\n  File "/Users/x/brief-sweep.py", line 1668, in main\nKeyError: \'total\''],
] as const) {
  it(`never renders a ${kind} welcome.error; shows one fixed sentence instead`, async () => {
    const run = "brief-20261017-090000";
    const files: Record<string, string> = {
      "workspace/brief/index.jsonl": JSON.stringify({run_id: run, created_at: "2026-10-17T16:00:00Z", state: "ready", counts: {}}),
      [`workspace/brief/${run}/brief.json`]: JSON.stringify({mode: "personal", company: null, items: {}, welcome: {first_run: true, sessions: {total: 31}, error: raw}}),
      [`workspace/brief/${run}/brief-data.json`]: "{}",
    };
    target = document.createElement("div"); document.body.appendChild(target);
    app = mount(BriefRunsPage, {target, props: {adapter: {}, companies: [], source: {readHqFile: async p => files[p] ?? null}}});
    await vi.waitFor(async () => { await tick(); expect(target.querySelector('[data-testid="brief-welcome"]')).not.toBeNull(); });
    expect(target.querySelector('[data-testid="brief-welcome-error"]')?.textContent?.trim()).toBe("Some of your welcome details could not be loaded this time.");
    expect(target.textContent).not.toMatch(/gh auth|GitHub CLI|Alternatively|popula|Traceback|brief-sweep|KeyError|line 1668/);
  });
}
