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
  /** What a run at this progress reports (for frozen frames). */
  statusAt(progress: number): { activity: unknown; findings: unknown; samples: unknown };
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

/**
 * Findings that grow as sources land, like a real run's status.json: a count
 * is only reported once its source has been read (so its tile waits until then).
 */
function demoFindings(p: number) {
  const k = (from: number, to: number, v: number) => (p < from ? undefined : Math.round(v * Math.max(0, Math.min(1, (p - from) / (to - from)))));
  return {
    signals: { decision: k(0.26, 0.4, 7), action_item: k(0.26, 0.4, 12), risk: k(0.3, 0.42, 3), commitment: k(0.3, 0.42, 5), key_point: k(0.3, 0.44, 19) },
    sessions: k(0.16, 0.26, 42),
    meetings: k(0.26, 0.34, 6),
    dms: { total: k(0.34, 0.42, 31), need_you: k(0.36, 0.42, 4) },
    prs: { merged: k(0.5, 0.58, 34), open: k(0.5, 0.58, 9), review_requested: k(0.52, 0.58, 2) },
    ci_red: k(0.6, 0.64, 1),
    agents: { total: k(0.42, 0.5, 44), attention: k(0.46, 0.5, 3) },
    integrations: p >= 0.68 ? { gmail: 5 } : {},
  };
}

const SAMPLES: [number, string, string, string][] = [
  [0.3, "decision", "Keep the no-self-merge rule on hq-core?", "indigo"],
  [0.33, "action_item", "Send Jacob the investor memo folder", "indigo"],
  [0.35, "commitment", "Stefan: ship the bot install flow behind the flag", "indigo"],
  // Another company's item: the app must never show it.
  [0.36, "decision", "LiveRecover: pick the dunning email copy", "liverecover"],
  [0.39, "risk", "Q4 pipeline thin after two churns", "indigo"],
  [0.42, "dm", "Izzy is waiting on your reply about X mentions", "indigo"],
  [0.56, "pr", "hq-desktop-app #1531 first-run screens merged", "indigo"],
  [0.63, "ci", "hq-desktop-app main is red on 1 of 3 workflows", "indigo"],
];

function demoSamples(p: number, start: number) {
  return SAMPLES.filter(([at]) => p >= at).map(([at, kind, title, company]) => ({
    kind,
    title,
    company,
    at: new Date(start + at * 18_000).toISOString(),
  }));
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
    company: () => "indigo",
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
      // Quiet for the first two polls, so the "Getting your brief started"
      // frame is on screen long enough to be seen and checked.
      if (s < 2.5) return null;
      const progress = Math.min(1, (s - 2.5) / 18);
      if (fails && progress > 0.45) {
        return JSON.stringify({ run_id: runId, state: "failed", step: "Sweeping your day", progress: 0.45, error: "The sweep could not reach GitHub. Sign in with gh auth login, then try again." });
      }
      if (progress >= 1) return JSON.stringify({ run_id: runId, state: "ready", step: "Done", progress: 1 });
      const step = [...STEPS].reverse().find(([p]) => progress >= p)?.[1] ?? "Starting";
      return JSON.stringify({ run_id: runId, state: "running", step, progress, updated_at: new Date().toISOString(), activity: demoActivity(progress, started), findings: demoFindings(progress), samples: demoSamples(progress, started), company: "indigo" });
    },
  };
  const statusAt = (p: number) => {
    const t0 = Date.now() - p * 18_000;
    return { activity: demoActivity(p, t0), findings: demoFindings(p), samples: demoSamples(p, t0) };
  };
  return { creator, source, frozen, statusAt };
}
