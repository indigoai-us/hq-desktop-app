#!/usr/bin/env node
// idea-board-bench.mjs — capture-latency benchmark for the HQ idea board.
//
// The project's blocking risk is losing to Cmd+Shift+4. This script measures
// the two intervals that decide that race, using timestamps the app itself
// writes through util::logfile (~/.hq/logs/hq-sync.log):
//
//   chord   -> overlay_visible   (budget: p95 <= 80ms)
//   release -> png_written       (budget: p95 <= 120ms)
//
// Log lines have the logfile shape `2026-04-25T13:45:09.123Z [tag] message`.
// The idea-board stories tag their marks as:
//
//   [idea] idea.capture.chord
//   [idea] idea.capture.overlay_visible
//   [idea] idea.capture.release
//   [idea] idea.capture.png_written path=...
//
// Modes:
//   --drive           (default on macOS) press the chord + drag a region N times,
//                     then read the app log. Drives the PINNED benchmark bundle
//                     (identifier ai.indigo.hq-idea-board-bench, built by
//                     `npm run bundle:bench`), never target/debug/hq-sync-menubar:
//                     macOS keys the Screen Recording grant on the bundle
//                     identifier, so the grant is a ONE-TIME action for that
//                     bundle and rebuilding it no longer voids the grant.
//                     Requires `cliclick` (brew install cliclick) for the drag.
//   --from-log <file> skip driving; score an existing log (CI / fixtures).
//
// Options:
//   --cycles N        capture cycles to drive (default 20)
//   --log <file>      app log to read (default ~/.hq/logs/hq-sync.log)
//   --out <file>      results JSON (default apps/sync/e2e/idea-board/bench-results.json)
//   --chord <keys>    chord for osascript, default "c" + option+shift (US-003)
//   --settle-ms N     wait between cycles (default 600)
//   --app <path>      override the benchmark .app bundle to drive
//   --no-launch       assume the bench app is already running
//
// Screen Recording: grant it ONCE to the bench .app (System Settings >
// Privacy & Security > Screen & System Audio Recording). Because the bundle
// identifier is pinned, that grant survives every rebuild. If it is missing,
// --drive fails loudly instead of reporting zero samples.
//
// Exit codes: 0 within budget, 1 over budget, 2 usage / no data.

import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export const BUDGET_MS = Object.freeze({
  chordToOverlay: 80,
  releaseToPng: 120,
});

export const MARKS = Object.freeze({
  chord: 'idea.capture.chord',
  overlay: 'idea.capture.overlay_visible',
  release: 'idea.capture.release',
  png: 'idea.capture.png_written',
});

const LINE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\s+\[([^\]]+)\]\s+(.*)$/;

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LOG = join(homedir(), '.hq', 'logs', 'hq-sync.log');
export const DEFAULT_OUT = resolve(here, '..', 'e2e', 'idea-board', 'bench-results.json');

/**
 * The pinned benchmark bundle. Its identifier is DELIBERATELY distinct from
 * the shipping app (ai.indigo.hq-sync-menubar) for two reasons:
 *   1. macOS TCC keys the Screen Recording grant on the bundle identifier, so
 *      a pinned identifier means the grant is given once and survives rebuilds.
 *   2. A distinct identifier means the bench app does not collide with the
 *      developer's own running HQ dev app on the single-instance socket.
 * Built by apps/sync/scripts/build-bench-bundle.sh (`npm run bundle:bench`).
 */
export const BENCH_BUNDLE_IDENTIFIER = 'ai.indigo.hq-idea-board-bench';
export const BENCH_PRODUCT_NAME = 'HQ Idea Board Bench';
export const DEFAULT_BENCH_APP = resolve(
  here,
  '..',
  'src-tauri',
  'target',
  'debug',
  'bundle',
  'macos',
  `${BENCH_PRODUCT_NAME}.app`,
);

/** Read the identifier macOS/TCC will key on out of a built bundle. */
export async function bundleIdentifier(appPath) {
  const { stdout, stderr } = await execFile('codesign', ['-dv', appPath]).catch((err) => ({
    stdout: '',
    stderr: String(err.stderr ?? err.message ?? ''),
  }));
  const m = /Identifier=(.+)/.exec(`${stdout}\n${stderr}`);
  return m ? m[1].trim() : null;
}

/**
 * Parse logfile lines into capture marks. Lines that are not idea-board marks
 * are ignored so a full production log can be fed in unchanged.
 * @param {string} text
 * @returns {{ mark: string, at: number, line: string }[]}
 */
export function parseMarks(text) {
  const marks = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    const msg = m[3];
    const mark = Object.values(MARKS).find(
      (name) => msg === name || msg.startsWith(`${name} `),
    );
    if (!mark) continue;
    const at = Date.parse(m[1]);
    if (Number.isNaN(at)) continue;
    marks.push({ mark, at, line: raw });
  }
  return marks;
}

/**
 * Pair marks into cycles in log order. A cycle is chord -> overlay -> release
 * -> png. Chords that never reach the overlay (Escape) yield a chordToOverlay
 * sample only when the overlay mark exists; a release with no png is dropped.
 * @param {{ mark: string, at: number }[]} marks
 * @returns {{ chordToOverlay: number[], releaseToPng: number[] }}
 */
export function pairCycles(marks) {
  const chordToOverlay = [];
  const releaseToPng = [];
  let chordAt = null;
  let releaseAt = null;
  for (const { mark, at } of marks) {
    switch (mark) {
      case MARKS.chord:
        chordAt = at;
        break;
      case MARKS.overlay:
        if (chordAt !== null) {
          chordToOverlay.push(at - chordAt);
          chordAt = null;
        }
        break;
      case MARKS.release:
        releaseAt = at;
        break;
      case MARKS.png:
        if (releaseAt !== null) {
          releaseToPng.push(at - releaseAt);
          releaseAt = null;
        }
        break;
      default:
        break;
    }
  }
  return { chordToOverlay, releaseToPng };
}

/**
 * Nearest-rank percentile (p in 0..100) over a non-empty sample.
 * @param {number[]} samples
 * @param {number} p
 */
export function percentile(samples, p) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/**
 * @param {number[]} samples
 * @param {number} budgetMs
 */
export function summarize(samples, budgetMs) {
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  return {
    samples: samples.length,
    p50,
    p95,
    min: samples.length ? Math.min(...samples) : null,
    max: samples.length ? Math.max(...samples) : null,
    budgetMs,
    withinBudget: p95 !== null && p95 <= budgetMs,
  };
}

/**
 * Score a log text. `pass` is false when either interval has no samples or
 * its p95 is over budget — an empty log must never read as green.
 * @param {string} logText
 * @param {{ budgets?: { chordToOverlay: number, releaseToPng: number } }} [opts]
 */
export function evaluate(logText, opts = {}) {
  const budgets = opts.budgets ?? BUDGET_MS;
  const marks = parseMarks(logText);
  const cycles = pairCycles(marks);
  const chordToOverlay = summarize(cycles.chordToOverlay, budgets.chordToOverlay);
  const releaseToPng = summarize(cycles.releaseToPng, budgets.releaseToPng);
  return {
    chordToOverlay,
    releaseToPng,
    pass: chordToOverlay.withinBudget && releaseToPng.withinBudget,
  };
}

export function formatReport(result) {
  const row = (name, s) =>
    `${name.padEnd(18)} n=${String(s.samples).padStart(3)}  p50=${fmt(s.p50)}  p95=${fmt(s.p95)}  budget(p95)<=${s.budgetMs}ms  ${s.withinBudget ? 'OK' : 'OVER'}`;
  return [
    'idea-board capture latency',
    row('chord->overlay', result.chordToOverlay),
    row('release->png', result.releaseToPng),
    `result: ${result.pass ? 'PASS' : 'FAIL'}`,
  ].join('\n');
}

function fmt(v) {
  return v === null ? '   n/a' : `${String(v).padStart(4)}ms`;
}

export function parseArgs(argv) {
  const args = {
    drive: process.platform === 'darwin',
    fromLog: null,
    cycles: 20,
    log: DEFAULT_LOG,
    out: DEFAULT_OUT,
    chord: 'c',
    settleMs: 600,
    app: DEFAULT_BENCH_APP,
    launch: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[i];
    };
    switch (a) {
      case '--drive':
        args.drive = true;
        break;
      case '--from-log':
        args.fromLog = next();
        args.drive = false;
        break;
      case '--cycles':
        args.cycles = Number.parseInt(next(), 10);
        break;
      case '--log':
        args.log = next();
        break;
      case '--out':
        args.out = next();
        break;
      case '--chord':
        args.chord = next();
        break;
      case '--settle-ms':
        args.settleMs = Number.parseInt(next(), 10);
        break;
      case '--app':
        args.app = next();
        break;
      case '--no-launch':
        args.launch = false;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!Number.isInteger(args.cycles) || args.cycles < 1) {
    throw new Error('--cycles must be a positive integer');
  }
  if (!/^[a-z0-9]$/i.test(args.chord)) {
    throw new Error('--chord must be a single letter or digit (it is typed with option+shift)');
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Drive one capture cycle on macOS: press the chord (US-003 default ⌥⇧C),
 * then drag a 240x160 region near screen centre with cliclick (US-004).
 */
async function driveCycleDarwin(chordKey) {
  await execFile('osascript', [
    '-e',
    `tell application "System Events" to keystroke "${chordKey}" using {option down, shift down}`,
  ]);
  await sleep(150);
  const { stdout } = await execFile('cliclick', ['p']);
  const [cx, cy] = stdout.trim().split(',').map((n) => Number.parseInt(n, 10));
  const x0 = Number.isFinite(cx) ? cx : 600;
  const y0 = Number.isFinite(cy) ? cy : 400;
  await execFile('cliclick', [`dd:${x0},${y0}`, `dm:${x0 + 120},${y0 + 80}`, `du:${x0 + 240},${y0 + 160}`]);
}

/**
 * Ensure the pinned benchmark bundle exists and is the app we drive. Returns
 * the identifier TCC keys the Screen Recording grant on.
 */
export async function ensureBenchBundle(appPath) {
  if (!existsSync(appPath)) {
    throw new Error(
      `benchmark bundle not found: ${appPath}\n` +
        '  Build it with:  npm run bundle:bench   (apps/sync)\n' +
        '  It pins the bundle identifier so the Screen Recording grant survives rebuilds.',
    );
  }
  const identifier = await bundleIdentifier(appPath);
  if (identifier !== BENCH_BUNDLE_IDENTIFIER) {
    throw new Error(
      `benchmark bundle has identifier ${identifier ?? '(unsigned)'}, expected ${BENCH_BUNDLE_IDENTIFIER}.\n` +
        '  The Screen Recording grant is keyed on the identifier — rebuild with npm run bundle:bench.',
    );
  }
  return identifier;
}

/**
 * Fail loudly when Screen Recording is denied. A denied grant makes capture
 * produce nothing and the bench would otherwise report zero samples as if the
 * instrumentation were missing.
 */
export function assertScreenRecordingGranted(granted, appPath) {
  if (granted) return;
  throw new Error(
    'Screen Recording permission is DENIED for the benchmark app — no frames can be captured,\n' +
      'so the bench would record zero samples. Grant it once:\n' +
      '  System Settings > Privacy & Security > Screen & System Audio Recording > +\n' +
      `  ${appPath}\n` +
      `Identifier: ${BENCH_BUNDLE_IDENTIFIER} (pinned — rebuilding does NOT void the grant).`,
  );
}

/** Ask macOS whether this process' screen-capture access is granted. */
async function screenRecordingGranted() {
  try {
    const { stdout } = await execFile('/usr/bin/swift', [
      '-e',
      'import CoreGraphics; print(CGPreflightScreenCaptureAccess())',
    ]);
    return stdout.trim() === 'true';
  } catch {
    // Cannot determine (no swift toolchain) — do not block the run.
    return true;
  }
}

async function drive(args) {
  if (process.platform !== 'darwin') {
    throw new Error('--drive is only implemented on macOS; use --from-log elsewhere');
  }
  try {
    await execFile('cliclick', ['-V']);
  } catch {
    throw new Error('cliclick is required to drive the drag (brew install cliclick)');
  }
  const appPath = args.app;
  await ensureBenchBundle(appPath);
  assertScreenRecordingGranted(await screenRecordingGranted(), appPath);
  if (args.launch) {
    // `open` the pinned bundle (never target/debug/hq-sync-menubar): launching
    // the bare binary gives macOS no bundle identity, so TCC cannot match the
    // grant and every capture comes back empty.
    await execFile('open', ['-a', appPath]);
    await sleep(3000);
  }
  const startedAt = Date.now();
  for (let i = 0; i < args.cycles; i += 1) {
    await driveCycleDarwin(args.chord);
    await sleep(args.settleMs);
  }
  return startedAt;
}

/**
 * Read the `extraction` section of an existing results file, if any. A
 * missing or unparseable file yields `undefined` — this is a best-effort
 * carry-over, never a reason to fail the latency bench.
 * @param {string} out
 * @returns {unknown}
 */
export function readExtractionSection(out) {
  try {
    const existing = JSON.parse(readFileSync(out, 'utf8'));
    if (existing && typeof existing === 'object' && 'extraction' in existing) {
      return existing.extraction;
    }
  } catch {
    // no previous results, or not JSON — nothing to preserve
  }
  return undefined;
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`idea-board-bench: ${err.message}`);
    return 2;
  }
  if (args.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 45).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }

  let logPath = args.fromLog ?? args.log;
  let startedAt = 0;
  let source = 'log-file';
  if (args.drive) {
    try {
      startedAt = await drive(args);
      source = 'live';
    } catch (err) {
      console.error(`idea-board-bench: ${err.message}`);
      return 2;
    }
  }

  let text;
  try {
    text = readFileSync(logPath, 'utf8');
  } catch (err) {
    console.error(`idea-board-bench: cannot read log ${logPath}: ${err.message}`);
    return 2;
  }
  // When driving, only score marks emitted during this run.
  if (startedAt) {
    text = parseMarks(text)
      .filter((m) => m.at >= startedAt)
      .map((m) => m.line)
      .join('\n');
  }

  const result = evaluate(text);
  const report = {
    generatedAt: new Date().toISOString(),
    source,
    logPath: logPath.startsWith(homedir()) ? `~${logPath.slice(homedir().length)}` : logPath,
    platform: process.platform,
    requestedCycles: args.drive ? args.cycles : null,
    budgets: BUDGET_MS,
    ...result,
  };
  // The latency bench owns only the latency keys. `extraction` is written by
  // a different measurement (US-008's model-path bench, from the Rust test
  // suite) into the same file, so carry it across rather than clobbering it.
  const carried = readExtractionSection(args.out);
  if (carried !== undefined) report.extraction = carried;
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);

  console.log(formatReport(result));
  console.log(`results: ${args.out}`);
  if (result.chordToOverlay.samples === 0 || result.releaseToPng.samples === 0) {
    console.error('idea-board-bench: no capture cycles found in log (is the app instrumented and running?)');
    return 2;
  }
  return result.pass ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
