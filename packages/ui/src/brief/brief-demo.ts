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
    company: () => null,
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
      return JSON.stringify({ run_id: runId, state: "running", step, progress, updated_at: new Date().toISOString() });
    },
  };
  return { creator, source, frozen };
}
