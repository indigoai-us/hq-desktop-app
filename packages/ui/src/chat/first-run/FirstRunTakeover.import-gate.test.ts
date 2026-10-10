// @vitest-environment happy-dom

/**
 * Owner finding (2026-10-10): "Finish with defaults" on an early step skipped
 * "Bring in your context" entirely. On every step before the import the only
 * way forward is Next: no Finish with defaults and no Continue in chat (other
 * than on the coding tools step while no tool is signed in, where the flow
 * cannot go forward at all). From the import on, Finish with defaults still
 * lands on Done, and a failed or empty scan can still move on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import FirstRunTakeover from "./FirstRunTakeover.svelte";
import type { FirstRunAppsHost, FirstRunSettled, FirstRunTeamHost } from "./first-run-hosts.js";
import type { AppCatalogResult, AppConnectResult } from "./app-step.js";
import { TEAM_ACTION_TIMEOUT_MS, TEAM_GENERIC_FAILURE, type TeamActionResult } from "./team-step.js";
import type { FirstRunCreation, FirstRunStepId } from "./visual-first-run.js";
import type { ImportScanEnd, ImportScanHost } from "./knowledge-tree/import-runner.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}
const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
const click = (sel: string) => q<HTMLButtonElement>(sel)!.click();
const step = () => q('[data-testid="first-run-step"]')?.getAttribute("data-step") ?? null;

const ACME = { companyUid: "cmp_acme", slug: "acme-robotics", name: "Acme Robotics" };
const HARBOR = { companyUid: "cmp_harbor", slug: "blue-harbor", name: "Blue Harbor" };

function fakeImportHost() {
  const runs: Array<{ emit: (raw: unknown) => void; end: (status: string) => void }> = [];
  const importHost: ImportScanHost = {
    run: vi.fn(
      (_scanId: string, emit: (raw: unknown) => void) =>
        new Promise<ImportScanEnd>((resolve) =>
          runs.push({ emit, end: (status) => resolve({ status: status as ImportScanEnd["status"] }) }),
        ),
    ),
    cancel: vi.fn(),
  };
  return { importHost, runs };
}

interface Opts {
  initialStep?: FirstRunStepId;
  runtimeReady?: Record<string, boolean>;
  creation?: FirstRunCreation;
  team?: Partial<FirstRunTeamHost>;
}

function render(opts: Opts = {}) {
  const { importHost, runs } = fakeImportHost();
  const handlers = {
    onconfirmname: vi.fn(),
    onretry: vi.fn(),
    ontalk: vi.fn(),
    oncontinueinchat: vi.fn(),
    onimport: vi.fn(),
    onsettled: vi.fn((_s: FirstRunSettled) => undefined),
  };
  const teamHost: FirstRunTeamHost = {
    join: vi.fn(async (c) => ({ ok: true, choice: { kind: "company", how: "joined", company: c } }) as TeamActionResult),
    create: vi.fn(async () => ({ ok: false, reason: "Couldn't start the company. Try again." }) as TeamActionResult),
    ...opts.team,
  };
  const appsHost: FirstRunAppsHost = {
    catalog: vi.fn(async (): Promise<AppCatalogResult> => ({ ok: true, apps: [], connected: [] })),
    connect: vi.fn(async (): Promise<AppConnectResult> => ({ ok: true })),
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(FirstRunTakeover, {
    target: host,
    props: {
      initialName: "Pickles",
      initialStep: opts.initialStep ?? "name",
      creation: opts.creation ?? { state: "ready", name: "Pickles", bot: { agentUid: "agt_1", name: "Pickles" } },
      runtimeReady: opts.runtimeReady ?? { claude: true, codex: false, grok: false },
      teamOptions: { invites: [ACME], companies: [HARBOR] },
      teamHost,
      appsHost,
      importHost,
      reducedMotion: true,
      ...handlers,
    },
  });
  return { handlers, importHost, runs };
}

async function waitForImport(): Promise<void> {
  await vi.waitFor(() => expect(q('[data-testid="first-run-import"]')).toBeTruthy(), { timeout: 3000 });
  await settle();
}

/** Every control on screen that could leave the step forward other than Next. */
function skipAheadControls(): string[] {
  const ids = [
    "first-run-finish",
    "new-bot-finish-name",
    "first-run-continue-in-chat",
    "first-run-team-chat",
    "first-run-failed-chat",
    "first-run-import-skip",
  ];
  return ids.filter((id) => q(`[data-testid="${id}"]`) !== null);
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("no way past Bring in your context before it has run", () => {
  it("name, team and tools show only Next, and Next walks one step at a time into the import", async () => {
    const { handlers } = render();
    await settle();
    // The full flow: name, team, tools, context, notes, projects, done.
    expect(document.querySelectorAll('[data-testid="new-bot-progress"] span')).toHaveLength(7);
    expect(step()).toBe("name");
    expect(skipAheadControls()).toEqual([]);
    click('[data-testid="new-bot-continue-name"]');
    await settle();
    expect(step()).toBe("team");
    expect(skipAheadControls()).toEqual([]);
    click('[data-testid="first-run-team-personal"]');
    await settle();
    // "Just me" leaves out the app screens; the import stays.
    click('[data-testid="first-run-next"]');
    await settle();
    expect(step()).toBe("tools");
    expect(skipAheadControls()).toEqual([]);
    expect(q('[data-testid="first-run-next"]')?.textContent).toContain("Next: Bring in your context");
    click('[data-testid="first-run-next"]');
    await waitForImport();
    expect(step()).toBe("context");
    expect(handlers.oncontinueinchat).not.toHaveBeenCalled();
  });

  it("with a company picked, the early steps still offer no Finish with defaults", async () => {
    render({ initialStep: "team" });
    await settle();
    expect(step()).toBe("team");
    expect(q('[data-testid="first-run-finish"]')).toBeNull();
    expect(q('[data-testid="first-run-continue-in-chat"]')).toBeNull();
  });

  it("a failed team action offers Retry and no way out to chat before the import", async () => {
    render({ initialStep: "team" });
    await settle();
    click('[data-testid="first-run-team-create"]');
    await settle();
    const field = q<HTMLInputElement>('[data-testid="first-run-company-name"]')!;
    field.value = "Pickle Works";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    click('[data-testid="first-run-next"]');
    await settle();
    expect(q('[data-testid="first-run-team-status"]')?.getAttribute("data-state")).toBe("failed");
    expect(q('[data-testid="first-run-team-retry"]')).toBeTruthy();
    expect(q('[data-testid="first-run-team-chat"]')).toBeNull();
    expect(skipAheadControls()).toEqual([]);
    // Not a dead end: another card and Next move on.
    click('[data-testid="first-run-team-personal"]');
    await settle();
    click('[data-testid="first-run-next"]');
    await settle();
    expect(step()).toBe("tools");
  });

  it("a failed create offers Retry, Next still moves on to the import, and nothing skips it", async () => {
    render({ initialStep: "tools", creation: { state: "failed", name: "Pickles", reason: "Couldn't create Pickles." } });
    await settle();
    expect(q('[data-testid="first-run-create-status"]')?.getAttribute("data-state")).toBe("failed");
    expect(q('[data-testid="first-run-retry"]')).toBeTruthy();
    expect(skipAheadControls()).toEqual([]);
    click('[data-testid="first-run-next"]');
    await waitForImport();
    expect(step()).toBe("context");
  });

  it("the coding tools step with no tool signed in keeps Continue in chat, the only way out, and no Finish", async () => {
    const { handlers } = render({ initialStep: "tools", runtimeReady: { claude: false, codex: false, grok: false }, creation: { state: "idle" } });
    await settle();
    expect(q<HTMLButtonElement>('[data-testid="first-run-next"]')?.disabled).toBe(true);
    expect(q('[data-testid="first-run-finish"]')).toBeNull();
    click('[data-testid="first-run-continue-in-chat"]');
    await settle();
    expect(handlers.oncontinueinchat).toHaveBeenCalledTimes(1);
  });

  it("the import step makes Bring it in the one primary button, with Skip for now as a quiet link under it, and no Finish or Continue in chat", async () => {
    render({ initialStep: "tools" });
    await settle();
    click('[data-testid="first-run-next"]');
    await waitForImport();
    const start = q<HTMLButtonElement>('[data-testid="first-run-import-start"]')!;
    expect(start.textContent).toContain("Bring it in");
    expect(start.classList.contains("new-bot-create-submit")).toBe(true);
    // The primary sits alone in its row.
    const row = start.closest(".new-bot-foot-actions")!;
    expect(row.classList.contains("single")).toBe(true);
    expect(row.querySelectorAll("button")).toHaveLength(1);
    // Declining is a small text link after it, not a button beside it.
    const skip = q<HTMLButtonElement>('[data-testid="first-run-import-skip"]')!;
    expect(skip.textContent).toBe("Skip for now");
    expect(skip.classList.contains("fr-link")).toBe(true);
    expect(skip.classList.contains("new-bot-create-next")).toBe(false);
    expect(row.contains(skip)).toBe(false);
    expect(start.compareDocumentPosition(skip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(q('[data-testid="first-run-finish"]')).toBeNull();
    expect(q('[data-testid="first-run-continue-in-chat"]')).toBeNull();
  });

  it("the import step keeps Continue in chat hidden while the scan runs, fails or is done", async () => {
    const { runs } = render({ initialStep: "tools" });
    await settle();
    click('[data-testid="first-run-next"]');
    await waitForImport();
    click('[data-testid="first-run-import-start"]');
    await settle();
    expect(q('[data-testid="first-run-continue-in-chat"]')).toBeNull();
    runs[0]!.end("failed");
    await vi.waitFor(() => expect(q('[data-testid="first-run-import-failed"]')).toBeTruthy());
    expect(q('[data-testid="first-run-continue-in-chat"]')).toBeNull();
    // Next still moves on, and the header comes back after the import.
    click('[data-testid="first-run-next"]');
    await settle();
    expect(step()).toBe("notes");
    expect(q('[data-testid="first-run-continue-in-chat"]')).toBeTruthy();
  });

  it("Skip for now, the quiet link, still moves on without scanning", async () => {
    const { importHost } = render({ initialStep: "tools" });
    await settle();
    click('[data-testid="first-run-next"]');
    await waitForImport();
    click('[data-testid="first-run-import-skip"]');
    await settle();
    expect(importHost.run).not.toHaveBeenCalled();
    expect(step()).toBe("notes");
  });
});

describe("from the import on", () => {
  async function toImport() {
    const r = render({ initialStep: "tools" });
    await settle();
    click('[data-testid="first-run-next"]');
    await waitForImport();
    click('[data-testid="first-run-import-start"]');
    await settle();
    return r;
  }

  it("Finish with defaults on the import step lands on Done", async () => {
    const { runs } = await toImport();
    expect(runs).toHaveLength(1);
    expect(q('[data-testid="first-run-finish"]')?.textContent).toContain("Finish with defaults");
    click('[data-testid="first-run-finish"]');
    await settle();
    expect(step()).toBe("done");
  });

  it("Finish with defaults on Note taker lands on Done", async () => {
    render({ initialStep: "notes" });
    await settle();
    expect(q('[data-testid="first-run-continue-in-chat"]')).toBeTruthy();
    click('[data-testid="first-run-finish"]');
    await settle();
    expect(step()).toBe("done");
  });

  it("a failed scan can still move on with Next", async () => {
    const { runs } = await toImport();
    runs[0]!.end("failed");
    await vi.waitFor(() => expect(q('[data-testid="first-run-import-failed"]')).toBeTruthy());
    expect(q<HTMLButtonElement>('[data-testid="first-run-next"]')?.disabled).toBe(false);
    click('[data-testid="first-run-next"]');
    await settle();
    expect(step()).toBe("notes");
  });

  it("an empty scan can still move on with Next", async () => {
    const { runs } = await toImport();
    for (const line of [
      { type: "start", sources: [{ id: "codex", label: "Codex" }] },
      { type: "source", id: "codex", status: "done", counts: { sessions: 0 } },
      { type: "done", report: "/tmp/r.json", summary: {} },
    ]) {
      runs[0]!.emit({ v: 1, ...line });
    }
    runs[0]!.end("done");
    await vi.waitFor(() => expect(q('[data-testid="first-run-import-summary"]')?.textContent).toContain("found no history"));
    click('[data-testid="first-run-next"]');
    await settle();
    expect(step()).toBe("notes");
  });
});

describe("a team join or create that never answers is not a dead end", () => {
  async function stuck(kind: "join" | "create") {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let resolveLate!: (r: TeamActionResult) => void;
    const never = vi.fn(() => new Promise<TeamActionResult>((r) => (resolveLate = r)));
    const r = render({ initialStep: "team", team: kind === "join" ? { join: never } : { create: never } });
    await settle();
    if (kind === "join") {
      click('[data-testid="first-run-team-invite:acme-robotics"]');
    } else {
      click('[data-testid="first-run-team-create"]');
      await settle();
      const field = q<HTMLInputElement>('[data-testid="first-run-company-name"]')!;
      field.value = "Pickle Works";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await settle();
    click('[data-testid="first-run-next"]');
    await settle();
    expect(never).toHaveBeenCalledTimes(1);
    expect(q<HTMLButtonElement>('[data-testid="first-run-next"]')?.disabled).toBe(true);
    return { ...r, never, resolveLate: (v: TeamActionResult) => resolveLate(v) };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  for (const kind of ["join", "create"] as const) {
    it(`a ${kind} still running after 30 seconds shows the failure line with Retry, and another card moves on`, async () => {
      const { never } = await stuck(kind);
      await vi.advanceTimersByTimeAsync(TEAM_ACTION_TIMEOUT_MS - 1);
      await settle();
      expect(q('[data-testid="first-run-team-status"]')).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      const line = q('[data-testid="first-run-team-status"]');
      expect(line?.getAttribute("data-state")).toBe("failed");
      expect(line?.textContent).toContain(TEAM_GENERIC_FAILURE);
      expect(q('[data-testid="first-run-team-retry"]')).toBeTruthy();
      // Still no way past the import.
      expect(skipAheadControls()).toEqual([]);
      // Retry runs it again.
      click('[data-testid="first-run-team-retry"]');
      await settle();
      expect(never).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(TEAM_ACTION_TIMEOUT_MS);
      await settle();
      expect(q('[data-testid="first-run-team-status"]')?.getAttribute("data-state")).toBe("failed");
      // Another card and Next move on, to the coding tools step, not past the import.
      click('[data-testid="first-run-team-personal"]');
      await settle();
      click('[data-testid="first-run-next"]');
      await settle();
      expect(step()).toBe("tools");
    });
  }

  it("a join that answers after the timeout changes nothing and does not move the flow", async () => {
    const { resolveLate, handlers } = await stuck("join");
    await vi.advanceTimersByTimeAsync(TEAM_ACTION_TIMEOUT_MS);
    await settle();
    expect(q('[data-testid="first-run-team-status"]')?.getAttribute("data-state")).toBe("failed");
    resolveLate({ ok: true, choice: { kind: "company", how: "joined", company: ACME } });
    await settle();
    expect(step()).toBe("team");
    expect(q('[data-testid="first-run-team-status"]')?.getAttribute("data-state")).toBe("failed");
    // The person moves on with Just me; the summary keeps that choice.
    click('[data-testid="first-run-team-personal"]');
    await settle();
    click('[data-testid="first-run-next"]');
    await settle();
    expect(step()).toBe("tools");
    click('[data-testid="first-run-back"]');
    await settle();
    expect(step()).toBe("team");
    expect(q('[data-testid="first-run-team-status"]')).toBeNull();
    // The handoff and Done show what was picked on screen, not the late join.
    const teams = handlers.onsettled.mock.calls.map(([settled]) => settled.team);
    expect(teams.length).toBeGreaterThan(0);
    expect(teams.at(-1)).toEqual({ kind: "personal" });
    expect(JSON.stringify(teams)).not.toContain("Acme");
    click('[data-testid="first-run-next"]');
    await settle();
    click('[data-testid="first-run-next"]');
    await waitForImport();
    click('[data-testid="first-run-import-skip"]');
    await settle();
    expect(step()).toBe("done");
    expect(q('[data-testid="first-run-summary-team"]')?.textContent).toBe("Just me");
    expect(handlers.onsettled.mock.calls.at(-1)![0].team).toEqual({ kind: "personal" });
  });

  it("closing the takeover while a join runs leaves nothing behind: no failure after 30 seconds and no warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { resolveLate, handlers } = await stuck("join");
      const reports = handlers.onsettled.mock.calls.length;
      await unmount(component!);
      component = null;
      await vi.advanceTimersByTimeAsync(TEAM_ACTION_TIMEOUT_MS * 2);
      resolveLate({ ok: true, choice: { kind: "company", how: "joined", company: ACME } });
      await settle();
      expect(warn).not.toHaveBeenCalled();
      expect(handlers.onsettled.mock.calls.length).toBe(reports);
    } finally {
      warn.mockRestore();
    }
  });
});
