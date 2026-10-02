/**
 * Console-rail runtime budget. Numbers come from the PRD performanceBudget.
 * The reference file is the branch-point recording, not the 2026-09-08
 * shared fixture (that file stays the 25% harness baseline).
 */

export const RAIL_REFERENCE = "scripts/fixtures/perf-baseline.console-rail.json";

export const ATLAS_CHUNK_MAX = 120 * 1024;
export const TELEMETRY_CHUNK_MAX = 80 * 1024;
export const INITIAL_JS_HEADROOM = 150 * 1024;

/** Stories that turn a skipped scenario into a real measurement. */
export const RAIL_SCENARIO_TODO = {
  companySwitch:
    "US-004 pinned company tiles and US-009 Atlas as the company landing",
  sidepaneSwitch: "US-006 sidepane host (Home, Company, Atlas)",
};

const START_TOLERANCE = 0.1;

function limitLine(pass, detail) {
  return { pass, detail };
}

/**
 * @param {Record<string, { median?: number, p95?: number }>} summaries
 * @param {Record<string, { median?: number, p95?: number }>} reference
 * @param {Record<string, unknown>} rail
 */
export function judgeRail(summaries, reference, rail) {
  const checks = [];

  const shell = summaries["coldLoad.shellReadyMs"];
  const shellRef = reference["coldLoad.shellReadyMs"]?.median;
  if (shell && Number.isFinite(shellRef)) {
    const limit = shellRef * (1 + START_TOLERANCE);
    checks.push({
      name: "coldStartShellReadyMs",
      ...limitLine(
        shell.median <= limit,
        `median ${shell.median.toFixed(1)} ms, limit ${limit.toFixed(1)} ms (reference ${shellRef.toFixed(1)} + 10%)`,
      ),
    });
  }

  const fcp = summaries["coldLoad.firstContentfulPaintMs"];
  const fcpRef = reference["coldLoad.firstContentfulPaintMs"]?.median;
  if (fcp && Number.isFinite(fcpRef)) {
    const limit = fcpRef * (1 + START_TOLERANCE);
    checks.push({
      name: "firstContentfulPaintMs",
      ...limitLine(
        fcp.median <= limit,
        `median ${fcp.median.toFixed(1)} ms, limit ${limit.toFixed(1)} ms (reference ${fcpRef.toFixed(1)} + 10%)`,
      ),
    });
  }

  const company = rail.companySwitch;
  if (company?.skipped) {
    checks.push({
      name: "companySwitchToCachedPaintMs",
      pass: true,
      skipped: true,
      detail: `skipped — TODO ${company.todo}`,
    });
  } else if (company?.summary) {
    checks.push({
      name: "companySwitchToCachedPaintMs",
      ...limitLine(
        company.summary.p95 <= 100,
        `p95 ${company.summary.p95.toFixed(1)} ms, limit 100 ms`,
      ),
    });
  }

  const side = rail.sidepaneSwitch;
  if (side?.skipped) {
    checks.push({
      name: "sidepaneSwitch",
      pass: true,
      skipped: true,
      detail: `skipped — TODO ${side.todo}`,
    });
  } else if (side?.summary) {
    checks.push({
      name: "sidepaneSwitch",
      ...limitLine(
        side.summary.p95 <= 100,
        `p95 ${side.summary.p95.toFixed(1)} ms, limit 100 ms (same paint budget as a company switch)`,
      ),
    });
  }

  const sw = summaries["interaction.switchConversation"];
  if (sw) {
    // Product target is 50 ms (September 2026 p95 was 49). A branch-point
    // recording on a busy machine can land higher because p95 of four samples
    // is the worst sample. The gate is the worse of the two so later stories
    // cannot slip past what US-001 actually measured, and a quieter re-record
    // tightens it back to 50.
    const recorded = reference["interaction.switchConversation"]?.p95;
    const limit = Math.max(50, Number.isFinite(recorded) ? recorded : 50);
    checks.push({
      name: "switchConversationMs",
      ...limitLine(
        sw.p95 <= limit,
        `p95 ${sw.p95.toFixed(1)} ms, product target 50 ms, gate ${limit.toFixed(1)} ms`,
      ),
    });
  }

  const palette = summaries["interaction.commandPalette"];
  if (palette) {
    const recorded = reference["interaction.commandPalette"]?.p95;
    const limit = Math.max(20, Number.isFinite(recorded) ? recorded : 20);
    checks.push({
      name: "commandPaletteMs",
      ...limitLine(
        palette.p95 <= limit,
        `p95 ${palette.p95.toFixed(1)} ms, product target 20 ms, gate ${limit.toFixed(1)} ms`,
      ),
    });
  }

  for (const key of ["scroll.messages", "scroll.sidebar"]) {
    const dropped = summaries[`${key}.droppedPct`];
    const worst = summaries[`${key}.worstMs`];
    if (!dropped && !worst) continue;
    const ok =
      (dropped ? dropped.median <= 1 : true) &&
      (worst ? worst.median <= 33 : true);
    checks.push({
      name: `scrollDroppedFramesPct.${key}`,
      ...limitLine(
        ok,
        `dropped median ${dropped ? dropped.median.toFixed(2) : "n/a"}% (limit 1%), worst median ${worst ? worst.median.toFixed(1) : "n/a"} ms (limit 33)`,
      ),
    });
  }

  const idle = summaries["idle.busyMs"];
  if (idle) {
    checks.push({
      name: "idleBusyMs",
      ...limitLine(idle.median <= 0, `median ${idle.median} ms, limit 0`),
    });
  }

  const js = summaries["bundle.jsBytes"];
  const jsRef = reference["bundle.jsBytes"]?.median;
  if (js && Number.isFinite(jsRef)) {
    const limit = jsRef + INITIAL_JS_HEADROOM;
    checks.push({
      name: "initialJsBytes",
      ...limitLine(
        js.median <= limit,
        `${js.median} bytes, limit ${limit} (reference ${jsRef} + 150 KB)`,
      ),
    });
  }

  const lazy = rail.lazyChunks;
  if (lazy) {
    checks.push({
      name: "lazyChunks.atlasAbsent",
      ...limitLine(
        lazy.atlasInInitialJs === false,
        lazy.atlasInInitialJs
          ? `Atlas modules in the initial graph: ${lazy.atlasInitial.join(", ")}`
          : "Atlas is absent from the initial JS graph",
      ),
    });
    checks.push({
      name: "lazyChunks.telemetryAbsent",
      ...limitLine(
        lazy.telemetryInInitialJs === false,
        lazy.telemetryInInitialJs
          ? `Telemetry modules in the initial graph: ${lazy.telemetryInitial.join(", ")}`
          : "Telemetry is absent from the initial JS graph",
      ),
    });
    checks.push({
      name: "lazyChunks.atlasBytes",
      ...limitLine(
        lazy.atlasBytes <= ATLAS_CHUNK_MAX,
        `${lazy.atlasBytes} bytes, limit ${ATLAS_CHUNK_MAX}`,
      ),
    });
    checks.push({
      name: "lazyChunks.telemetryBytes",
      ...limitLine(
        lazy.telemetryBytes <= TELEMETRY_CHUNK_MAX,
        `${lazy.telemetryBytes} bytes, limit ${TELEMETRY_CHUNK_MAX}`,
      ),
    });
  }

  return {
    pass: checks.every((c) => c.pass),
    checks,
  };
}

export function renderRailVerdict(judgement) {
  const lines = ["", "console rail budget"];
  for (const check of judgement.checks) {
    const mark = check.skipped ? "SKIP" : check.pass ? "PASS" : "FAIL";
    lines.push(`  ${mark}  ${check.name}: ${check.detail}`);
  }
  lines.push(judgement.pass ? "\nperf:rail PASS" : "\nperf:rail FAIL");
  return lines.join("\n");
}
