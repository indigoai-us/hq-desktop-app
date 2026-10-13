// @vitest-environment happy-dom
// The Create brief loader: idle line, fixed layout, and the single swap to the finished brief.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type { LocalBotRow } from "@hq/platform";
import BriefActivity from "./BriefActivity.svelte";
import BriefRunsPage from "./BriefRunsPage.svelte";
import { BriefCreateRun, type BriefCreator } from "./brief-create.svelte.js";
import type { BriefSweepSource } from "./brief-data.js";
import type { BriefActivity as Item } from "./brief-runs.js";

let app: ReturnType<typeof mount> | null = null;
let target: HTMLElement;
const q = (id: string) => target.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    await tick();
  }
  flushSync();
}

afterEach(() => {
  if (app) unmount(app);
  app = null;
  target?.remove();
  localStorage.clear();
});

describe("BriefActivity idle line", () => {
  it("after 20 quiet seconds the last row says still working and for how long; new steps render", () => {
    // happy-dom has no Web Animations; a finished stub lets the row's intro run.
    if (!Element.prototype.animate) {
      Element.prototype.animate = function () {
        const a = { onfinish: null as null | (() => void), cancel() {}, finish() {}, play() {}, pause() {}, currentTime: 0, finished: Promise.resolve() };
        setTimeout(() => a.onfinish?.(), 0);
        return a as unknown as Animation;
      };
    }
    target = document.createElement("div");
    document.body.appendChild(target);
    const activity = [{ at: "1", label: "Read 42 work sessions", state: "done", detail: null }] as Item[];
    const props = $state({ activity, elapsed: "2m 0s", idle: null as string | null });
    app = mount(BriefActivity, { target, props });
    flushSync();
    expect(q("brief-activity-idle")).toBeNull();
    props.idle = "45s";
    flushSync();
    expect(q("brief-activity-idle")?.textContent).toBe("· still working… 45s");
    expect(target.querySelector('[data-testid="brief-activity-item"] .pulse')).not.toBeNull();
    props.activity = [...activity, { at: "2", label: "Writing your brief", state: "running", detail: null }] as Item[];
    props.idle = null;
    flushSync();
    expect(target.textContent).toContain("Writing your brief");
    expect(q("brief-activity-idle")).toBeNull();
    expect(q("brief-elapsed")?.textContent).toBe("2m 0s");
  });
});

describe("finishing a run", () => {
  it("holds 'Your brief is ready' until brief.json is parsed, then swaps once with no placeholder brief", async () => {
    const bot = { name: "pickles", agentUid: "agt_1", runtime: "claude" } as LocalBotRow;
    const f: Record<string, string> = {};
    const creator: BriefCreator = {
      company: () => "indigo",
      check: async () => ({ ok: true, bot }),
      dispatch: vi.fn(async () => null),
      fix: vi.fn(async () => null),
      notify: vi.fn(),
    };
    const timers: (() => void)[] = [];
    const run = new BriefCreateRun({
      creator,
      read: async (p) => f[p] ?? null,
      storage: null,
      setTimer: (fn) => (timers.push(fn), timers.length),
      clearTimer: () => {},
      log: () => {},
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const source: BriefSweepSource = {
      readHqFile: async (p) => {
        if (p.endsWith("/brief.json")) await gate;
        return f[p] ?? null;
      },
    };
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(BriefRunsPage, { target, props: { adapter: {}, companies: [], source, creator, run } });
    await settle();
    q("brief-create")!.click();
    await settle();
    const runId = (run.phase as { runId: string }).runId;
    f[`workspace/brief/${runId}/status.json`] = JSON.stringify({ run_id: runId, state: "ready", step: "Done", progress: 1 });
    f["workspace/brief/index.jsonl"] = JSON.stringify({ run_id: runId, created_at: new Date().toISOString(), state: "ready", lead: "decisions", counts: {} });
    f[`workspace/brief/${runId}/brief.json`] = JSON.stringify({ items: { decisions: [{ id: "d1", title: "Ship the gate fix" }] } });
    f[`workspace/brief/${runId}/brief-data.json`] = "{}";
    timers.shift()!();
    await settle();
    expect(run.phase.kind).toBe("ready");
    // brief.json is still being read: the loader holds its final state.
    expect(q("daily-brief")).toBeNull();
    expect(q("brief-dawn")?.getAttribute("data-phase")).toBe("ready");
    expect(q("brief-dawn-step")?.textContent).toBe("Your brief is ready");
    expect(target.textContent).not.toContain("Nothing owed");
    release();
    await settle();
    expect(q("daily-brief")).not.toBeNull();
    expect(target.textContent).toContain("Ship the gate fix");
    expect(target.textContent).not.toContain("Nothing owed");
    run.stop();
  });
});
