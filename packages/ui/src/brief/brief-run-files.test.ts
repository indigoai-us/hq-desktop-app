import { describe, expect, it } from "vitest";
import { parseBriefItems, parseHousekeeping } from "./brief-run-files.js";
import { gatherBriefInput, readRunHousekeeping, type BriefSweepSource } from "./brief-data.js";
import { briefPrompts } from "./brief-prompts.js";
import sweepJson from "./fixtures/sweep-2026-10-08.json";

const RUN = "brief-20261008-090000";

const briefJson = {
  run_id: RUN,
  generated_at: "2026-10-08T16:00:00Z",
  catch_up: false,
  items: {
    decisions: [
      {
        id: "pr-412",
        title: "Merge the sync fix",
        why: "It unblocks the beta",
        unlocks: ["beta.4", { label: "QA pass" }],
        risk: "Touches the runner",
        repo: "indigoai-us/hq-desktop-app",
        action: "go",
        prompt: "Open PR 412 in indigoai-us/hq-desktop-app and check CI first.",
      },
      { title: "" },
    ],
    waiting: [{ who: "Stefan", what: "to review PR 410", prompt: "Nudge Stefan about PR 410." }, { who: "", what: "x" }],
    incidents: [{ title: "Main is red on hq-pro", summary: "Two failing jobs", prompt: "Look at hq-pro main CI." }],
  },
  learned_notes: ["Fleet moved down"],
};

describe("parseBriefItems", () => {
  it("maps decisions, waits and incidents with their run prompts, dropping bad items", () => {
    const items = parseBriefItems(JSON.stringify(briefJson), "cmp_indigo")!;
    expect(items.decisions).toHaveLength(1);
    expect(items.decisions[0]).toMatchObject({
      id: "pr-412",
      action: "go",
      prompt: "Open PR 412 in indigoai-us/hq-desktop-app and check CI first.",
      origin: { companyUid: "cmp_indigo", repo: "indigoai-us/hq-desktop-app" },
      detail: { why: "It unblocks the beta", risk: "Touches the runner", unlocks: [{ label: "beta.4" }, { label: "QA pass" }] },
    });
    expect(items.waiting.map((w) => w.who)).toEqual(["Stefan"]);
    expect(items.incidents[0]).toMatchObject({ severity: "incident", title: "Main is red on hq-pro" });
    expect(items.learnedNotes).toEqual(["Fleet moved down"]);
  });

  it("accepts a flat item list tagged with kind", () => {
    const items = parseBriefItems(JSON.stringify({ items: [{ kind: "decision", title: "Pick a name" }, { kind: "incident", title: "Down" }] }), null)!;
    expect(items.decisions.map((d) => d.title)).toEqual(["Pick a name"]);
    expect(items.incidents.map((d) => d.title)).toEqual(["Down"]);
  });

  it("returns null for non-object JSON", () => {
    expect(parseBriefItems("[]", null)).toBeNull();
    expect(parseBriefItems("{oops", null)).toBeNull();
  });
});

describe("parseHousekeeping", () => {
  it("reads tasks as a map or a list, and keeps only proposals with a prompt", () => {
    const hk = parseHousekeeping(
      JSON.stringify({
        tasks: { "hq doctor": { ok: true, summary: "All good" }, "/hq-sync": { ok: false, error: "offline" } },
        proposals: [
          { id: "wt", title: "Remove 3 merged worktrees", frees: "2.1 GB", risk: "low", prompt: "Check each worktree has no unpushed commits, then remove it." },
          { title: "No prompt here" },
        ],
      }),
    )!;
    expect(hk.tasks).toEqual([
      { name: "hq doctor", ok: true, summary: "All good", error: null },
      { name: "/hq-sync", ok: false, summary: "", error: "offline" },
    ]);
    expect(hk.proposals).toEqual([
      { id: "wt", title: "Remove 3 merged worktrees", frees: "2.1 GB", risk: "low", prompt: "Check each worktree has no unpushed commits, then remove it." },
    ]);
    expect(parseHousekeeping(JSON.stringify({ tasks: [{ name: "qmd", ok: true }] }))!.tasks[0]!.name).toBe("qmd");
  });
});

describe("gatherBriefInput with a run id", () => {
  const companies = [{ uid: "cmp_indigo", slug: "indigo", label: "Indigo" }];
  const NOW = new Date(2026, 9, 8, 9, 0);

  it("reads brief-data.json and brief.json from workspace/brief/<run_id>/ and prefers the run's prompts", async () => {
    const files: Record<string, string> = {
      [`workspace/brief/${RUN}/brief-data.json`]: JSON.stringify(sweepJson),
      [`workspace/brief/${RUN}/brief.json`]: JSON.stringify(briefJson),
    };
    const reads: string[] = [];
    const source: BriefSweepSource = {
      readHqFile: async (p) => {
        reads.push(p);
        return files[p] ?? null;
      },
    };
    // The fixture sweep is for Oct 8, read as "yesterday" from a brief made on Oct 9.
    const { input, failures } = await gatherBriefInput(
      {},
      { now: new Date(2026, 9, 9, 7, 40), companies, sweep: source, runId: RUN, log: () => {} },
    );
    expect(reads).toEqual([`workspace/brief/${RUN}/brief-data.json`, `workspace/brief/${RUN}/brief.json`]);
    expect(failures).not.toContain("brief.json");
    expect(input.merged).toBe(34);
    expect(input.decisions.map((d) => d.id)).toEqual(["pr-412"]);
    expect(input.risks[0]!.title).toBe("Main is red on hq-pro");
    const prompts = briefPrompts(input);
    expect(prompts["pr-412"]).toBe("Open PR 412 in indigoai-us/hq-desktop-app and check CI first.");
    expect(prompts[input.waitingOn[0]!.id]).toBe("Nudge Stefan about PR 410.");
  });

  it("names the files a partial run is missing", async () => {
    const source: BriefSweepSource = { readHqFile: async () => null };
    const { failures } = await gatherBriefInput({}, { now: NOW, companies, sweep: source, runId: RUN, log: () => {} });
    expect(failures).toEqual(expect.arrayContaining(["brief-data.json", "brief.json"]));
  });

  it("without a run id reads only the per-day sweep, as before", async () => {
    const reads: string[] = [];
    const source: BriefSweepSource = { readHqFile: async (p) => (reads.push(p), null) };
    const { failures } = await gatherBriefInput({}, { now: NOW, companies, sweep: source, log: () => {} });
    expect(reads).toEqual(["workspace/brief/2026-10-08/brief-data.json"]);
    expect(failures).not.toContain("brief-data.json");
  });

  it("readRunHousekeeping reads the run's housekeeping.json and logs bad JSON", async () => {
    const log: string[] = [];
    const ok = await readRunHousekeeping(
      { readHqFile: async (p) => (p === `workspace/brief/${RUN}/housekeeping.json` ? JSON.stringify({ tasks: {}, proposals: [] }) : null) },
      RUN,
    );
    expect(ok).toEqual({ tasks: [], proposals: [] });
    expect(await readRunHousekeeping({ readHqFile: async () => "{oops" }, RUN, (m) => log.push(m))).toBeNull();
    expect(log).toEqual(["housekeeping.json is not valid JSON"]);
  });
});
