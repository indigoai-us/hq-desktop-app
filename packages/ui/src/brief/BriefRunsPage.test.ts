// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type { LocalBotRow } from "@hq/platform";
import BriefRunsPage from "./BriefRunsPage.svelte";
import type { BriefCreator } from "./brief-create.svelte.js";
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

  it("opens the newest ready run from its own folder and lists history newest first", async () => {
    const reads = render(files());
    await settle();
    expect(reads).toContain(`workspace/brief/${NEW}/brief-data.json`);
    expect(reads).toContain(`workspace/brief/${NEW}/brief.json`);
    // The shared dropdown loads through its lazy door.
    await vi.waitFor(() => expect(q("brief-history")).not.toBeNull(), { timeout: 5_000 });
    expect(q("brief-history")!.getAttribute("data-value")).toBe(NEW);
    q("brief-history")!.click();
    await settle();
    const options = [...target.querySelectorAll<HTMLElement>('[data-testid="brief-history-menu"] [role="option"]')];
    expect(options.map((o) => o.getAttribute("data-value"))).toEqual([NEW, OLD]);
    expect(options[1]!.textContent).toContain("catch-up");
    expect(options[0]!.textContent).toContain("Headline " + NEW);
    expect(options[0]!.textContent).toContain("2 decisions · 4 shipped · 0 incidents");
    expect(options[0]!.textContent).not.toMatch(/today/i);
    // Picking from the list opens that run.
    options[1]!.click();
    await settle();
    expect(q("brief-viewing")).not.toBeNull();
    q("brief-latest")!.click();
    await settle();
    expect(q("brief-viewing")).toBeNull();
    expect(target.textContent).toContain("Newest call");
  });

  it("stepping to an older run shows the viewing chip, and Back to latest returns", async () => {
    render(files());
    await settle();
    q("brief-older")!.click();
    await settle();
    expect(q("brief-viewing")?.textContent).toContain("Viewing");
    expect(q("brief-catchup-tag")).not.toBeNull();
    expect(target.textContent).toContain("Older call");
    expect((q("brief-older") as HTMLButtonElement).disabled).toBe(true);
    q("brief-latest")!.click();
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

  it("marks files a run is missing", async () => {
    const f = files();
    delete f[`workspace/brief/${NEW}/brief-data.json`];
    render(f);
    await settle();
    expect(q("brief-missing")?.textContent).toContain("brief-data.json");
  });

  it("with no runs and a creator, shows the pre-dawn empty state with one Create brief button", async () => {
    const creator: BriefCreator = {
      company: () => null,
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
      expect(q("brief-dawn-step")?.textContent).toContain("Waiting for your bot to start");
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
});
