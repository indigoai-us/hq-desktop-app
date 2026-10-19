// @vitest-environment happy-dom
// The create control on the brief's title row: the app's primary Create brief
// only when there is no brief yet or the newest is from an earlier day; the
// standard secondary Refresh once today's brief exists, running the same create.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type { LocalBotRow } from "@hq/platform";
import BriefCreateButton from "./BriefCreateButton.svelte";
import BriefRunsPage from "./BriefRunsPage.svelte";
import { BriefCreateRun, type BriefCreator } from "./brief-create.svelte.js";
import { createControl, parseBriefIndex, type BriefIndexEntry } from "./brief-runs.js";

const NOW = new Date(2026, 9, 14, 14, 10);
const entries = (...rows: [string, Date, string?][]): BriefIndexEntry[] =>
  parseBriefIndex(rows.map(([id, at, state]) => JSON.stringify({ run_id: id, created_at: at.toISOString(), state: state ?? "ready", counts: {} })).join("\n")).entries;
const TODAY = entries(["brief-20261014-071500", new Date(2026, 9, 14, 7, 15)]);
const EARLIER = entries(["brief-20261013-180000", new Date(2026, 9, 13, 18, 0)]);

let app: ReturnType<typeof mount> | null = null;
let target: HTMLElement;
afterEach(() => {
  if (app) unmount(app);
  app = null;
  target?.remove();
  localStorage.clear();
});

function render(list: BriefIndexEntry[], busy = false) {
  const create = { phase: { kind: busy ? "running" : "idle" }, busy, start: vi.fn(async () => {}), fix: vi.fn() } as unknown as BriefCreateRun;
  const oncreate = vi.fn();
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(BriefCreateButton, { target, props: { entries: list, now: NOW, create, oncreate } });
  flushSync();
  return { button: target.querySelector<HTMLButtonElement>('[data-testid="brief-create"]')!, oncreate };
}

describe("createControl", () => {
  it("is Create brief with no brief yet, or when the newest ready brief is from an earlier local day", () => {
    expect(createControl([], NOW)).toBe("create");
    expect(createControl(EARLIER, NOW)).toBe("create");
    // A run still in progress today is not a brief yet.
    expect(createControl(entries(["brief-20261014-120000", new Date(2026, 9, 14, 12), "running"], ["brief-20261013-180000", new Date(2026, 9, 13, 18)]), NOW)).toBe("create");
  });

  it("is Refresh once today's brief exists, even when an older one is listed too", () => {
    expect(createControl(TODAY, NOW)).toBe("refresh");
    expect(createControl([...TODAY, ...EARLIER], NOW)).toBe("refresh");
    // Just after midnight, yesterday evening's brief no longer counts as today's.
    expect(createControl(EARLIER, new Date(2026, 9, 14, 0, 5))).toBe("create");
  });
});

describe("BriefCreateButton", () => {
  it("no brief yet: the app's primary Create brief", () => {
    const { button } = render([]);
    expect(button.textContent?.trim()).toBe("Create brief");
    expect(button.hasAttribute("data-rail-btn")).toBe(true);
    expect(button.classList.contains("primary")).toBe(true);
    expect(button.dataset.control).toBe("create");
  });

  it("an earlier day's brief: the primary Create brief", () => {
    const { button } = render(EARLIER);
    expect(button.textContent?.trim()).toBe("Create brief");
    expect(button.classList.contains("primary")).toBe(true);
  });

  it("today's brief: Refresh in the standard secondary button, not primary or orange", () => {
    const { button } = render(TODAY);
    expect(button.textContent?.trim()).toBe("Refresh");
    expect(button.dataset.control).toBe("refresh");
    expect(button.hasAttribute("data-rail-btn")).toBe(true);
    expect(button.classList.contains("secondary")).toBe(true);
    expect(button.classList.contains("primary")).toBe(false);
    expect(target.querySelectorAll('[data-testid="brief-create"]')).toHaveLength(1);
  });

  it("Refresh runs the same create action", () => {
    const { button, oncreate } = render(TODAY);
    button.click();
    expect(oncreate).toHaveBeenCalledTimes(1);
  });

  it("while a refresh runs: Refreshing…, disabled, still the secondary button", () => {
    const { button } = render(TODAY, true);
    expect(button.textContent?.trim()).toBe("Refreshing…");
    expect(button.disabled).toBe(true);
    expect(button.classList.contains("secondary")).toBe(true);
  });

  it("while a first or new-day run runs: Creating…, disabled", () => {
    const { button } = render(EARLIER, true);
    expect(button.textContent?.trim()).toBe("Creating…");
    expect(button.disabled).toBe(true);
  });
});

describe("on the page", () => {
  it("sits on the title row, right of the Daily Brief block, not on the history row", async () => {
    const bot = { name: "pickles", agentUid: "agt_1", runtime: "claude" } as LocalBotRow;
    const creator: BriefCreator = { company: () => "indigo", check: async () => ({ ok: true, bot }), dispatch: vi.fn(async () => null), fix: vi.fn(async () => null), notify: vi.fn() };
    const run = new BriefCreateRun({ creator, read: async () => null, storage: null, setTimer: () => 0, clearTimer: () => {}, log: () => {} });
    const id = "brief-20261013-180000";
    const files: Record<string, string> = {
      "workspace/brief/index.jsonl": JSON.stringify({ run_id: id, created_at: "2026-10-13T18:00:00Z", state: "ready", counts: {} }),
      [`workspace/brief/${id}/brief.json`]: JSON.stringify({ items: { decisions: [{ id: "d1", title: "Ship it" }] } }),
    };
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(BriefRunsPage, { target, props: { adapter: {}, companies: [], source: { readHqFile: async (p: string) => files[p] ?? null }, creator, run } });
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
      await tick();
    }
    flushSync();
    const button = target.querySelector<HTMLElement>('[data-testid="brief-create"]')!;
    expect(button.closest(".b-head .b-tools")).not.toBeNull();
    expect(button.closest('[data-testid="brief-runbar"]')).toBeNull();
    run.stop();
  });
});
