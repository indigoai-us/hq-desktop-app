import { execFile as execFileCb } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MARKS, readExtractionSection } from '../../scripts/idea-board-bench.mjs';

const execFile = promisify(execFileCb);
const BENCH = resolve(__dirname, '../../scripts/idea-board-bench.mjs');

/**
 * US-008: `bench-results.json` has two independent authors — the latency
 * bench (this script) and the model-path bench (the Rust test suite, which
 * writes `extraction`). Neither may erase the other's section.
 */
describe('idea-board bench: extraction section survives a latency run', () => {
  let dir: string;
  let out: string;
  let log: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hq-idea-board-us-008-'));
    out = join(dir, 'bench-results.json');
    log = join(dir, 'app.log');
    const t = Date.UTC(2026, 8, 10, 12, 0, 0);
    const stamp = (ms: number) => new Date(ms).toISOString();
    writeFileSync(
      log,
      [
        `${stamp(t)} [idea] ${MARKS.chord}`,
        `${stamp(t + 20)} [idea] ${MARKS.overlay}`,
        `${stamp(t + 900)} [idea] ${MARKS.release}`,
        `${stamp(t + 1000)} [idea] ${MARKS.png} path=/tmp/cap-0.png`,
        '',
      ].join('\n'),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('carries an existing extraction section across a rewrite', async () => {
    const extraction = {
      model: {
        live: false,
        fixtures: 26,
        per_capture_cost_usd_estimate: { mean: 0.0021 },
      },
    };
    writeFileSync(out, `${JSON.stringify({ generatedAt: 'old', extraction }, null, 2)}\n`);

    await execFile(process.execPath, [BENCH, '--from-log', log, '--out', out]);

    const written = JSON.parse(readFileSync(out, 'utf8'));
    expect(written.extraction).toEqual(extraction);
    // ...and the latency section really was rewritten, not just left alone.
    expect(written.generatedAt).not.toBe('old');
    expect(written.chordToOverlay.samples).toBe(1);
  });

  it('omits extraction entirely when there was no previous section', async () => {
    await execFile(process.execPath, [BENCH, '--from-log', log, '--out', out]);
    const written = JSON.parse(readFileSync(out, 'utf8'));
    expect('extraction' in written).toBe(false);
  });

  it('treats an unreadable or non-JSON results file as nothing to preserve', () => {
    expect(readExtractionSection(join(dir, 'does-not-exist.json'))).toBeUndefined();
    writeFileSync(out, 'not json at all');
    expect(readExtractionSection(out)).toBeUndefined();
    writeFileSync(out, '{"generatedAt":"x"}');
    expect(readExtractionSection(out)).toBeUndefined();
  });
});
