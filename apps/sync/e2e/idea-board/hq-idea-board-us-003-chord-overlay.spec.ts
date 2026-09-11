// hq-idea-board US-003: chord -> pre-rendered overlay latency and dismissal.
//
// The fixture (.txt so apps/sync/.gitignore `*.log` does not drop it) is a
// verbatim slice of ~/.hq/logs/hq-sync.log written by the
// debug app on macOS while `osascript` pressed ⌥⇧C then Escape 25 times, then
// ⌥⇧C twice in a row 3 times (chord-again-hides). It is real app output, not
// synthesized — regenerate it by re-driving the app, never by hand.
//
// To re-drive live: build apps/sync/src-tauri (cargo build --bin
// hq-sync-menubar), launch it, then run the same osascript loop and copy the
// [idea] lines since the "overlay setup: pre-rendered" line into the fixture.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUDGET_MS, MARKS, evaluate, pairCycles, parseMarks } from '../../scripts/idea-board-bench.mjs';

const FIXTURE = resolve(__dirname, 'fixtures/hq-idea-board-us-003-chord-overlay-live-macos.txt');
const text = readFileSync(FIXTURE, 'utf8');
const lines = text.split('\n').filter(Boolean);

describe('US-003 capture chord -> overlay (live macOS log)', () => {
  it('pre-renders the overlay hidden at app start, before any chord', () => {
    const setupIdx = lines.findIndex((l) => l.includes('overlay setup: pre-rendered hidden window'));
    const firstChordIdx = lines.findIndex((l) => l.includes(MARKS.chord));
    expect(setupIdx).toBeGreaterThanOrEqual(0);
    expect(firstChordIdx).toBeGreaterThan(setupIdx);
    expect(lines[setupIdx]).toMatch(/\[idea\] overlay setup: pre-rendered hidden window \d+x\d+ @ \(-?\d+, -?\d+\) scale=/);
  });

  it('holds p95 chord->overlay_visible within the 80ms budget on real marks', () => {
    const result = evaluate(text);
    expect(result.chordToOverlay.samples).toBeGreaterThanOrEqual(25);
    expect(result.chordToOverlay.p95).not.toBeNull();
    expect(result.chordToOverlay.p95!).toBeLessThanOrEqual(BUDGET_MS.chordToOverlay);
    // release->png is US-004; the combined bench verdict is not this story's.
    expect(result.releaseToPng.samples).toBe(0);
  });

  it('Escape hides the overlay and captures nothing', () => {
    const escapes = lines.filter((l) => l.includes('idea.capture.overlay_hidden reason=escape'));
    expect(escapes.length).toBe(25);
    // No capture-path marks were ever written: nothing was created.
    expect(lines.some((l) => l.includes(MARKS.release) || l.includes(MARKS.png))).toBe(false);
  });

  it('pressing the chord again while visible hides it', () => {
    const chordHides = lines.filter((l) => l.includes('idea.capture.overlay_hidden reason=chord'));
    expect(chordHides.length).toBe(3);
    // Every hide-toggle press is marked so log readers can tell it apart …
    const hideChords = lines.filter((l) => l.endsWith(`${MARKS.chord} action=hide`));
    expect(hideChords.length).toBe(3);
    // … and the bench still pairs every overlay_visible with its own show chord.
    const marks = parseMarks(text);
    const visibles = marks.filter((m) => m.mark === MARKS.overlay).length;
    expect(pairCycles(marks).chordToOverlay).toHaveLength(visibles);
  });

  it('every overlay_visible is preceded by a chord and followed by a hide', () => {
    const idea = lines.filter((l) => /idea\.capture\.(chord|overlay_visible|overlay_hidden)/.test(l));
    let state: 'hidden' | 'visible' = 'hidden';
    let lastWasChord = false;
    for (const l of idea) {
      if (l.includes(MARKS.overlay)) {
        expect(state).toBe('hidden');
        expect(lastWasChord).toBe(true);
        state = 'visible';
        lastWasChord = false;
      } else if (l.includes('overlay_hidden')) {
        expect(state).toBe('visible');
        state = 'hidden';
        lastWasChord = false;
      } else {
        lastWasChord = true;
      }
    }
    expect(state).toBe('hidden');
  });
});
