#!/usr/bin/env node
/**
 * `pnpm perf` — the local performance diagnostics harness.
 *
 * Measures what a user actually feels in the HQ desktop shell: how long it
 * takes to become usable, whether scrolling drops frames, how long the app
 * takes to respond to input, and how much work it does while nobody is
 * touching it. Prints a table, writes a timestamped JSON run under
 * `perf-results/` (gitignored), and compares against the committed baseline at
 * `scripts/fixtures/perf-baseline.json`.
 *
 * This is a LOCAL tool, deliberately not a CI gate: a shared GitHub runner is
 * a noisy, virtualised, GPU-less machine, and frame timings taken there would
 * be neither trustworthy nor actionable. See docs/performance-diagnostics.md.
 *
 * WHAT IT DRIVES. apps/sync's design harness (`?view=shell&persona=indigo`),
 * built for production by scripts/perf/harness.vite.config.mts. That entry
 * mounts the REAL shell — packages/ui's DesktopApp with its real CSS, stores
 * and effects — against mocked Tauri IPC and committed fixtures, so runs are
 * deterministic and need no network, no Cognito and no `hq` daemon.
 *
 * WHAT IT CANNOT SEE. The native macOS glass layer (NSGlassEffectView) sits
 * behind the real Tauri window and is a genuine part of the app's frame cost.
 * Chromium has no equivalent, so scroll numbers here are the WEBVIEW's
 * contribution only — a floor, not the whole truth. Reading the real window is
 * a documented follow-up in docs/performance-diagnostics.md.
 *
 * Usage:
 *   pnpm perf                       # 5 reps, compare against the baseline
 *   pnpm perf -- --reps 3           # faster, noisier
 *   pnpm perf -- --update-baseline  # rewrite scripts/fixtures/perf-baseline.json
 *   pnpm perf -- --skip-build       # reuse the last harness build
 *   pnpm perf -- --headed           # watch it drive
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FRAME_BUDGET_MS, INIT_SCRIPT, SHELL_READY_SELECTORS, frameStats, longTaskBusyMs } from "./perf/collectors.mjs";
import { HARNESS_ENTRY, HARNESS_OUT_DIR, buildHarness } from "./perf/harness-build.mjs";
import { machineContext } from "./perf/machine.mjs";
import { compareMetric, renderTable, summarise } from "./perf/stats.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = HARNESS_OUT_DIR;
const resultsDir = resolve(rootDir, "perf-results");
const baselinePath = resolve(rootDir, "scripts/fixtures/perf-baseline.json");

// ── args ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const REPS = Number(value("reps", 5));
const IDLE_SECS = Number(value("idle-secs", 30));
const HEADED = flag("headed");
const UPDATE_BASELINE = flag("update-baseline");
const SKIP_BUILD = flag("skip-build");

// ── playwright ─────────────────────────────────────────────────────────────
/**
 * Playwright lives in apps/work (the only package with browser E2E), not at the
 * workspace root, so resolve it from there rather than adding a root dependency
 * that would force everyone to re-install for a diagnostic they may never run.
 */
function loadChromium() {
  const require = createRequire(resolve(rootDir, "apps/work/package.json"));
  try {
    return require("@playwright/test").chromium;
  } catch (error) {
    throw new Error(
      "Could not load Playwright from apps/work. Run `pnpm install` and " +
        "`pnpm --dir apps/work exec playwright install chromium`.\n" +
        String(error),
    );
  }
}

// ── build + serve ──────────────────────────────────────────────────────────
async function buildHarnessOnce() {
  process.stdout.write("building the perf harness (production build)…\n");
  await buildHarness();
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

/**
 * A plain static server rather than `vite preview`: it adds no dev middleware,
 * no HMR client and no module rewriting, so the bytes the browser gets are the
 * bytes the app ships. Fewer moving parts also means fewer things to blame when
 * a number moves.
 */
function serve(dir) {
  return new Promise((resolveServer) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      let path = decodeURIComponent(url.pathname);
      if (path === "/" || path === "") path = HARNESS_ENTRY;
      const file = join(dir, path);
      if (!file.startsWith(dir)) {
        res.writeHead(403).end();
        return;
      }
      createReadStream(file)
        .on("error", () => res.writeHead(404).end("not found"))
        .on("open", () => {
          res.writeHead(200, {
            "content-type": MIME[extname(file)] ?? "application/octet-stream",
            "cache-control": "no-store",
          });
        })
        .pipe(res);
    });
    server.listen(0, "127.0.0.1", () =>
      resolveServer({
        server,
        origin: `http://127.0.0.1:${server.address().port}`,
      }),
    );
  });
}

/** Total bytes of JS the shell has to download, parse and compile. */
async function bundleBytes(dir) {
  let total = 0;
  async function walk(d) {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (full.endsWith(".js")) total += (await stat(full)).size;
    }
  }
  await walk(dir);
  return total;
}

// ── scenarios ──────────────────────────────────────────────────────────────
const SHELL_URL = `${HARNESS_ENTRY}?view=shell&persona=indigo&theme=dark`;

/** Wait for the shell to be observably usable, and return when it happened. */
async function waitForShell(page) {
  const selector = SHELL_READY_SELECTORS.join(", ");
  await page.waitForSelector(selector, { timeout: 30_000, state: "attached" });
  return page.evaluate(() => performance.now());
}

async function newPage(context) {
  const page = await context.newPage();
  await page.addInitScript(`(${INIT_SCRIPT})()`);
  return page;
}

/**
 * Cold load: a brand-new browser context (empty cache, empty storage) is
 * navigated to the shell. Reports the paint timings the browser itself
 * records, plus an observed "shell usable" time.
 */
async function measureColdLoad(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await newPage(context);
  await page.goto(`${BASE}${SHELL_URL}`, { waitUntil: "commit" });
  const shellReadyMs = await waitForShell(page);
  // Let LCP settle: it keeps updating until the first interaction or 
  // until the largest element stops changing.
  await page.waitForTimeout(500);
  const paint = await page.evaluate(() => window.__hqPerf.paint);
  await context.close();

  return {
    firstContentfulPaintMs: paint["first-contentful-paint"] ?? NaN,
    largestContentfulPaintMs: paint["largest-contentful-paint"] ?? NaN,
    shellReadyMs,
  };
}

/**
 * Scroll smoothness: drive a real wheel gesture over a scrollable surface while
 * sampling rAF deltas. This is the headline number — the original complaint was
 * choppy scrolling.
 *
 * Targets that are not present or not scrollable in the fixture data are
 * reported as skipped rather than as a zero: a fabricated number is worse than
 * a missing one.
 */
const SCROLL_TARGETS = [
  {
    key: "scroll.messages",
    label: "scroll · message list",
    selectors: [
      '[data-testid="conversation-thread"]',
      '[data-testid="message-list"]',
      ".dm-thread",
    ],
  },
  {
    key: "scroll.sidebar",
    label: "scroll · conversation rail",
    selectors: [
      '[data-testid="chat-conversation-list"]',
      '[data-testid="chat-sidebar"]',
      ".chat-sidebar",
    ],
  },
];

/**
 * Scrolling is measured in a deliberately COMPACT window.
 *
 * The harness fixtures hold a realistic but small conversation set, and at a
 * roomy 1280x800 nothing overflows -- there is literally nothing to scroll, and
 * the scenario would report a fabricated "0 dropped frames". Shrinking the
 * window forces the same real components into overflow, which is what we want
 * to measure: the per-frame cost of scrolling THESE components, not a
 * statement about how much content a user happens to have.
 */
const SCROLL_VIEWPORT = { width: 900, height: 520 };

async function measureScroll(page) {
  const out = {};

  for (const target of SCROLL_TARGETS) {
    const box = await page.evaluate((selectors) => {
      let best = null;
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const scrollable =
          el.scrollHeight - el.clientHeight > 40 ||
          [...el.querySelectorAll("*")].some(
            (c) => c.scrollHeight - c.clientHeight > 40,
          );
        const rect = el.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) continue;
        const hit = {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          scrollable,
          selector: sel,
        };
        // Keep looking: a wrapper can match before the element that actually
        // overflows further down the fallback list.
        if (scrollable) return hit;
        best = best ?? hit;
      }
      return best;
    }, target.selectors);

    if (!box) {
      out[target.key] = { skipped: "no matching element" };
      continue;
    }
    if (!box.scrollable) {
      out[target.key] = { skipped: `${box.selector} has no overflow` };
      continue;
    }

    await page.mouse.move(box.x, box.y);
    // Capture frames while the wheel gesture runs. The capture promise is
    // started first so no frame of the gesture is missed.
    const capture = page.evaluate((duration) => {
      return new Promise((res) => {
        const deltas = [];
        let last = performance.now();
        const stopAt = last + duration;
        const tick = (now) => {
          deltas.push(now - last);
          last = now;
          if (now < stopAt) requestAnimationFrame(tick);
          else res(deltas);
        };
        requestAnimationFrame(tick);
      });
    }, 1600);

    for (let i = 0; i < 24; i += 1) {
      await page.mouse.wheel(0, i % 12 < 6 ? 120 : -120);
      await page.waitForTimeout(50);
    }

    out[target.key] = frameStats(await capture);
  }

  return out;
}

/**
 * Interaction latency: dispatch the input, then wait for the NEXT painted
 * frame. That gap is what a user perceives as "did it respond?" — it includes
 * the event handler, the Svelte effect flush, style, layout and paint.
 */
async function timeToNextPaint(page, act) {
  const start = await page.evaluate(() => performance.now());
  await act();
  return page.evaluate(
    (t0) =>
      new Promise((res) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => res(performance.now() - t0)),
        ),
      ),
    start,
  );
}

async function measureInteractions(page) {
  const out = {};

  // Switch conversation: click the second row in the rail.
  const rows = await page.$$(
    '[data-testid="chat-sidebar"] button, .chat-sidebar button',
  );
  if (rows.length > 1) {
    out["interaction.switchConversation"] = await timeToNextPaint(page, () =>
      rows[Math.min(1, rows.length - 1)].click({ timeout: 5000 }).catch(() => {}),
    );
  } else {
    out["interaction.switchConversation"] = null;
  }

  // Command palette: the app-wide Cmd-K surface.
  out["interaction.commandPalette"] = await timeToNextPaint(page, () =>
    page.keyboard.press("Meta+k"),
  );
  await page.keyboard.press("Escape").catch(() => {});

  // Composer keystroke: per-character handler + render cost. This is the one
  // that used to feel sticky, because every keystroke re-ran presence effects.
  const composer = await page.$(
    '[data-testid="conversation-composer"] [contenteditable], [contenteditable="true"], textarea',
  );
  if (composer) {
    await composer.click({ timeout: 5000 }).catch(() => {});
    const perKey = [];
    for (const ch of "performance") {
      perKey.push(await timeToNextPaint(page, () => page.keyboard.type(ch)));
    }
    out["interaction.composerKeystroke"] =
      perKey.reduce((a, b) => a + b, 0) / perKey.length;
  } else {
    out["interaction.composerKeystroke"] = null;
  }

  return out;
}

/**
 * Idle cost: leave the app alone and see how much it still does. A healthy
 * build is near zero here; a returning polling/churn regression shows up as
 * main-thread busy time and a rising DOM-mutation count.
 */
async function measureIdle(page, seconds) {
  const before = await page.evaluate(() => ({
    now: performance.now(),
    batches: window.__hqPerf.mutationBatches,
  }));
  await page.waitForTimeout(seconds * 1000);
  const after = await page.evaluate((from) => ({
    now: performance.now(),
    batches: window.__hqPerf.mutationBatches,
    longTasks: window.__hqPerf.longTasks.filter((t) => t.start >= from),
  }), before.now);

  const elapsed = after.now - before.now;
  return {
    "idle.busyMs": longTaskBusyMs(after.longTasks),
    "idle.busyPct": (longTaskBusyMs(after.longTasks) / elapsed) * 100,
    "idle.renderBatches": after.batches - before.batches,
    "idle.renderBatchesPerMinute":
      ((after.batches - before.batches) / elapsed) * 60_000,
  };
}

// ── run ────────────────────────────────────────────────────────────────────
let BASE = "";

/** Metric registry: label, unit, and whether a bigger number is worse. */
const METRICS = [
  ["coldLoad.firstContentfulPaintMs", "cold load · first contentful paint", "ms"],
  ["coldLoad.largestContentfulPaintMs", "cold load · largest contentful paint", "ms"],
  ["coldLoad.shellReadyMs", "cold load · shell usable", "ms"],
  ["scroll.messages.avgMs", "scroll · messages · avg frame", "ms"],
  ["scroll.messages.worstMs", "scroll · messages · worst frame", "ms"],
  ["scroll.messages.droppedPct", "scroll · messages · dropped frames", "%"],
  ["scroll.sidebar.avgMs", "scroll · rail · avg frame", "ms"],
  ["scroll.sidebar.worstMs", "scroll · rail · worst frame", "ms"],
  ["scroll.sidebar.droppedPct", "scroll · rail · dropped frames", "%"],
  ["interaction.switchConversation", "interaction · switch conversation", "ms"],
  ["interaction.commandPalette", "interaction · command palette", "ms"],
  ["interaction.composerKeystroke", "interaction · composer keystroke", "ms"],
  ["idle.busyMs", "idle · main-thread busy", "ms"],
  ["idle.busyPct", "idle · main-thread busy", "%"],
  ["idle.renderBatchesPerMinute", "idle · render batches", "/min"],
  ["bundle.jsBytes", "bundle · total JS", "bytes"],
];

function flatten(obj, prefix = "", out = {}) {
  for (const [key, val] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (val && typeof val === "object" && !Array.isArray(val)) flatten(val, path, out);
    else out[path] = val;
  }
  return out;
}

async function main() {
  if (!SKIP_BUILD) await buildHarnessOnce();

  const jsBytes = await bundleBytes(buildDir);
  const { server, origin } = await serve(buildDir);
  BASE = origin;

  const chromium = loadChromium();
  const browser = await chromium.launch({ headless: !HEADED });

  const perRep = [];
  try {
    for (let rep = 0; rep < REPS; rep += 1) {
      process.stdout.write(
        `run ${rep + 1}/${REPS}${rep === 0 ? " (warm-up, discarded)" : ""}…\n`,
      );

      const coldLoad = await measureColdLoad(browser);

      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
      });
      const page = await newPage(context);
      await page.goto(`${BASE}${SHELL_URL}`);
      await waitForShell(page);
      await page.waitForTimeout(1000); // let the first data flush settle

      const interaction = await measureInteractions(page);
      // Idle is measured last so it is not polluted by the interactions above;
      // only the first (discarded) run pays the long wait twice.
      const idle = await measureIdle(page, rep === 0 ? 2 : IDLE_SECS);

      await context.close();

      // Scroll runs in its own compact window (see SCROLL_VIEWPORT).
      const scrollContext = await browser.newContext({
        viewport: SCROLL_VIEWPORT,
      });
      const scrollPage = await newPage(scrollContext);
      await scrollPage.goto(`${BASE}${SHELL_URL}`);
      await waitForShell(scrollPage);
      await scrollPage.waitForTimeout(2500);
      const scroll = await measureScroll(scrollPage);
      if (process.env.HQ_PERF_DEBUG) console.log(JSON.stringify(scroll));
      await scrollContext.close();

      // `scroll` keys are already fully qualified ("scroll.messages"), so they
      // are spread rather than nested — nesting would give scroll.scroll.*.
      perRep.push(flatten({ coldLoad, ...scroll, ...interaction, ...idle }));
    }
  } finally {
    await browser.close();
    server.close();
  }

  // Collect per-metric samples across reps.
  const summaries = {};
  const skipped = {};
  for (const [key] of METRICS) {
    if (key === "bundle.jsBytes") {
      summaries[key] = summarise([jsBytes], 0);
      continue;
    }
    const samples = perRep
      .map((r) => r[key])
      .filter((v) => typeof v === "number" && Number.isFinite(v));
    if (samples.length === 0) {
      const reason = perRep.map((r) => r[`${key.split(".").slice(0, 2).join(".")}.skipped`]).find(Boolean);
      skipped[key] = reason ?? "not measured";
      continue;
    }
    summaries[key] = summarise(samples, REPS > 1 ? 1 : 0);
  }

  const baseline = await readFile(baselinePath, "utf8")
    .then((t) => JSON.parse(t))
    .catch(() => null);

  // Idle metrics are only comparable across runs that idled for the SAME
  // length of time: a 3-second sample and a 30-second sample see different
  // amounts of debounced, timer-driven work, so comparing them reports a
  // regression that is really just a different measurement window.
  const idleComparable =
    !baseline || baseline.idleSeconds === IDLE_SECS;

  const rows = [];
  const regressions = [];
  for (const [key, label, unit] of METRICS) {
    if (!summaries[key]) continue;
    const base =
      key.startsWith("idle.") && !idleComparable
        ? undefined
        : baseline?.metrics?.[key];
    const comparison = compareMetric(summaries[key], base, {
      absoluteFloor: unit === "bytes" ? 1024 * 50 : unit === "%" ? 0.5 : 1,
    });
    rows.push({ label, unit, summary: summaries[key], baseline: base, comparison });
    if (comparison.verdict === "regressed") regressions.push({ key, label, comparison });
  }

  const run = {
    recordedAt: new Date().toISOString(),
    reps: REPS,
    idleSeconds: IDLE_SECS,
    frameBudgetMs: FRAME_BUDGET_MS,
    machine: machineContext({ chromium: browser.version?.() }),
    metrics: summaries,
    skipped,
    baselineRecordedAt: baseline?.recordedAt ?? null,
  };

  await mkdir(resultsDir, { recursive: true });
  const runPath = join(
    resultsDir,
    `run-${run.recordedAt.replace(/[:.]/g, "-")}.json`,
  );
  await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`);

  console.log(`\n${renderTable(rows)}\n`);
  if (!idleComparable) {
    console.log(
      `  idle metrics not compared: this run idled ${IDLE_SECS}s, the baseline ` +
        `idled ${baseline.idleSeconds}s.`,
    );
  }
  for (const [key, reason] of Object.entries(skipped)) {
    console.log(`  skipped ${key}: ${reason}`);
  }
  console.log(`\nrun written to ${runPath}`);
  console.log(
    `machine: ${run.machine.cpuModel} · ${run.machine.cpuCount} cores · ${run.machine.powerSource}`,
  );

  if (UPDATE_BASELINE) {
    await writeFile(
      baselinePath,
      `${JSON.stringify({ ...run, note: BASELINE_NOTE }, null, 2)}\n`,
    );
    console.log(`\nbaseline updated: ${baselinePath}`);
    return;
  }

  if (regressions.length > 0) {
    console.log("\nREGRESSIONS (median worse than baseline, outside the noise band):");
    for (const r of regressions) {
      console.log(
        `  ${r.label}: ${(r.comparison.deltaPct * 100).toFixed(1)}% worse ` +
          `(+${r.comparison.delta.toFixed(1)}, noise band ±${r.comparison.noiseBand.toFixed(1)})`,
      );
    }
    process.exitCode = 1;
  } else if (baseline) {
    console.log("\nno regressions outside the noise band.");
  } else {
    console.log(
      "\nno baseline yet — run `pnpm perf -- --update-baseline` to record one.",
    );
  }
}

const BASELINE_NOTE =
  "Regenerate with `pnpm perf -- --update-baseline`. These numbers are only " +
  "comparable on the machine and power state recorded in `machine` — see " +
  "docs/performance-diagnostics.md.";

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
