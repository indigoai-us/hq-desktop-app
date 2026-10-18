// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import BriefRunsPage from "./BriefRunsPage.svelte";
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
