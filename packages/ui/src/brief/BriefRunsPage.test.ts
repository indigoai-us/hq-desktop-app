// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type { LocalBotRow } from "@hq/platform";
import BriefRunsPage from "./BriefRunsPage.svelte";
import { BriefCreateRun, type BriefCreator } from "./brief-create.svelte.js";
import type { BriefSweepSource } from "./brief-data.js";

const NEW = "brief-20261008-090000";
const OLD = "brief-20261005-080000";
/**
 * The newest fixture brief is from today: only today's brief opens by itself.
 * Stamped at 00:01 local today (not "an hour ago", which is yesterday when CI
 * runs in the first hour of a day) and before any run the test starts now.
 */
const todayEarly = (): string => {
  const d = new Date();
  d.setHours(0, 1, 0, 0);
  return d.toISOString();
};
const NEW_AT = todayEarly();
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
    "workspace/brief/index.jsonl": [entry(OLD, "2026-10-05T15:00:00Z", { catch_up: true }), entry(NEW, NEW_AT)].join("\n"),
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

  it("renders the Housekeeping card and launches a proposal's prompt", async () => {
    const onlaunch = vi.fn(async () => null);
    render(files(), { onlaunch });
    await settle();
    expect(q("brief-housekeeping")?.textContent).toContain("Remove 2 merged worktrees");
    q("brief-housekeeping-launch")!.click();
    await settle();
    expect(onlaunch).toHaveBeenCalledWith(expect.any(String), "Remove the merged worktrees after checking for unpushed commits.");
  });

  it("shows the stored run before the live sources answer, then lays the live data over it", async () => {
    let answer: (() => void) | null = null;
    const adapter = {
      identity: {
        whoami: () =>
          new Promise<{ ok: true; value: { personUid: string; email: string; displayName: string } }>((resolve) => {
            answer = () => resolve({ ok: true, value: { personUid: "prs_me", email: "corey@getindigo.ai", displayName: "Corey Epstein" } });
          }),
      },
    };
    render(files(), { adapter });
    await settle();
    expect(q("brief-loading")).toBeNull();
    expect(target.textContent).toContain("Newest call");
    expect(target.textContent).not.toContain("Corey");
    answer!();
    await settle();
    expect(target.textContent).toContain("Newest call");
    expect(target.textContent).toContain("Corey");
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

  it("with briefs from earlier days only, opens on today's Create brief; the earlier brief is one arrow back", async () => {
    const creator: BriefCreator = {
      company: () => "indigo",
      check: async () => ({ ok: false, bot: null, fix: "create-bot", message: "x" }),
      dispatch: vi.fn(async () => null),
      fix: vi.fn(async () => null),
      notify: vi.fn(),
    };
    const f = files();
    f["workspace/brief/index.jsonl"] = [entry(OLD, "2026-10-05T15:00:00Z"), entry(NEW, "2026-10-08T16:00:00Z")].join("\n");
    const reads = render(f, { creator });
    await settle();
    // The scene, not yesterday's brief; nothing of it loaded either.
    expect(q("brief-dawn")?.getAttribute("data-phase")).toBe("idle");
    expect(target.textContent).toContain("Today's brief is waiting");
    expect(q("daily-brief")).toBeNull();
    expect(target.textContent).not.toContain("Newest call");
    expect(reads).not.toContain(`workspace/brief/${NEW}/brief.json`);
    expect(target.querySelectorAll('[data-testid="brief-create"]')).toHaveLength(1);
    // The earlier briefs wait in the strip, none lit.
    const cells = [...target.querySelectorAll<HTMLElement>('[data-testid="brief-run-cell"]')];
    expect(cells.map((c) => c.getAttribute("data-run"))).toEqual([OLD, NEW]);
    expect(cells.every((c) => c.getAttribute("aria-current") == null)).toBe(true);
    // Arrow back: that brief, with the way back to today.
    cells[1]!.click();
    await settle();
    expect(q("daily-brief")).not.toBeNull();
    expect(target.textContent).toContain("Newest call");
    expect(q("brief-today")?.textContent).toContain("Back to today");
    expect(q("brief-latest")).toBeNull();
    // The header's control is still Create brief: there is no brief for today.
    expect(q("brief-create")?.getAttribute("data-control")).toBe("create");
    q("brief-today")!.click();
    await settle();
    expect(q("daily-brief")).toBeNull();
    expect(q("brief-dawn")?.getAttribute("data-phase")).toBe("idle");
    expect(target.textContent).toContain("Today's brief is waiting");
  });

  it("with one earlier brief only, the strip still shows it so it stays reachable; Left opens it", async () => {
    const creator: BriefCreator = {
      company: () => "indigo",
      check: async () => ({ ok: false, bot: null, fix: "create-bot", message: "x" }),
      dispatch: vi.fn(async () => null),
      fix: vi.fn(async () => null),
      notify: vi.fn(),
    };
    const f = files();
    f["workspace/brief/index.jsonl"] = entry(NEW, "2026-10-08T16:00:00Z");
    render(f, { creator });
    await settle();
    const cells = [...target.querySelectorAll<HTMLElement>('[data-testid="brief-run-cell"]')];
    expect(cells.map((c) => c.getAttribute("data-run"))).toEqual([NEW]);
    cells[0]!.focus();
    q("brief-run-strip")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await settle();
    expect(target.textContent).toContain("Newest call");
    // Right from the newest earlier brief goes back to today.
    q("brief-run-strip")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await settle();
    expect(q("daily-brief")).toBeNull();
    expect(target.textContent).toContain("Today's brief is waiting");
  });

  it("today's brief opens by itself, as before", async () => {
    const creator: BriefCreator = {
      company: () => "indigo",
      check: async () => ({ ok: false, bot: null, fix: "create-bot", message: "x" }),
      dispatch: vi.fn(async () => null),
      fix: vi.fn(async () => null),
      notify: vi.fn(),
    };
    render(files(), { creator });
    await settle();
    expect(q("daily-brief")).not.toBeNull();
    expect(target.textContent).toContain("Newest call");
    expect(q("brief-create")?.getAttribute("data-control")).toBe("refresh");
  });

  it("Start it on a stopped assistant plays the scene with 'Starting…', then the brief's own progress, in one press", async () => {
    const stopped = { name: "assistant", displayName: "assistant", agentUid: "agt_1", runtime: "claude", state: "stopped", processAlive: false } as LocalBotRow;
    const running = { ...stopped, state: "running", processAlive: true } as LocalBotRow;
    let started = false;
    const f = files();
    f["workspace/brief/index.jsonl"] = entry(NEW, "2026-10-08T16:00:00Z");
    const creator: BriefCreator = {
      company: () => "indigo",
      check: vi.fn(async () => (started ? { ok: true as const, bot: running } : { ok: false as const, bot: stopped, fix: "start-bot" as const, message: "assistant is not running." })),
      dispatch: vi.fn(async (_b, _body: string, key: string) => {
        f[`workspace/brief/${key}/status.json`] = JSON.stringify({ run_id: key, state: "running", step: "Sweeping your day", progress: 0.3 });
        return null;
      }),
      fix: vi.fn(async () => {
        started = true;
        return null;
      }),
      notify: vi.fn(),
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      render(f, { creator });
      await settle();
      q("brief-create")!.click();
      await settle();
      expect(q("brief-blocked")?.textContent).toBe("assistant is not running.");
      q("brief-fix")!.click();
      flushSync();
      expect(q("brief-dawn-step")?.textContent).toContain("Starting assistant…");
      await settle();
      expect(creator.fix).toHaveBeenCalledWith("start-bot", stopped);
      expect(creator.dispatch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_100);
      await settle();
      expect(q("brief-dawn")?.getAttribute("data-phase")).toBe("running");
      expect(q("brief-dawn-step")?.textContent).toContain("Sweeping your day");
    } finally {
      vi.useRealTimers();
    }
  });

  it("when the assistant cannot take the job, the scene offers Run in Claude instead, which opens the tool and follows the run", async () => {
    const stopped = { name: "assistant", agentUid: "agt_1", runtime: "claude", state: "failed", processAlive: false } as LocalBotRow;
    const f: Record<string, string> = {};
    const launch = vi.fn(async (_engine: string, prompt: string) => {
      const key = /--run-id (\S+)/.exec(prompt)![1]!;
      f[`workspace/brief/${key}/status.json`] = JSON.stringify({ run_id: key, state: "running", step: "Reading your sessions", progress: 0.2 });
      return null;
    });
    const creator: BriefCreator = {
      company: () => "indigo",
      check: async () => ({ ok: false, bot: stopped, fix: "start-bot", message: "Your assistant is not running." }),
      dispatch: vi.fn(async () => null),
      fix: vi.fn(async () => "Could not start assistant on this computer."),
      notify: vi.fn(),
      launch,
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      render(f, { creator });
      await settle();
      q("brief-create")!.click();
      await settle();
      // Blocked: the fix and the other way, side by side.
      expect(q("brief-fix")?.textContent).toContain("Start it");
      expect(q("brief-fallback")?.textContent).toContain("Run in Claude instead");
      // A start that fails stops with a sentence, and the other way is still there.
      q("brief-fix")!.click();
      await settle();
      expect(q("brief-dawn")?.getAttribute("data-phase")).toBe("failed");
      expect(q("brief-dawn-step")?.textContent).toContain("Could not start assistant on this computer.");
      expect(q("brief-retry")).not.toBeNull();
      expect(q("brief-fallback")).not.toBeNull();
      q("brief-fallback")!.click();
      flushSync();
      expect(q("brief-dawn-step")?.textContent).toContain("Opening Claude…");
      await settle();
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch.mock.calls[0]![0]).toBe("claude");
      expect(launch.mock.calls[0]![1]).toContain("/daily-brief indigo --run-id ");
      expect(q("brief-dawn-step")?.textContent).toContain("Sent to Claude, waiting for it to start");
      await vi.advanceTimersByTimeAsync(2_100);
      await settle();
      expect(q("brief-dawn-step")?.textContent).toContain("Reading your sessions");
      expect(creator.dispatch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
      expect(q("brief-dawn-step")?.textContent).toContain("waiting for it to start");
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
    f["workspace/brief/index.jsonl"] = entry(NEW, todayEarly());
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
    f["workspace/brief/index.jsonl"] = [entry(runId, new Date().toISOString()), entry(NEW, todayEarly())].join("\n");
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
    expect(q("brief-dawn-step")?.textContent).toContain("Waking your bot");
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
});
