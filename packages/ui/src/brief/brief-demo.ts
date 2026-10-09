/**
 * Dev hook for reviewing the Create brief sunrise without a bot.
 *
 *   ?briefDemo=1        empty state; Create brief runs a simulated ~20 s run to ready
 *   ?briefDemo=fail     the simulated run fails partway
 *   ?briefDemoAt=0.5    frozen frame at that progress (0..1), or `fail`
 *
 * Read only from the page URL, so the shipped app never enters it unless the
 * URL says so (the desktop window's URL carries no query).
 */

import type { LocalBotRow } from "@hq/platform";
import type { BriefCreator } from "./brief-create.svelte.js";
import type { BriefSweepSource } from "./brief-data.js";

export interface BriefDemo {
  creator: BriefCreator;
  source: BriefSweepSource;
  /** Frozen frame for screenshots: progress, or "fail". */
  frozen: number | "fail" | null;
}

/** What a run reports, source by source, for the demo's activity list. */
const ACTIVITY: [number, string, "done" | "skipped" | "failed", string?][] = [
  [0.08, "Checked your setup", "done"],
  [0.16, "Read your last brief", "done", "Oct 8, 9:14 AM"],
  [0.26, "Read 42 work sessions", "done", "Oct 4–9"],
  [0.34, "Found 6 recorded meetings, 19 signals", "done"],
  [0.42, "Found 31 DMs, 4 need you", "done"],
  [0.5, "Checked 44 fleet agents", "done"],
  [0.58, "Found 34 merged PRs across 5 repos", "done"],
  [0.64, "Main CI on 6 repos", "failed", "GitHub rate limit, will retry"],
  [0.7, "Linear not connected", "skipped"],
  [0.82, "Ranked 7 decisions", "done"],
  [0.95, "Wrote launch prompts", "done"],
];
const RUNNING: [number, string][] = [
  [0, "Checking your setup"],
  [0.16, "Reading work sessions"],
  [0.26, "Reading meetings and signals"],
  [0.34, "Reading DMs"],
  [0.42, "Checking fleet agents"],
  [0.5, "Checking GitHub PRs"],
  [0.58, "Checking main CI"],
  [0.7, "Writing your brief"],
  [0.82, "Writing launch prompts"],
];

function demoActivity(progress: number, start: number) {
  const at = (p: number) => new Date(start + p * 18_000).toISOString();
  const done = ACTIVITY.filter(([p]) => progress >= p).map(([p, label, state, detail]) => ({ at: at(p), label, state, ...(detail ? { detail } : {}) }));
  const run = [...RUNNING].reverse().find(([p]) => progress >= p);
  if (run && progress < 1) done.push({ at: at(run[0]), label: run[1], state: "running" as never });
  return done.slice(-12);
}

const STEPS: [number, string][] = [
  [0.05, "Checking your setup"],
  [0.15, "Reading your last brief"],
  [0.3, "Sweeping your day"],
  [0.5, "Sweeping your day · meetings and DMs"],
  [0.7, "Sweeping your day · PRs and CI"],
  [0.9, "Writing your brief"],
];

export function briefDemoFromUrl(search: string): BriefDemo | null {
  const params = new URLSearchParams(search);
  const mode = params.get("briefDemo");
  const at = params.get("briefDemoAt");
  if (!mode && at == null) return null;
  const fails = mode === "fail";
  const frozen = at == null ? null : at === "fail" ? "fail" : Math.min(1, Math.max(0, Number(at) || 0));
  let started = 0;
  let runId = "";
  const bot = { name: "demo", agentUid: "agt_demo", runtime: "claude", state: "running", processAlive: true } as LocalBotRow;
  const creator: BriefCreator = {
    company: () => "demo",
    check: async () => ({ ok: true, bot }),
    dispatch: async (_bot, _body, key) => {
      started = Date.now();
      runId = key;
      return null;
    },
    fix: async () => null,
    notify: (title) => console.info(`[daily-brief demo] ${title}`),
  };
  const source: BriefSweepSource = {
    async readHqFile(path) {
      if (!runId || !path.endsWith(`${runId}/status.json`)) return null;
      const s = (Date.now() - started) / 1000;
      if (s < 1.5) return null;
      const progress = Math.min(1, (s - 1.5) / 18);
      if (fails && progress > 0.45) {
        return JSON.stringify({ run_id: runId, state: "failed", step: "Sweeping your day", progress: 0.45, error: "The sweep could not reach GitHub. Sign in with gh auth login, then try again." });
      }
      if (progress >= 1) return JSON.stringify({ run_id: runId, state: "ready", step: "Done", progress: 1 });
      const step = [...STEPS].reverse().find(([p]) => progress >= p)?.[1] ?? "Starting";
      return JSON.stringify({ run_id: runId, state: "running", step, progress, updated_at: new Date().toISOString(), activity: demoActivity(progress, started) });
    },
  };
  return { creator, source, frozen };
}
