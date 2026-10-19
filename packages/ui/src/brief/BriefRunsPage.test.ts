// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type { LocalBotRow } from "@hq/platform";
import BriefRunsPage from "./BriefRunsPage.svelte";
import { BriefCreateRun, type BriefCreator } from "./brief-create.svelte.js";
import type { BriefSweepSource } from "./brief-data.js";

const NEW = "brief-20261008-090000";
const OLD = "brief-20261005-080000";
const entry = (runId: string, created: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    run_id: runId,
    created_at: created,
    state: "ready",
    catch_up: false,
    lead: "decisions",
    counts: { decisions: 2, shipped: 4, incidents: 0 },
    headline: `Headline ${runId}`,
    ...extra,
  });

let app: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    await tick();
  }
  flushSync();
}

function render(files: Record<string, string>, props: Record<string, unknown> = {}) {
  const reads: string[] = [];
  const source: BriefSweepSource = {
    readHqFile: async (p) => {
      reads.push(p);
      return files[p] ?? null;
    },
  };
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(BriefRunsPage, { target, props: { adapter: {}, companies: [], source, ...props } });
  return reads;
}

const q = (id: string) => target.querySelector<HTMLElement>(`[data-testid="${id}"]`);

afterEach(() => {
  if (app) unmount(app);
  app = null;
  target?.remove();
  localStorage.clear();
});

describe("BriefRunsPage", () => {
  const files = (): Record<string, string> => ({
    "workspace/brief/index.jsonl": [entry(OLD, "2026-10-05T15:00:00Z", { catch_up: true }), entry(NEW, "2026-10-08T16:00:00Z")].join("\n"),
    [`workspace/brief/${NEW}/brief.json`]: JSON.stringify({ items: { decisions: [{ id: "d1", title: "Newest call" }] } }),
    [`workspace/brief/${NEW}/brief-data.json`]: "{}",
    [`workspace/brief/${NEW}/housekeeping.json`]: JSON.stringify({
      tasks: { "hq doctor": { ok: true } },
      proposals: [{ id: "wt", title: "Remove 2 merged worktrees", frees: "1 GB", risk: "low", prompt: "Remove the merged worktrees after checking for unpushed commits." }],
    }),
    [`workspace/brief/${OLD}/brief.json`]: JSON.stringify({ items: { decisions: [{ id: "d0", title: "Older call" }] } }),
  });

  it("opens the newest ready run from its own folder and shows history as quiet squares, oldest on the left", async () => {
    const reads = render(files());
    await settle();
    expect(reads).toContain(`workspace/brief/${NEW}/brief-data.json`);
    expect(reads).toContain(`workspace/brief/${NEW}/brief.json`);
    const cells = [...target.querySelectorAll<HTMLElement>('[data-testid="brief-run-cell"]')];
    expect(cells.map((c) => c.getAttribute("data-run"))).toEqual([OLD, NEW]);
    expect(cells[1]!.getAttribute("aria-current")).toBe("true");
    expect(cells[0]!.getAttribute("aria-label")).toContain("catch-up");
    expect(cells[1]!.getAttribute("aria-label")).toContain("Headline " + NEW);
    expect(cells[1]!.getAttribute("aria-label")).not.toMatch(/today/i);
    // Only the squares: no arrows, no dropdown, no visible tags.
    expect(q("brief-older")).toBeNull();
    expect(q("brief-history")).toBeNull();
    expect(q("brief-catchup-tag")).toBeNull();
    // A square opens its run.
    cells[0]!.click();
    await settle();
    expect(q("brief-viewing")?.textContent).toContain("Viewing");
    expect(target.textContent).toContain("Older call");
    q("brief-latest")!.click();
    await settle();
    expect(q("brief-viewing")).toBeNull();
    expect(target.textContent).toContain("Newest call");
  });

  it("arrow keys on the squares step older and newer", async () => {
    render(files());
    await settle();
    const strip = q("brief-run-strip")!;
    strip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await settle();
    expect(target.textContent).toContain("Older call");
    expect(q("brief-viewing")).not.toBeNull();
    q("brief-run-strip")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await settle();
    expect(q("brief-viewing")).toBeNull();
    expect(target.textContent).toContain("Newest call");
  });

  it("reports the run on screen through onshown, including after a run bar pick and on leaving", async () => {
    const onshown = vi.fn();
    render(files(), { onshown });
    await settle();
    expect(onshown).toHaveBeenLastCalledWith(NEW);
    target.querySelector<HTMLElement>(`[data-testid="brief-run-cell"][data-run="${OLD}"]`)!.click();
    await settle();
    expect(onshown).toHaveBeenLastCalledWith(OLD);
    q("brief-latest")!.click();
    await settle();
    expect(onshown).toHaveBeenLastCalledWith(NEW);
    unmount(app!);
    app = null;
    expect(onshown).toHaveBeenLastCalledWith(null);
  });

  it("renders the Housekeeping card and launches a proposal's prompt", async () => {
    const onlaunch = vi.fn(async () => null);
    render(files(), { onlaunch });
    await settle();
    expect(q("brief-housekeeping")?.textContent).toContain("Remove 2 merged worktrees");
    q("brief-housekeeping-launch")!.click();
    await settle();
    expect(onlaunch).toHaveBeenCalledWith(expect.any(String), "Remove the merged worktrees after checking for unpushed commits.");
  });

  it("marks a run that is missing files in plain words, never by file name", async () => {
    // Owner report, 2026-10-16: "Missing from this brief: brief-data.json, brief.json".
    const f = files();
    delete f[`workspace/brief/${NEW}/brief-data.json`];
    render(f);
    await settle();
    const note = q("brief-missing")?.textContent ?? "";
    expect(note).toBe("Part of this brief did not finish, so some cards may be empty.");
    expect(note).not.toMatch(/\.json/);
  });

  it("with no runs and a creator, shows the pre-dawn empty state with one Create brief button", async () => {
    const creator: BriefCreator = {
      company: () => "indigo",
      check: async () => ({ ok: false, bot: null, fix: "create-bot", message: "x" }),
      dispatch: vi.fn(async () => null),
      fix: vi.fn(async () => null),
      notify: vi.fn(),
    };
    render({}, { creator });
    await settle();
    expect(q("brief-dawn")?.getAttribute("data-phase")).toBe("idle");
    expect(target.textContent).toContain("Your first brief is waiting");
    expect(target.querySelectorAll('[data-testid="brief-create"]')).toHaveLength(1);
    expect(q("daily-brief")).toBeNull();
  });

  it("with no runs and no creator, renders the old per-day brief and no history", async () => {
    const reads = render({});
    await settle();
    expect(q("daily-brief")).not.toBeNull();
    expect(q("brief-history")).toBeNull();
    expect(reads.some((p) => /^workspace\/brief\/\d{4}-\d{2}-\d{2}\/brief-data\.json$/.test(p))).toBe(true);
  });

  it("Create brief shows a plain blocked message with a fix when no model is connected", async () => {
    const bot = { name: "pickles", agentUid: "agt_1", runtime: "claude" } as LocalBotRow;
    const creator: BriefCreator = {
      company: () => "indigo",
      check: async () => ({ ok: false, bot, fix: "connect-model", message: "pickles has no model connected on this computer." }),
      dispatch: vi.fn(async () => null),
      fix: vi.fn(async () => null),
      notify: vi.fn(),
    };
    render({}, { creator });
    await settle();
    q("brief-create")!.click();
    await settle();
    expect(q("brief-blocked")?.textContent).toBe("pickles has no model connected on this computer.");
    expect(q("brief-fix")?.textContent?.trim()).toBe("Connect a model");
    expect(creator.dispatch).not.toHaveBeenCalled();
    q("brief-fix")!.click();
    await settle();
    expect(creator.fix).toHaveBeenCalledWith("connect-model", bot);
  });

  it("keeps Create brief available next to the sign-in fix when a brief already exists", async () => {
    const bot = { name: "setup", role: "assistant", agentUid: "agt_1", runtime: "claude" } as LocalBotRow;
    let signedIn = false;
    const creator: BriefCreator = {
      company: () => "indigo",
      check: vi.fn(async () =>
        signedIn
          ? { ok: false as const, bot, fix: "start-bot" as const, message: "Your assistant is not running." }
          : { ok: false as const, bot, fix: "sign-in" as const, message: "Your assistant needs you to sign in to Claude again before it can build a brief." },
      ),
      dispatch: vi.fn(async () => null),
      fix: vi.fn(async () => null),
      notify: vi.fn(),
    };
    render(files(), { creator });
    await settle();
    q("brief-create")!.click();
    await settle();
    expect(q("brief-blocked")?.textContent).toContain("sign in to Claude again");
    // The run action is not hidden behind the sign-in state: after signing in
    // elsewhere, Create brief checks again and shows the next real reason.
    expect(q("brief-create")).not.toBeNull();
    signedIn = true;
    q("brief-create")!.click();
    await settle();
    expect(creator.check).toHaveBeenCalledTimes(2);
    expect(q("brief-blocked")?.textContent).toBe("Your assistant is not running.");
    expect(q("brief-fix")?.textContent?.trim()).toBe("Start it");
  });

  it("Create brief dispatches and shows the progress step from status.json", async () => {
    const bot = { name: "pickles", agentUid: "agt_1", runtime: "claude" } as LocalBotRow;
    const f: Record<string, string> = {};
    const creator: BriefCreator = {
      company: () => "indigo",
      check: async () => ({ ok: true, bot }),
      dispatch: vi.fn(async (_b, body: string, key: string) => {
        f[`workspace/brief/${key}/status.json`] = JSON.stringify({ run_id: key, state: "running", step: "Sweeping your day", progress: 0.4 });
        expect(body).toContain(`--run-id ${key}`);
        return null;
      }),
      fix: vi.fn(async () => null),
      notify: vi.fn(),
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      render(f, { creator });
      await settle();
      q("brief-create")!.click();
      await settle();
      // No runs yet: the progress plays in the full-page sunrise.
      expect(q("brief-dawn-step")?.textContent).toContain("Getting your brief started");
      expect(q("brief-dawn")?.getAttribute("data-progress")).toBe("0.00");
      await vi.advanceTimersByTimeAsync(2_100);
      await settle();
      expect(q("brief-dawn-step")?.textContent).toContain("Sweeping your day");
      expect(q("brief-dawn")?.getAttribute("data-phase")).toBe("running");
      expect(q("brief-dawn")?.getAttribute("data-progress")).toBe("0.40");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Refresh over today's brief plays the full-page scene in its place, not a band on top", async () => {
    const bot = { name: "pickles", agentUid: "agt_1", runtime: "claude" } as LocalBotRow;
    const f = files();
    f["workspace/brief/index.jsonl"] = entry(NEW, new Date().toISOString());
    const creator: BriefCreator = {
      company: () => "indigo",
      check: async () => ({ ok: true, bot }),
      dispatch: vi.fn(async () => null),
      fix: vi.fn(async () => null),
      notify: vi.fn(),
    };
    render(f, { creator });
    await settle();
    expect(target.querySelector('[data-testid="daily-brief"]')).not.toBeNull();
    expect(q("brief-create")?.getAttribute("data-control")).toBe("refresh");
    q("brief-create")!.click();
    await settle();
    expect(target.querySelector('[data-testid="daily-brief"]')).toBeNull();
    expect(target.querySelector(".daily-brief-dawn-page")).not.toBeNull();
    expect(q("brief-dawn")?.getAttribute("data-phase")).toBe("running");
    // A title under the CREATING label, as the first brief has.
    expect(target.querySelector("header h2")?.textContent).toBe("Your new brief is on its way");
    expect(target.textContent).not.toContain("Newest call");
  });

  it("after a refresh hands off, stepping to an older brief shows that brief, not the ready scene again", async () => {
    const bot = { name: "pickles", agentUid: "agt_1", runtime: "claude" } as LocalBotRow;
    const f = files();
    f["workspace/brief/index.jsonl"] = entry(NEW, new Date(Date.now() - 3_600_000).toISOString());
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
    render(f, { creator, run });
    await settle();
    q("brief-create")!.click();
    await settle();
    const runId = (run.phase as { runId: string }).runId;
    f[`workspace/brief/${runId}/status.json`] = JSON.stringify({ run_id: runId, state: "ready", step: "Done", progress: 1 });
    f["workspace/brief/index.jsonl"] = [entry(runId, new Date().toISOString()), entry(NEW, new Date(Date.now() - 3_600_000).toISOString())].join("\n");
    f[`workspace/brief/${runId}/brief.json`] = JSON.stringify({ items: { decisions: [{ id: "d2", title: "Fresh call" }] } });
    f[`workspace/brief/${runId}/brief-data.json`] = "{}";
    timers.shift()!();
    await settle();
    expect(target.textContent).toContain("Fresh call");
    target.querySelector<HTMLElement>(`[data-run="${NEW}"]`)!.click();
    await settle();
    expect(target.querySelector(".daily-brief-dawn-page")).toBeNull();
    expect(target.textContent).toContain("Newest call");
    expect(q("brief-viewing")).not.toBeNull();
    run.stop();
  });

  it("a stopped run offers Try again and Dismiss as the app's standard buttons", async () => {
    const creator: BriefCreator = {
      company: () => "indigo",
      check: async () => {
        throw new Error("offline");
      },
      dispatch: vi.fn(async () => null),
      fix: vi.fn(async () => null),
      notify: vi.fn(),
    };
    render({}, { creator });
    await settle();
    q("brief-create")!.click();
    await settle();
    const retry = q("brief-retry")!;
    const dismiss = q("brief-dismiss")!;
    expect(retry.hasAttribute("data-rail-btn")).toBe(true);
    expect(retry.classList.contains("primary")).toBe(true);
    expect(retry.textContent).toContain("Try again");
    expect(dismiss.hasAttribute("data-rail-btn")).toBe(true);
    expect(dismiss.classList.contains("ghost")).toBe(true);
    expect(dismiss.textContent).toContain("Dismiss");
    expect(target.querySelector(".cta:not(.big)")).toBeNull();
  });

  it("a shared run survives the page unmounting and shows its progress on return", async () => {
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
    const shared = new BriefCreateRun({
      creator,
      read: async (p) => f[p] ?? null,
      storage: null,
      setTimer: (fn) => (timers.push(fn), timers.length),
      clearTimer: () => {},
      log: () => {},
    });
    render(f, { creator, run: shared });
    await settle();
    q("brief-create")!.click();
    // The first frame is the sunrise, painted before the bot check resolves.
    flushSync();
    expect(q("brief-dawn-step")?.textContent).toContain("Getting your brief started…");
    await settle();
    const runId = (shared.phase as { runId: string }).runId;
    unmount(app!);
    app = null;
    target.remove();

    // Elsewhere in the app: the shared poller keeps going.
    f[`workspace/brief/${runId}/status.json`] = JSON.stringify({ run_id: runId, state: "running", step: "Sweeping your day", progress: 0.6 });
    timers.shift()!();
    await settle();
    expect(shared.phase).toMatchObject({ kind: "running", progress: 0.6 });

    render(f, { creator, run: shared });
    await settle();
    expect(q("brief-dawn-step")?.textContent).toContain("Sweeping your day");
    expect(q("brief-create")).toBeNull();
    expect(creator.dispatch).toHaveBeenCalledTimes(1);
    shared.stop();
  });

  // The bot's own operator text (its name, "Check that it is running", the
  // skill's skill_not_found sentence) never renders: the person sees one
  // plain line and one action.
  it("a run that never starts shows one plain line and Try again, never the raw operator text", async () => {
    const bot = { name: "pickles", agentUid: "agt_1", runtime: "claude", displayName: "Jellybean" } as LocalBotRow;
    const f: Record<string, string> = {};
    const creator: BriefCreator = {
      company: () => "indigo",
      check: async () => ({ ok: true, bot }),
      dispatch: vi.fn(async (_b, _body: string, key: string) => {
        f[`workspace/brief/${key}/status.json`] = JSON.stringify({
          run_id: key,
          status: "failed",
          error: "skill_not_found",
          message: "No daily-brief skill is installed in this HQ. Check that Jellybean is running.",
        });
        return null;
      }),
      fix: vi.fn(async () => null),
      notify: vi.fn(),
    };
    const timers: (() => void)[] = [];
    let clock = new Date(2026, 9, 8, 9, 0, 0).getTime();
    const shared = new BriefCreateRun({
      creator,
      read: async (p) => f[p] ?? null,
      storage: null,
      now: () => new Date(clock),
      setTimer: (fn) => (timers.push(fn), timers.length),
      clearTimer: () => {},
      log: () => {},
    });
    render(f, { creator, run: shared });
    await settle();
    q("brief-create")!.click();
    await settle();
    expect(document.body.textContent).not.toMatch(/Jellybean|pickles|your bot/i);
    for (let i = 0; i < 2; i++) {
      clock += 2_000;
      timers.shift()!();
      await settle();
    }
    expect(creator.dispatch).toHaveBeenCalledTimes(2);
    expect(q("brief-dawn")?.getAttribute("data-phase")).toBe("failed");
    expect(q("brief-dawn-step")?.textContent?.trim()).toBe("Your brief is taking longer than expected.");
    expect(q("brief-retry")?.textContent?.trim()).toBe("Try again");
    expect(q("brief-dawn")?.querySelectorAll("button")).toHaveLength(1);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Jellybean|pickles|skill_not_found|No daily-brief skill|check that|is running|your bot/i);
    shared.stop();
  });

  it("a missing daily-brief skill never sends the job and shows the same line at once", async () => {
    const bot = { name: "pickles", agentUid: "agt_1", runtime: "claude" } as LocalBotRow;
    const creator: BriefCreator = {
      company: () => "indigo",
      check: async () => ({ ok: true, bot }),
      skillInstalled: async () => false,
      dispatch: vi.fn(async () => null),
      fix: vi.fn(async () => null),
      notify: vi.fn(),
    };
    render(files(), { creator });
    await settle();
    q("brief-create")!.click();
    await settle();
    expect(creator.dispatch).not.toHaveBeenCalled();
    expect(q("brief-dawn-step")?.textContent?.trim()).toBe("Your brief is taking longer than expected.");
    expect(q("brief-retry")?.textContent?.trim()).toBe("Try again");
    expect(q("brief-dawn")?.querySelectorAll("button")).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/pickles|bot|skill/i);
  });

  describe("raw gh or exception text never reaches the page", () => {
    const LIVE_GH = "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, popula";
    const TRACEBACK = 'Traceback (most recent call last):\n  File "/Users/x/brief-sweep.py", line 1668, in main\nKeyError: \'total\'';
    const RAW = /gh auth|GitHub CLI|Alternatively|popula|Traceback|brief-sweep|KeyError|line 1668/;
    const rawActivity = [
      { at: "1", label: "Looking at your PRs", state: "failed", detail: LIVE_GH },
      { at: "2", label: "Read your calendar", state: "done", detail: TRACEBACK },
      { at: "3", label: "Housekeeping", state: "done", detail: `failed: ${LIVE_GH}` },
      { at: "4", label: "Writing your brief", state: "running", detail: null },
    ];

    async function runWith(existing: Record<string, string>, status: (key: string) => Record<string, unknown>) {
      const bot = { name: "pickles", agentUid: "agt_1", runtime: "claude" } as LocalBotRow;
      const f: Record<string, string> = { ...existing };
      const creator: BriefCreator = {
        company: () => "indigo",
        check: async () => ({ ok: true, bot }),
        dispatch: vi.fn(async (_b, _body: string, key: string) => {
          f[`workspace/brief/${key}/status.json`] = JSON.stringify({ run_id: key, ...status(key) });
          return null;
        }),
        fix: vi.fn(async () => null),
        notify: vi.fn(),
      };
      render(f, { creator });
      await settle();
      q("brief-create")!.click();
      await settle();
      await vi.advanceTimersByTimeAsync(2_100);
      await settle();
    }

    for (const [where, existing] of [["the first-run sunrise", {}], ["the masthead", null]] as const) {
      it(`activity details on failed, done and housekeeping rows never show on ${where}`, async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
        try {
          await runWith(existing ?? files(), () => ({ state: "running", step: "Sweeping your day", progress: 0.4, activity: rawActivity }));
          expect(q("brief-dawn")?.getAttribute("data-phase")).toBe("running");
          const labels = [...target.querySelectorAll<HTMLElement>('[data-testid="brief-activity-item"]')].map((i) => i.textContent ?? "");
          expect(labels.join(" ")).toContain("Writing your brief");
          expect(target.textContent).not.toMatch(RAW);
          expect(target.textContent).not.toContain("failed:");
        } finally {
          vi.useRealTimers();
        }
      });

      for (const [kind, raw] of [["gh", LIVE_GH], ["traceback", TRACEBACK]] as const) {
        it(`a failed run's ${kind} status.error never shows on ${where}; the plain failed line and Try again do`, async () => {
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
          try {
            await runWith(existing ?? files(), () => ({ state: "failed", error: raw, activity: rawActivity }));
            expect(q("brief-dawn")?.getAttribute("data-phase")).toBe("failed");
            expect(q("brief-dawn-step")?.textContent?.trim()).toBe("The brief stopped before it finished.");
            expect(q("brief-retry")?.textContent?.trim()).toBe("Try again");
            expect(target.textContent).not.toMatch(RAW);
          } finally {
            vi.useRealTimers();
          }
        });

        it(`a failed run's ${kind} text written as its message never shows on ${where}`, async () => {
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
          try {
            await runWith(existing ?? files(), () => ({ state: "failed", error: raw, message: raw }));
            expect(q("brief-dawn-step")?.textContent?.trim()).toBe("The brief stopped before it finished.");
            expect(target.textContent).not.toMatch(RAW);
          } finally {
            vi.useRealTimers();
          }
        });
      }
    }
  });
});
