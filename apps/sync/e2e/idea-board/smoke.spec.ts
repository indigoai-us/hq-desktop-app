import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUDGET_MS,
  MARKS,
  evaluate,
  pairCycles,
  parseMarks,
  percentile,
} from '../../scripts/idea-board-bench.mjs';

const execFile = promisify(execFileCb);
const BENCH = resolve(__dirname, '../../scripts/idea-board-bench.mjs');

/** Build a logfile-shaped log with N capture cycles at fixed latencies. */
function syntheticLog(
  cycles: number,
  { chordToOverlay, releaseToPng }: { chordToOverlay: number; releaseToPng: number },
  noise = '',
): string {
  const lines: string[] = [];
  let t = Date.UTC(2026, 8, 10, 12, 0, 0);
  const stamp = (ms: number) => new Date(ms).toISOString();
  for (let i = 0; i < cycles; i += 1) {
    if (noise) lines.push(`${stamp(t)} [sync] ${noise}`);
    lines.push(`${stamp(t)} [idea] ${MARKS.chord}`);
    lines.push(`${stamp(t + chordToOverlay)} [idea] ${MARKS.overlay}`);
    lines.push(`${stamp(t + 900)} [idea] ${MARKS.release}`);
    lines.push(`${stamp(t + 900 + releaseToPng)} [idea] ${MARKS.png} path=/tmp/cap-${i}.png`);
    t += 2000;
  }
  return `${lines.join('\n')}\n`;
}

async function runBench(args: string[]) {
  try {
    const { stdout, stderr } = await execFile(process.execPath, [BENCH, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('idea-board bench: scoring', () => {
  it('parses logfile-shaped marks and ignores unrelated lines', () => {
    const marks = parseMarks(syntheticLog(2, { chordToOverlay: 40, releaseToPng: 90 }, 'start_sync invoked'));
    expect(marks).toHaveLength(8);
    expect(marks.map((m) => m.mark)).toEqual([
      MARKS.chord, MARKS.overlay, MARKS.release, MARKS.png,
      MARKS.chord, MARKS.overlay, MARKS.release, MARKS.png,
    ]);
  });

  it('pairs cycles into the two intervals and drops orphans', () => {
    const t0 = Date.UTC(2026, 8, 10);
    const marks = [
      { mark: MARKS.chord, at: t0 },
      { mark: MARKS.overlay, at: t0 + 30 },
      { mark: MARKS.release, at: t0 + 500 },
      { mark: MARKS.png, at: t0 + 600 },
      // Escape: chord with no overlay-> no sample; release with no png -> no sample
      { mark: MARKS.chord, at: t0 + 2000 },
      { mark: MARKS.release, at: t0 + 2500 },
    ];
    expect(pairCycles(marks)).toEqual({ chordToOverlay: [30], releaseToPng: [100] });
  });

  it('computes nearest-rank percentiles', () => {
    const s = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(s, 50)).toBe(50);
    expect(percentile(s, 95)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNull();
  });

  it('passes at the budget boundary and fails one millisecond over', () => {
    const atBudget = evaluate(syntheticLog(20, BUDGET_MS));
    expect(atBudget.chordToOverlay.p95).toBe(BUDGET_MS.chordToOverlay);
    expect(atBudget.releaseToPng.p95).toBe(BUDGET_MS.releaseToPng);
    expect(atBudget.pass).toBe(true);

    const overChord = evaluate(syntheticLog(20, { chordToOverlay: BUDGET_MS.chordToOverlay + 1, releaseToPng: 50 }));
    expect(overChord.pass).toBe(false);
    const overPng = evaluate(syntheticLog(20, { chordToOverlay: 20, releaseToPng: BUDGET_MS.releaseToPng + 1 }));
    expect(overPng.pass).toBe(false);
  });

  it('never reads an empty log as green', () => {
    const empty = evaluate('2026-09-10T12:00:00.000Z [sync] start_sync invoked\n');
    expect(empty.chordToOverlay.samples).toBe(0);
    expect(empty.pass).toBe(false);
  });
});

describe('idea-board bench: CLI end to end', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'idea-board-bench-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints p50/p95 for both intervals, writes bench-results.json and exits 0 within budget', async () => {
    const log = join(dir, 'hq-sync.log');
    const out = join(dir, 'bench-results.json');
    writeFileSync(log, syntheticLog(20, { chordToOverlay: 45, releaseToPng: 70 }));

    const run = await runBench(['--from-log', log, '--out', out]);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/chord->overlay\s+n= 20\s+p50=\s*45ms\s+p95=\s*45ms/);
    expect(run.stdout).toMatch(/release->png\s+n= 20\s+p50=\s*70ms\s+p95=\s*70ms/);
    expect(run.stdout).toContain('result: PASS');

    expect(existsSync(out)).toBe(true);
    const results = JSON.parse(readFileSync(out, 'utf8'));
    expect(results.source).toBe('log-file');
    expect(results.budgets).toEqual(BUDGET_MS);
    expect(results.chordToOverlay).toMatchObject({ samples: 20, p50: 45, p95: 45, withinBudget: true });
    expect(results.releaseToPng).toMatchObject({ samples: 20, p50: 70, p95: 70, withinBudget: true });
    expect(results.pass).toBe(true);
  });

  it('exits 1 when p95 chord->overlay exceeds 80ms', async () => {
    const log = join(dir, 'hq-sync.log');
    const out = join(dir, 'bench-results.json');
    // 18 fast cycles + 2 slow ones: nearest-rank p95 of 20 is the 19th sample,
    // so a single outlier is tolerated but two land the slow value on p95.
    const fast = syntheticLog(18, { chordToOverlay: 30, releaseToPng: 60 });
    const slow = syntheticLog(2, { chordToOverlay: 250, releaseToPng: 60 }).replace(/2026-09-10T12:00/g, '2026-09-10T13:00');
    writeFileSync(log, fast + slow);

    const run = await runBench(['--from-log', log, '--out', out]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('OVER');
    expect(run.stdout).toContain('result: FAIL');
    expect(JSON.parse(readFileSync(out, 'utf8')).pass).toBe(false);
  });

  it('exits 1 when p95 release->png exceeds 120ms', async () => {
    const log = join(dir, 'hq-sync.log');
    const out = join(dir, 'bench-results.json');
    writeFileSync(log, syntheticLog(20, { chordToOverlay: 30, releaseToPng: 121 }));

    const run = await runBench(['--from-log', log, '--out', out]);
    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/release->png.*OVER/);
  });

  it('exits 2 (not 0) when the log has no capture cycles', async () => {
    const log = join(dir, 'hq-sync.log');
    const out = join(dir, 'bench-results.json');
    writeFileSync(log, '2026-09-10T12:00:00.000Z [sync] start_sync invoked\n');

    const run = await runBench(['--from-log', log, '--out', out]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('no capture cycles');
  });

  it('exits 2 on bad usage', async () => {
    const run = await runBench(['--cycles', '0', '--from-log', join(dir, 'missing.log')]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('--cycles');
  });
});
